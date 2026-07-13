import type { Pool, PoolClient } from "pg";

import type { ActorContext } from "../outcomes/index.js";

export type VerifiedSlackIdentity = {
  slackTeamId: string;
  slackUserId: string;
  correlationId: string;
  authenticatedAt: string;
};

/**
 * Converts a verified Slack transport identity into an application principal.
 * Slack payload values are inputs to identity mapping, never application IDs
 * or authorization grants by themselves.
 */
export interface ActorIdentityResolver {
  resolve(identity: VerifiedSlackIdentity): Promise<ActorContext>;
  resolvePrincipalId(slackTeamId: string, slackUserId: string): Promise<string>;
  slackUserIdForPrincipal(workspaceId: string, principalId: string): Promise<string>;
}

type WorkspaceRow = { id: string };
type PrincipalRow = { id: string; is_admin: boolean };

export class PostgresActorIdentityResolver implements ActorIdentityResolver {
  public constructor(private readonly pool: Pool) {}

  public async resolve(identity: VerifiedSlackIdentity): Promise<ActorContext> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.ensureWorkspace(client, identity.slackTeamId);
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const principal = await this.ensurePrincipal(client, workspaceId, identity.slackUserId);
      await client.query("commit");
      return {
        workspaceId,
        principalId: principal.id,
        slackUserId: identity.slackUserId,
        correlationId: identity.correlationId,
        authenticatedAt: identity.authenticatedAt,
        isWorkspaceAdmin: principal.is_admin,
        resolvedAudienceSubjects: [],
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async resolvePrincipalId(slackTeamId: string, slackUserId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const workspaceId = await this.ensureWorkspace(client, slackTeamId);
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const principal = await this.ensurePrincipal(client, workspaceId, slackUserId);
      await client.query("commit");
      return principal.id;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async slackUserIdForPrincipal(workspaceId: string, principalId: string): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const result = await client.query<{ slack_user_id: string }>(
        "select slack_user_id from principals where id = $1 and workspace_id = $2",
        [principalId, workspaceId],
      );
      await client.query("commit");
      const row = result.rows[0];
      if (!row) {
        throw new Error("The requested internal principal is not mapped to this Slack workspace.");
      }
      return row.slack_user_id;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureWorkspace(client: PoolClient, slackTeamId: string): Promise<string> {
    const result = await client.query<WorkspaceRow>(
      `insert into workspaces (slack_team_id, created_at, updated_at)
       values ($1, now(), now())
       on conflict (slack_team_id) do update set updated_at = now()
       returning id`,
      [slackTeamId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Could not resolve the Slack workspace identity.");
    }
    return row.id;
  }

  private async ensurePrincipal(
    client: PoolClient,
    workspaceId: string,
    slackUserId: string,
  ): Promise<PrincipalRow> {
    const result = await client.query<PrincipalRow>(
      `insert into principals (workspace_id, slack_user_id, created_at, updated_at)
       values ($1, $2, now(), now())
       on conflict (workspace_id, slack_user_id) do update set updated_at = now()
       returning id, is_admin`,
      [workspaceId, slackUserId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Could not resolve the Slack user identity.");
    }
    return row;
  }
}
