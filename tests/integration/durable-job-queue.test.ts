import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "../../src/db/client.js";
import { PostgresActorIdentityResolver } from "../../src/identity/resolver.js";
import { PermanentJobError, PostgresDurableJobQueue } from "../../src/jobs/durable-job-queue.js";
import { createLogger } from "../../src/observability/logger.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const at = "2026-07-13T12:00:00.000Z";

type StoredJob = {
  state: string;
  attempts: number;
  payload: Record<string, unknown>;
  payload_hash: string;
  last_error: string | null;
};

async function inWorkspace<T>(
  pool: Pool,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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

async function readJob(pool: Pool, workspaceId: string, id: string): Promise<StoredJob> {
  return inWorkspace(pool, workspaceId, async (client) => {
    const result = await client.query<StoredJob>(
      `select state, attempts, payload, payload_hash, last_error
         from outbox_jobs
        where workspace_id = $1 and id = $2`,
      [workspaceId, id],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("The test durable job was not found.");
    }
    return row;
  });
}

async function runUntilJob(
  queue: PostgresDurableJobQueue,
  pool: Pool,
  workspaceId: string,
  id: string,
  ready: (job: StoredJob) => boolean,
): Promise<StoredJob> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await readJob(pool, workspaceId, id);
    if (ready(current)) {
      return current;
    }
    if (!(await queue.runOneAvailable())) {
      break;
    }
  }
  return readJob(pool, workspaceId, id);
}

describeDatabase("PostgreSQL durable Slack job queue", () => {
  let database: DatabaseHandle | undefined;

  afterAll(async () => {
    await database?.close();
  });

  it("retries safely, recovers stale leases, rejects collisions, redacts payloads, and enforces RLS", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL integration suite.");
    }
    database ??= createDatabase(databaseUrl);
    const identities = new PostgresActorIdentityResolver(database.pool);
    const suffix = randomUUID();
    const actor = await identities.resolve({
      slackTeamId: `Tqueue${suffix}`,
      slackUserId: `Uqueue${suffix}`,
      correlationId: `queue:${suffix}`,
      authenticatedAt: at,
    });
    const logger = createLogger({ LOG_LEVEL: "fatal", NODE_ENV: "test" });
    const processed: string[] = [];
    const queue = new PostgresDurableJobQueue(database.pool, logger, {
      automaticPolling: false,
      staleLockMilliseconds: 10,
      maxAttempts: 3,
      workerId: `worker:${suffix}`,
    });
    queue.start(async (job) => {
      if (job.payload.mode === "transient" && job.attempts === 1) {
        const error = new Error("sensitive source content must never reach last_error") as Error & {
          code: string;
        };
        error.code = "temporary_provider_failure";
        throw error;
      }
      if (job.payload.mode === "permanent") {
        throw new PermanentJobError("invalid_durable_command", "sensitive invalid payload");
      }
      processed.push(job.dedupeKey);
    });

    const receiptTeamId = `T${suffix.replaceAll("-", "").toUpperCase()}`;
    const receiptInput = {
      slackTeamId: receiptTeamId,
      dedupeKey: `receipt:${suffix}`,
      type: "owner_accept",
      payload: { mode: "receipt-only", outcomeId: suffix },
      availableAt: "2999-01-01T00:00:00.000Z",
    };
    const receipt = await queue.enqueueForSlackWorkspace(receiptInput);
    expect(receipt.inserted).toBe(true);
    await expect(queue.enqueueForSlackWorkspace(receiptInput)).resolves.toEqual({
      id: receipt.id,
      inserted: false,
    });
    await expect(
      queue.enqueueForSlackWorkspace({
        ...receiptInput,
        payload: { mode: "dedupe-collision", outcomeId: suffix },
      }),
    ).rejects.toThrow("refused the collision");
    await expect(
      queue.enqueueForSlackWorkspace({ ...receiptInput, slackTeamId: "not-a-slack-team" }),
    ).rejects.toThrow("outside the accepted boundary");

    const receiptWorkspace = await database.pool.query<{ id: string }>(
      "select id from workspaces where slack_team_id = $1",
      [receiptTeamId],
    );
    const receiptWorkspaceId = receiptWorkspace.rows[0]?.id;
    expect(receiptWorkspaceId).toBeTruthy();
    const principalsBeforeWorker = await database.pool.query<{ count: string }>(
      "select count(*) from principals where workspace_id = $1",
      [receiptWorkspaceId],
    );
    expect(Number(principalsBeforeWorker.rows[0]?.count ?? "-1")).toBe(0);
    expect(await readJob(database.pool, receiptWorkspaceId ?? "", receipt.id)).toMatchObject({
      state: "pending",
      attempts: 0,
      payload: receiptInput.payload,
    });

    const retryInput = {
      workspaceId: actor.workspaceId,
      dedupeKey: `retry:${suffix}`,
      type: "owner_accept",
      payload: { mode: "transient", outcomeId: suffix },
    };
    const retry = await queue.enqueue(retryInput);
    expect(retry.inserted).toBe(true);
    await expect(queue.enqueue(retryInput)).resolves.toEqual({ id: retry.id, inserted: false });
    await expect(
      queue.enqueue({ ...retryInput, payload: { mode: "collision", outcomeId: suffix } }),
    ).rejects.toThrow("refused the collision");

    expect(
      await runUntilJob(
        queue,
        database.pool,
        actor.workspaceId,
        retry.id,
        (job) => job.attempts === 1,
      ),
    ).toMatchObject({
      state: "pending",
      attempts: 1,
      last_error: "temporary_provider_failure",
    });
    await inWorkspace(database.pool, actor.workspaceId, async (client) => {
      await client.query(
        "update outbox_jobs set available_at = now() where workspace_id = $1 and id = $2",
        [actor.workspaceId, retry.id],
      );
    });
    const completed = await runUntilJob(
      queue,
      database.pool,
      actor.workspaceId,
      retry.id,
      (job) => job.state === "completed",
    );
    expect(completed).toMatchObject({
      state: "completed",
      attempts: 2,
      payload: { redacted: true },
      last_error: null,
    });
    expect(completed.payload_hash).toMatch(/^[a-f0-9]{64}$/u);
    await expect(queue.enqueue(retryInput)).resolves.toEqual({ id: retry.id, inserted: false });

    const stale = await queue.enqueue({
      workspaceId: actor.workspaceId,
      dedupeKey: `stale:${suffix}`,
      type: "owner_decline",
      payload: { mode: "stale" },
    });
    await inWorkspace(database.pool, actor.workspaceId, async (client) => {
      await client.query(
        `update outbox_jobs
            set state = 'processing', locked_at = now() - interval '1 minute', locked_by = 'dead-worker'
          where workspace_id = $1 and id = $2`,
        [actor.workspaceId, stale.id],
      );
    });
    expect(
      await runUntilJob(
        queue,
        database.pool,
        actor.workspaceId,
        stale.id,
        (job) => job.state === "completed",
      ),
    ).toMatchObject({
      state: "completed",
      attempts: 1,
      payload: { redacted: true },
    });

    const permanent = await queue.enqueue({
      workspaceId: actor.workspaceId,
      dedupeKey: `permanent:${suffix}`,
      type: "closure_confirm",
      payload: { mode: "permanent", privateText: "must be redacted after deletion policy" },
    });
    expect(
      await runUntilJob(
        queue,
        database.pool,
        actor.workspaceId,
        permanent.id,
        (job) => job.state === "failed",
      ),
    ).toMatchObject({
      state: "failed",
      attempts: 1,
      payload: { redacted: true },
      last_error: "invalid_durable_command",
    });

    expect(processed).toEqual(expect.arrayContaining([`retry:${suffix}`, `stale:${suffix}`]));

    const rls = await database.pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>("select relrowsecurity, relforcerowsecurity from pg_class where relname = 'outbox_jobs'");
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await database.pool.query(
      "do $$ begin create role knot_rls_test nologin; exception when duplicate_object then null; end $$;",
    );
    await database.pool.query("grant usage on schema public to knot_rls_test");
    await database.pool.query("grant select on outbox_jobs to knot_rls_test");
    const rlsClient = await database.pool.connect();
    try {
      await rlsClient.query("begin");
      await rlsClient.query("set local role knot_rls_test");
      const unscoped = await rlsClient.query<{ count: string }>(
        "select count(*) from outbox_jobs where id = $1",
        [retry.id],
      );
      await rlsClient.query("commit");
      expect(Number(unscoped.rows[0]?.count ?? "0")).toBe(0);
    } finally {
      await rlsClient.query("rollback").catch(() => undefined);
      rlsClient.release();
    }

    await queue.stop();
  });
});
