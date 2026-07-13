import { AsyncLocalStorage } from "node:async_hooks";

import type { Pool, PoolClient } from "pg";

import { type ActionPlan, type Outcome, OutcomeSchema } from "../outcomes/index.js";
import type {
  OutcomeStore,
  SlackCardReference,
  StoredAuditEvent,
} from "../services/outcome-store.js";

type SqlClient = PoolClient;

function jsonParameter(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Expected a JSON-serializable value.");
  }
  return serialized;
}

function requireWorkspaceScope(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("A tenant workspace scope is required for this repository operation.");
  }
  return workspaceId;
}

function parseStoredOutcome(value: unknown): Outcome {
  const parsed = OutcomeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Stored outcome payload is invalid.");
  }
  return parsed.data;
}

function parseStoredActionPlan(value: unknown): ActionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored action-plan payload is invalid.");
  }
  const plan = value as Partial<ActionPlan>;
  if (
    typeof plan.id !== "string" ||
    typeof plan.workspaceId !== "string" ||
    typeof plan.outcomeId !== "string" ||
    typeof plan.planHash !== "string" ||
    typeof plan.version !== "number" ||
    typeof plan.state !== "string"
  ) {
    throw new Error("Stored action-plan payload is incomplete.");
  }
  return plan as ActionPlan;
}

function evidenceSourceSystem(kind: string): string {
  if (kind.startsWith("slack_")) {
    return "slack";
  }
  if (kind === "linear_issue") {
    return "linear";
  }
  return "knot";
}

/**
 * PostgreSQL implementation of the deterministic domain store. The complete
 * validated domain aggregate is retained in domain_payload while the normalized
 * tables provide tenancy, audit, query, retention, and connector boundaries.
 * The domain services, not this adapter, decide lifecycle or authorization.
 */
export class PostgresOutcomeStore implements OutcomeStore {
  private readonly transactionContext = new AsyncLocalStorage<{
    client: PoolClient;
    workspaceId?: string;
  }>();

  public constructor(private readonly pool: Pool) {}

  public async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()) {
      return work();
    }
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const result = await this.transactionContext.run({ client }, work);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async createOutcome(outcome: Outcome): Promise<void> {
    await this.inWorkspace(outcome.workspaceId, async (client) => {
      await client.query(
        `insert into outcomes (
          id, workspace_id, type, lifecycle_state, privacy_scope, title,
          requester_principal_id, accountable_owner_principal_id, contract_version,
          version, resolved_at, domain_payload, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )`,
        [
          outcome.id,
          outcome.workspaceId,
          outcome.type,
          outcome.state,
          outcome.contract.privacyScope?.kind ?? "private",
          outcome.contract.goal ?? "Untitled outcome",
          outcome.createdByPrincipalId,
          outcome.contract.accountableOwnerPrincipalId ?? null,
          outcome.contractVersion,
          outcome.version,
          outcome.closedAt ?? null,
          jsonParameter(outcome),
          outcome.createdAt,
          outcome.updatedAt,
        ],
      );
      await this.syncOutcomeProjection(client, outcome);
    });
  }

  public async getOutcome(outcomeId: string, workspaceId?: string): Promise<Outcome | undefined> {
    const scope = requireWorkspaceScope(workspaceId);
    return this.inWorkspace(scope, async (client) => {
      const result = await client.query<{ domain_payload: unknown }>(
        "select domain_payload from outcomes where id = $1 and workspace_id = $2",
        [outcomeId, scope],
      );
      const row = result.rows[0];
      return row ? parseStoredOutcome(row.domain_payload) : undefined;
    });
  }

  public async updateOutcome(outcome: Outcome, expectedVersion: number): Promise<void> {
    await this.inWorkspace(outcome.workspaceId, async (client) => {
      const result = await client.query<{ id: string }>(
        `update outcomes
           set lifecycle_state = $1,
               privacy_scope = $2,
               title = $3,
               accountable_owner_principal_id = $4,
               contract_version = $5,
               version = $6,
               resolved_at = $7,
               domain_payload = $8,
               updated_at = $9
         where id = $10 and workspace_id = $11 and version = $12
         returning id`,
        [
          outcome.state,
          outcome.contract.privacyScope?.kind ?? "private",
          outcome.contract.goal ?? "Untitled outcome",
          outcome.contract.accountableOwnerPrincipalId ?? null,
          outcome.contractVersion,
          outcome.version,
          outcome.closedAt ?? null,
          jsonParameter(outcome),
          outcome.updatedAt,
          outcome.id,
          outcome.workspaceId,
          expectedVersion,
        ],
      );
      if (!result.rows[0]) {
        throw new Error(
          `Outcome ${outcome.id} changed concurrently or is outside the tenant scope.`,
        );
      }
      await this.syncOutcomeProjection(client, outcome);
    });
  }

  public async deleteOutcome(outcomeId: string, workspaceId: string): Promise<void> {
    await this.inWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ id: string }>(
        "delete from outcomes where id = $1 and workspace_id = $2 returning id",
        [outcomeId, workspaceId],
      );
      if (!result.rows[0]) {
        throw new Error(`Outcome ${outcomeId} does not exist in the requested tenant.`);
      }
    });
  }

  public async saveActionPlan(plan: ActionPlan): Promise<void> {
    await this.inWorkspace(plan.workspaceId, async (client) => {
      await client.query(
        `insert into action_plans (
          id, workspace_id, outcome_id, created_by_principal_id, executor_principal_id,
          outcome_version, contract_version, version, state, reversibility, before_state,
          proposed_actions, evidence_snapshot, policy_version, plan_hash, idempotency_key,
          expires_at, domain_payload, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now(), now()
        )`,
        [
          plan.id,
          plan.workspaceId,
          plan.outcomeId,
          plan.createdByPrincipalId,
          plan.executorPrincipalId,
          plan.outcomeVersion,
          plan.contractVersion,
          plan.version,
          plan.state,
          plan.reversibility,
          jsonParameter(plan.beforeState),
          jsonParameter(plan.proposedActions),
          jsonParameter(plan.evidenceSnapshotIds),
          plan.policyVersion,
          plan.planHash,
          plan.idempotencyKey,
          plan.expiresAt,
          jsonParameter(plan),
        ],
      );
    });
  }

  public async getActionPlan(
    actionPlanId: string,
    workspaceId?: string,
  ): Promise<ActionPlan | undefined> {
    const scope = requireWorkspaceScope(workspaceId);
    return this.inWorkspace(scope, async (client) => {
      const result = await client.query<{ domain_payload: unknown }>(
        "select domain_payload from action_plans where id = $1 and workspace_id = $2",
        [actionPlanId, scope],
      );
      const row = result.rows[0];
      return row ? parseStoredActionPlan(row.domain_payload) : undefined;
    });
  }

  public async updateActionPlan(plan: ActionPlan, expectedVersion: number): Promise<void> {
    await this.inWorkspace(plan.workspaceId, async (client) => {
      const result = await client.query<{ id: string }>(
        `update action_plans
           set version = $1,
               state = $2,
               domain_payload = $3,
               updated_at = now()
         where id = $4 and workspace_id = $5 and version = $6
         returning id`,
        [plan.version, plan.state, jsonParameter(plan), plan.id, plan.workspaceId, expectedVersion],
      );
      if (!result.rows[0]) {
        throw new Error(
          `Action plan ${plan.id} changed concurrently or is outside the tenant scope.`,
        );
      }
      if (plan.state === "approved" && plan.approval) {
        await client.query(
          `insert into approvals (
            action_plan_id, approver_principal_id, decision, decided_at, created_at, updated_at
          ) values ($1, $2, 'approved', $3, now(), now())
          on conflict (action_plan_id, approver_principal_id) do nothing`,
          [plan.id, plan.approval.approverPrincipalId, plan.approval.approvedAt],
        );
      }
    });
  }

  public async setSlackCardReference(
    outcomeId: string,
    workspaceId: string,
    card: SlackCardReference,
  ): Promise<void> {
    await this.inWorkspace(workspaceId, async (client) => {
      const result = await client.query<{ outcome_id: string }>(
        `insert into slack_outcome_cards (
          outcome_id, workspace_id, channel_id, message_ts, audience_kind, audience_principal_ids,
          blocks, fallback_text, version, created_at, updated_at
        )
         select $1, $2, $3, $4, $5, $6, $7, $8, 1, now(), now()
         where exists (select 1 from outcomes where id = $1 and workspace_id = $2)
        on conflict (outcome_id) do update
          set channel_id = excluded.channel_id,
              message_ts = excluded.message_ts,
               audience_kind = excluded.audience_kind,
               audience_principal_ids = excluded.audience_principal_ids,
              blocks = excluded.blocks,
              fallback_text = excluded.fallback_text,
              version = slack_outcome_cards.version + 1,
              updated_at = now()
        returning outcome_id`,
        [
          outcomeId,
          workspaceId,
          card.channelId,
          card.messageTs,
          card.audience.kind,
          jsonParameter(card.audience.principalIds),
          jsonParameter(card.blocks),
          card.fallbackText,
        ],
      );
      if (!result.rows[0]) {
        throw new Error(`Outcome ${outcomeId} does not exist in the requested tenant.`);
      }
    });
  }

  public async getSlackCardReference(
    outcomeId: string,
    workspaceId?: string,
  ): Promise<SlackCardReference | undefined> {
    const scope = requireWorkspaceScope(workspaceId);
    return this.inWorkspace(scope, async (client) => {
      const result = await client.query<{
        channel_id: string;
        message_ts: string;
        audience_kind: "personal" | "selected_people";
        audience_principal_ids: unknown;
        blocks: unknown;
        fallback_text: string;
      }>(
        "select channel_id, message_ts, audience_kind, audience_principal_ids, blocks, fallback_text from slack_outcome_cards where outcome_id = $1 and workspace_id = $2",
        [outcomeId, scope],
      );
      const row = result.rows[0];
      if (
        !row ||
        !Array.isArray(row.blocks) ||
        !Array.isArray(row.audience_principal_ids) ||
        (row.audience_kind !== "personal" && row.audience_kind !== "selected_people") ||
        row.audience_principal_ids.some((principalId) => typeof principalId !== "string")
      ) {
        return undefined;
      }
      return {
        channelId: row.channel_id,
        messageTs: row.message_ts,
        audience: { kind: row.audience_kind, principalIds: row.audience_principal_ids as string[] },
        blocks: row.blocks as Record<string, unknown>[],
        fallbackText: row.fallback_text,
      };
    });
  }

  public async appendAudit(event: StoredAuditEvent): Promise<void> {
    await this.inWorkspace(event.workspaceId, async (client) => {
      await client.query(
        `insert into audit_events (
          id, workspace_id, actor_principal_id, outcome_id, type, causation_id,
          correlation_id, policy_version, after_value, evidence_reference_ids, created_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          event.id,
          event.workspaceId,
          event.actorPrincipalId ?? null,
          event.outcomeId ?? null,
          event.type,
          event.causationId,
          event.correlationId,
          event.policyVersion ?? null,
          jsonParameter(event.details),
          Array.isArray(event.details.closureEvidenceIds) ? event.details.closureEvidenceIds : [],
          event.at,
        ],
      );
    });
  }

  public async listAudit(
    outcomeId: string,
    workspaceId?: string,
  ): Promise<readonly StoredAuditEvent[]> {
    const scope = requireWorkspaceScope(workspaceId);
    return this.inWorkspace(scope, async (client) => {
      const result = await client.query<{
        id: string;
        workspace_id: string;
        outcome_id: string | null;
        actor_principal_id: string | null;
        type: string;
        correlation_id: string;
        causation_id: string;
        created_at: Date | string;
        after_value: unknown;
        policy_version: string | null;
      }>(
        `select id, workspace_id, outcome_id, actor_principal_id, type, correlation_id,
          causation_id, created_at, after_value, policy_version
         from audit_events
         where outcome_id = $1 and workspace_id = $2
         order by created_at asc`,
        [outcomeId, scope],
      );
      return result.rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        ...(row.outcome_id ? { outcomeId: row.outcome_id } : {}),
        ...(row.actor_principal_id ? { actorPrincipalId: row.actor_principal_id } : {}),
        type: row.type,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        at:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : new Date(row.created_at).toISOString(),
        details:
          row.after_value && typeof row.after_value === "object" && !Array.isArray(row.after_value)
            ? (row.after_value as Record<string, unknown>)
            : {},
        ...(row.policy_version ? { policyVersion: row.policy_version } : {}),
      }));
    });
  }

  private async inWorkspace<T>(
    workspaceId: string,
    work: (client: SqlClient) => Promise<T>,
  ): Promise<T> {
    const transaction = this.transactionContext.getStore();
    if (transaction) {
      if (transaction.workspaceId && transaction.workspaceId !== workspaceId) {
        throw new Error("A repository transaction cannot cross tenant workspace boundaries.");
      }
      if (!transaction.workspaceId) {
        await transaction.client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        transaction.workspaceId = workspaceId;
      }
      return work(transaction.client);
    }
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

  private async syncOutcomeProjection(client: SqlClient, outcome: Outcome): Promise<void> {
    const contract = outcome.contract;
    await client.query(
      `insert into outcome_contracts (
        outcome_id, version, goal, definition_of_done, next_move, review_point,
        privacy_scope, candidate_fields, confirmed_by_principal_id, confirmed_at,
        created_at, updated_at
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now())
      on conflict (outcome_id, version) do nothing`,
      [
        outcome.id,
        outcome.contractVersion,
        contract.goal ?? null,
        contract.definitionOfDone ?? null,
        contract.nextMove ? jsonParameter(contract.nextMove) : null,
        contract.reviewPoint ? jsonParameter(contract.reviewPoint) : null,
        contract.privacyScope?.kind ?? "private",
        jsonParameter({ provenance: outcome.contractFieldProvenance }),
        outcome.createdByPrincipalId,
        outcome.createdAt,
      ],
    );

    await client.query("delete from outcome_participants where outcome_id = $1", [outcome.id]);
    for (const participant of contract.participants ?? []) {
      for (const role of participant.roles) {
        await client.query(
          `insert into outcome_participants (
            outcome_id, principal_id, role, status, created_at, updated_at
          ) values ($1, $2, $3, $4, now(), now())`,
          [
            outcome.id,
            participant.principalId,
            role,
            participant.principalId === contract.accountableOwnerPrincipalId &&
            outcome.ownerAcceptance.status === "accepted"
              ? "accepted"
              : "recorded",
          ],
        );
      }
    }

    await client.query("delete from outcome_audience_grants where outcome_id = $1", [outcome.id]);
    for (const grant of outcome.audience.grants) {
      const subjectId =
        grant.subject.kind === "principal"
          ? grant.subject.principalId
          : grant.subject.kind === "channel"
            ? grant.subject.channelId
            : grant.subject.workspaceId;
      for (const permission of grant.permissions) {
        await client.query(
          `insert into outcome_audience_grants (
            outcome_id, subject_type, subject_id, permission, granted_by_principal_id,
            created_at, updated_at
          ) values ($1, $2, $3, $4, $5, now(), now())`,
          [outcome.id, grant.subject.kind, subjectId, permission, outcome.createdByPrincipalId],
        );
      }
    }

    const currentEvidence = contract.evidence ?? [];
    const currentEvidenceKeys = currentEvidence.map((evidence) => evidence.id);
    if (currentEvidenceKeys.length === 0) {
      await client.query("delete from evidence_references where outcome_id = $1", [outcome.id]);
    } else {
      await client.query(
        `delete from evidence_references
          where outcome_id = $1 and not (evidence_key = any($2::text[]))`,
        [outcome.id, currentEvidenceKeys],
      );
    }

    for (const evidence of currentEvidence) {
      await client.query(
        `insert into evidence_references (
          workspace_id, outcome_id, evidence_key, source_system, source_identifier,
          source_permalink, source_timestamp, classification, confidence, freshness,
          visibility_context, extracted_at, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), now())
        on conflict (outcome_id, evidence_key) do update
          set source_permalink = excluded.source_permalink,
              source_timestamp = excluded.source_timestamp,
              classification = excluded.classification,
              freshness = excluded.freshness,
              visibility_context = excluded.visibility_context,
              updated_at = now()`,
        [
          outcome.workspaceId,
          outcome.id,
          evidence.id,
          evidenceSourceSystem(evidence.kind),
          evidence.id,
          evidence.locator,
          evidence.observedAt,
          evidence.kind,
          "confirmed",
          evidence.freshness,
          jsonParameter({ outcomePrivacyScope: contract.privacyScope?.kind ?? "private" }),
        ],
      );
    }
  }
}
