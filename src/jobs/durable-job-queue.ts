import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { KnotLogger } from "../observability/logger.js";
import { hashExternalState } from "../outcomes/index.js";

export type JsonObject = Record<string, unknown>;

export type DurableJob<TPayload extends JsonObject = JsonObject> = {
  id: string;
  workspaceId: string;
  dedupeKey: string;
  type: string;
  payload: TPayload;
  attempts: number;
  /** Durable ingress time used to reconstruct a stable actor context on retries. */
  createdAt: string;
};

export type EnqueueDurableJobInput<TPayload extends JsonObject> = {
  id?: string;
  workspaceId: string;
  dedupeKey: string;
  type: string;
  payload: TPayload;
  availableAt?: string;
};

export type EnqueueSlackDurableJobInput<TPayload extends JsonObject> = Omit<
  EnqueueDurableJobInput<TPayload>,
  "workspaceId"
> & {
  slackTeamId: string;
};

export type EnqueueDurableJobResult = {
  id: string;
  inserted: boolean;
};

export interface DurableJobQueue<TPayload extends JsonObject = JsonObject> {
  enqueue(input: EnqueueDurableJobInput<TPayload>): Promise<EnqueueDurableJobResult>;
  enqueueForSlackWorkspace(
    input: EnqueueSlackDurableJobInput<TPayload>,
  ): Promise<EnqueueDurableJobResult>;
  start(processor: (job: DurableJob<TPayload>) => Promise<void>): void;
  wake(): void;
  runOneAvailable(): Promise<boolean>;
  drain(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<void>;
}

export class PermanentJobError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export const DEFAULT_DURABLE_JOB_MAX_ATTEMPTS = 8;

type JobRow = {
  id: string;
  workspace_id: string;
  dedupe_key: string;
  type: string;
  payload: JsonObject;
  attempts: number;
  created_at: Date | string;
};

type QueueOptions = {
  pollIntervalMilliseconds?: number;
  staleLockMilliseconds?: number;
  maxAttempts?: number;
  maxJobsPerPump?: number;
  workerId?: string;
  automaticPolling?: boolean;
};

function jobFailureCode(error: unknown): string {
  if (error instanceof PermanentJobError) {
    return error.code.slice(0, 120);
  }
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[a-z0-9_.-]{1,120}$/iu.test(code)) {
      return code;
    }
  }
  return error instanceof Error ? error.name.slice(0, 120) : "unknown_error";
}

function nextDelayMilliseconds(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * PostgreSQL-backed, tenant-scoped work queue for acknowledged Slack commands.
 *
 * A job is durably inserted before acknowledgement. Workers claim one tenant at
 * a time under that tenant's RLS setting, use SKIP LOCKED for multi-instance
 * safety, reclaim stale leases after a crash, and redact completed payloads.
 */
export class PostgresDurableJobQueue<TPayload extends JsonObject = JsonObject>
  implements DurableJobQueue<TPayload>
{
  private readonly workerId: string;
  private readonly pollIntervalMilliseconds: number;
  private readonly staleLockMilliseconds: number;
  private readonly maxAttempts: number;
  private readonly maxJobsPerPump: number;
  private readonly automaticPolling: boolean;
  private processor: ((job: DurableJob<TPayload>) => Promise<void>) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private pumping = false;
  private stopping = false;
  private readonly active = new Set<Promise<void>>();

  public constructor(
    private readonly pool: Pool,
    private readonly logger: KnotLogger,
    options: QueueOptions = {},
  ) {
    this.workerId = options.workerId ?? randomUUID();
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 500;
    this.staleLockMilliseconds = options.staleLockMilliseconds ?? 5 * 60 * 1000;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_DURABLE_JOB_MAX_ATTEMPTS;
    this.maxJobsPerPump = options.maxJobsPerPump ?? 20;
    this.automaticPolling = options.automaticPolling ?? true;
  }

  public async enqueue(input: EnqueueDurableJobInput<TPayload>): Promise<EnqueueDurableJobResult> {
    if (this.stopping) {
      throw new Error("The durable worker is stopping and cannot accept new Slack work.");
    }
    return this.inWorkspace(input.workspaceId, async (client) => {
      return this.enqueueWithClient(client, input);
    });
  }

  /**
   * Records the minimal Slack command receipt in one bounded transaction.
   * Principal creation and authorization are deliberately deferred to the
   * worker so no identity-mapping query is added to Slack's acknowledgement
   * path.
   */
  public async enqueueForSlackWorkspace(
    input: EnqueueSlackDurableJobInput<TPayload>,
  ): Promise<EnqueueDurableJobResult> {
    if (this.stopping) {
      throw new Error("The durable worker is stopping and cannot accept new Slack work.");
    }
    if (!/^T[A-Z0-9]{2,79}$/u.test(input.slackTeamId)) {
      throw new Error("The verified Slack workspace ID is outside the accepted boundary.");
    }

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspace = await client.query<{ id: string }>(
        `insert into workspaces (slack_team_id, created_at, updated_at)
         values ($1, now(), now())
         on conflict (slack_team_id) do update set updated_at = workspaces.updated_at
         returning id`,
        [input.slackTeamId],
      );
      const workspaceId = workspace.rows[0]?.id;
      if (!workspaceId) {
        throw new Error("Knot could not bind the durable receipt to its Slack workspace.");
      }
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const result = await this.enqueueWithClient(client, { ...input, workspaceId });
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public start(processor: (job: DurableJob<TPayload>) => Promise<void>): void {
    if (this.processor) {
      throw new Error("The durable Slack worker has already been started.");
    }
    this.processor = processor;
    this.stopping = false;
    if (this.automaticPolling) {
      this.wake();
    }
  }

  public wake(): void {
    if (!this.automaticPolling || this.stopping || !this.processor || this.timer || this.pumping) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, 0);
  }

  public async runOneAvailable(): Promise<boolean> {
    if (!this.processor) {
      throw new Error("Start the durable Slack worker before running jobs.");
    }
    const workspaceIds = await this.workspaceIds();
    for (const workspaceId of workspaceIds) {
      const job = await this.claim(workspaceId);
      if (!job) {
        continue;
      }
      await this.process(job);
      return true;
    }
    return false;
  }

  public async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.drain();
  }

  public async healthCheck(): Promise<void> {
    await this.pool.query("select 1");
    if (this.stopping || !this.processor) {
      throw new Error("The durable Slack worker is not running.");
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopping || !this.processor) {
      return;
    }
    this.pumping = true;
    try {
      for (let processed = 0; processed < this.maxJobsPerPump; processed += 1) {
        if (!(await this.runOneAvailable())) {
          break;
        }
      }
    } catch (error) {
      this.logger.error({ err: error }, "Durable Slack worker pump failed");
    } finally {
      this.pumping = false;
      if (!this.stopping) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.pump();
        }, this.pollIntervalMilliseconds);
      }
    }
  }

  private async process(job: DurableJob<TPayload>): Promise<void> {
    const task = (async () => {
      try {
        await this.processor?.(job);
        await this.complete(job);
      } catch (error) {
        const permanent = error instanceof PermanentJobError || job.attempts >= this.maxAttempts;
        await this.fail(job, jobFailureCode(error), permanent);
        this.logger[permanent ? "error" : "warn"](
          { err: error, jobId: job.id, jobType: job.type, attempts: job.attempts },
          permanent
            ? "Durable Slack job reached a terminal failure"
            : "Durable Slack job will be retried",
        );
      }
    })();
    this.active.add(task);
    try {
      await task;
    } finally {
      this.active.delete(task);
    }
  }

  private async workspaceIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "select id from workspaces order by created_at, id",
    );
    return result.rows.map((row) => row.id);
  }

  private async claim(workspaceId: string): Promise<DurableJob<TPayload> | undefined> {
    return this.inWorkspace(workspaceId, async (client) => {
      const result = await client.query<JobRow>(
        `with candidate as (
          select id
          from outbox_jobs
          where workspace_id = $1
            and (
              (state = 'pending' and available_at <= now())
              or (state = 'processing' and locked_at < now() - ($2::int * interval '1 millisecond'))
            )
          order by available_at, created_at, id
          for update skip locked
          limit 1
        )
        update outbox_jobs as job
        set state = 'processing',
            attempts = job.attempts + 1,
            locked_at = now(),
            locked_by = $3,
            updated_at = now()
        from candidate
        where job.id = candidate.id and job.workspace_id = $1
        returning job.id, job.workspace_id, job.dedupe_key, job.type, job.payload, job.attempts,
          job.created_at`,
        [workspaceId, this.staleLockMilliseconds, this.workerId],
      );
      const row = result.rows[0];
      return row
        ? {
            id: row.id,
            workspaceId: row.workspace_id,
            dedupeKey: row.dedupe_key,
            type: row.type,
            payload: row.payload as TPayload,
            attempts: row.attempts,
            createdAt:
              row.created_at instanceof Date
                ? row.created_at.toISOString()
                : new Date(row.created_at).toISOString(),
          }
        : undefined;
    });
  }

  private async complete(job: DurableJob<TPayload>): Promise<void> {
    await this.inWorkspace(job.workspaceId, async (client) => {
      const result = await client.query(
        `update outbox_jobs
         set state = 'completed', payload = '{"redacted":true}'::jsonb,
             locked_at = null, locked_by = null, completed_at = now(),
             last_error = null, updated_at = now()
         where id = $1 and workspace_id = $2 and state = 'processing' and locked_by = $3`,
        [job.id, job.workspaceId, this.workerId],
      );
      if (result.rowCount !== 1) {
        throw new Error("Knot lost the lease while completing a durable Slack job.");
      }
    });
  }

  private async fail(job: DurableJob<TPayload>, code: string, permanent: boolean): Promise<void> {
    const availableAt = new Date(Date.now() + nextDelayMilliseconds(job.attempts)).toISOString();
    await this.inWorkspace(job.workspaceId, async (client) => {
      const result = await client.query(
        `update outbox_jobs
         set state = $4,
             available_at = case when $4 = 'pending' then $5::timestamptz else available_at end,
             payload = case when $4 = 'failed' then '{"redacted":true}'::jsonb else payload end,
             locked_at = null, locked_by = null, last_error = $6, updated_at = now()
         where id = $1 and workspace_id = $2 and state = 'processing' and locked_by = $3`,
        [
          job.id,
          job.workspaceId,
          this.workerId,
          permanent ? "failed" : "pending",
          availableAt,
          code,
        ],
      );
      if (result.rowCount !== 1) {
        throw new Error("Knot lost the lease while recording a durable Slack job failure.");
      }
    });
  }

  private async inWorkspace<T>(
    workspaceId: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const result = await work(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async enqueueWithClient(
    client: PoolClient,
    input: EnqueueDurableJobInput<TPayload>,
  ): Promise<EnqueueDurableJobResult> {
    const id = input.id ?? randomUUID();
    const inputPayloadHash = hashExternalState(input.payload);
    const inserted = await client.query<{ id: string }>(
      `insert into outbox_jobs (
        id, workspace_id, dedupe_key, type, payload, payload_hash, state, attempts,
        available_at, created_at, updated_at
      ) values ($1, $2, $3, $4, $5::jsonb, $6, 'pending', 0, coalesce($7::timestamptz, now()), now(), now())
      on conflict (workspace_id, dedupe_key) do nothing
      returning id`,
      [
        id,
        input.workspaceId,
        input.dedupeKey,
        input.type,
        JSON.stringify(input.payload),
        inputPayloadHash,
        input.availableAt ?? null,
      ],
    );
    const insertedId = inserted.rows[0]?.id;
    if (insertedId) {
      if (this.automaticPolling) {
        this.wake();
      }
      return { id: insertedId, inserted: true };
    }

    const existing = await client.query<{ id: string; type: string; payload_hash: string }>(
      `select id, type, payload_hash
       from outbox_jobs
       where workspace_id = $1 and dedupe_key = $2`,
      [input.workspaceId, input.dedupeKey],
    );
    const row = existing.rows[0];
    if (!row) {
      throw new Error("Knot could not load the existing durable Slack job.");
    }
    if (row.type !== input.type || row.payload_hash !== inputPayloadHash) {
      throw new Error(
        "A durable Slack dedupe key was reused for different command content; Knot refused the collision.",
      );
    }
    return { id: row.id, inserted: false };
  }
}
