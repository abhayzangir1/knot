import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type {
  CreateShortcutContextInput,
  InteractionContextScope,
  InteractionContextStore,
  ShortcutContext,
} from "../slack/interaction-context.js";
import { SHORTCUT_CONTEXT_TTL_MILLISECONDS } from "../slack/interaction-context.js";

type ContextRow = {
  reference: string;
  workspace_id: string;
  creator_principal_id: string;
  source_channel_id: string;
  source_message_ts: string;
  source_text: string;
  source_permalink: string;
  observed_at: Date | string;
  expires_at: Date | string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapContext(row: ContextRow): ShortcutContext {
  return {
    reference: row.reference,
    creator: {
      workspaceId: row.workspace_id,
      principalId: row.creator_principal_id,
    },
    source: {
      channelId: row.source_channel_id,
      messageTs: row.source_message_ts,
      text: row.source_text,
      permalink: row.source_permalink,
      observedAt: toIso(row.observed_at),
    },
    expiresAt: toIso(row.expires_at),
  };
}

/** Durable implementation for modal references so process restarts cannot lose a shortcut. */
export class PostgresInteractionContextStore implements InteractionContextStore {
  public constructor(private readonly pool: Pool) {}

  public async create(
    input: CreateShortcutContextInput,
    ttlMilliseconds = SHORTCUT_CONTEXT_TTL_MILLISECONDS,
  ): Promise<ShortcutContext> {
    const reference = input.reference ?? randomUUID();
    const expiresAt = new Date(Date.now() + ttlMilliseconds).toISOString();
    return this.inWorkspace(input.creator.workspaceId, async (client) => {
      await client.query(
        "delete from slack_interaction_contexts where workspace_id = $1 and expires_at <= now()",
        [input.creator.workspaceId],
      );
      const result = await client.query<ContextRow>(
        `insert into slack_interaction_contexts (
          reference, workspace_id, creator_principal_id, source_channel_id,
          source_message_ts, source_text, source_permalink, observed_at, expires_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        returning reference, workspace_id, creator_principal_id, source_channel_id,
          source_message_ts, source_text, source_permalink, observed_at, expires_at`,
        [
          reference,
          input.creator.workspaceId,
          input.creator.principalId,
          input.source.channelId,
          input.source.messageTs,
          "",
          input.source.permalink,
          input.source.observedAt,
          expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Knot could not persist the shortcut context.");
      }
      return mapContext(row);
    });
  }

  public async get(
    reference: string,
    scope: InteractionContextScope,
  ): Promise<ShortcutContext | undefined> {
    return this.inWorkspace(scope.workspaceId, async (client) => {
      const result = await client.query<ContextRow>(
        `select reference, workspace_id, creator_principal_id, source_channel_id,
          source_message_ts, source_text, source_permalink, observed_at, expires_at
         from slack_interaction_contexts
         where reference = $1 and workspace_id = $2 and creator_principal_id = $3
           and consumed_at is null and expires_at > now()`,
        [reference, scope.workspaceId, scope.principalId],
      );
      const row = result.rows[0];
      return row ? mapContext(row) : undefined;
    });
  }

  public async consume(
    reference: string,
    scope: InteractionContextScope,
  ): Promise<ShortcutContext | undefined> {
    return this.inWorkspace(scope.workspaceId, async (client) => {
      const result = await client.query<ContextRow>(
        `delete from slack_interaction_contexts
          where reference = $1 and workspace_id = $2 and creator_principal_id = $3
            and consumed_at is null and expires_at > now()
          returning reference, workspace_id, creator_principal_id, source_channel_id,
            source_message_ts, source_text, source_permalink, observed_at, expires_at`,
        [reference, scope.workspaceId, scope.principalId],
      );
      const row = result.rows[0];
      return row ? mapContext(row) : undefined;
    });
  }

  public async delete(reference: string, workspaceId?: string): Promise<void> {
    if (!workspaceId) {
      throw new Error("A workspace scope is required to delete an interaction context.");
    }
    await this.inWorkspace(workspaceId, async (client) => {
      await client.query(
        "delete from slack_interaction_contexts where reference = $1 and workspace_id = $2",
        [reference, workspaceId],
      );
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
}
