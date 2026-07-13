import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "../../src/db/client.js";
import { PostgresInteractionContextStore } from "../../src/db/interaction-context-store.js";
import { PostgresOutcomeStore } from "../../src/db/outcome-store.js";
import { PostgresSlackIngressReceiptStore } from "../../src/db/slack-ingress-receipt-store.js";
import { PostgresActorIdentityResolver } from "../../src/identity/resolver.js";
import type {
  ActorContext,
  AuthorizedAudience,
  ContractFieldProvenance,
  OutcomeContract,
} from "../../src/outcomes/index.js";
import { hashExternalState } from "../../src/outcomes/index.js";
import { type ActionExecutor, OutcomeService } from "../../src/services/outcome-service.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const at = "2026-07-12T12:00:00.000Z";

const executor: ActionExecutor = {
  getSlackCardVersion: async (action) =>
    hashExternalState({ text: action.beforeFallbackText, blocks: action.beforeBlocks }),
  executeSlackCardUpdate: async () => ({
    receipt: { ok: true, remote: "updated" },
    externalVersion: "after-card-v1",
  }),
  rollbackSlackCardUpdate: async () => ({
    receipt: { ok: true, remote: "restored" },
    externalVersion: "before-card-v1",
  }),
};

describeDatabase("PostgreSQL walking skeleton", () => {
  let database: DatabaseHandle | undefined;

  afterAll(async () => {
    await database?.close();
  });

  it("persists tenant-scoped identity, prevents duplicate effects, and version-checks compensation", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL integration suite.");
    }
    database ??= createDatabase(databaseUrl);
    const store = new PostgresOutcomeStore(database.pool);
    const service = new OutcomeService(store);
    const identities = new PostgresActorIdentityResolver(database.pool);
    const suffix = randomUUID();
    const teamId = `T${suffix}`;

    const creator = await identities.resolve({
      slackTeamId: teamId,
      slackUserId: `Ucreator${suffix}`,
      correlationId: `creator:${suffix}`,
      authenticatedAt: at,
    });
    const owner = await identities.resolve({
      slackTeamId: teamId,
      slackUserId: `Uowner${suffix}`,
      correlationId: `owner:${suffix}`,
      authenticatedAt: at,
    });
    const reviewer = await identities.resolve({
      slackTeamId: teamId,
      slackUserId: `Ureviewer${suffix}`,
      correlationId: `reviewer:${suffix}`,
      authenticatedAt: at,
    });

    const contract: OutcomeContract = {
      goal: "Obtain a release decision.",
      accountableOwnerPrincipalId: owner.principalId,
      definitionOfDone: "The decision and its evidence are recorded.",
      nextMove: { description: "Review the release plan.", actorPrincipalId: owner.principalId },
      reviewPoint: { kind: "at", at: "2026-07-14T12:00:00.000Z" },
      evidence: [
        {
          id: `source:${suffix}`,
          kind: "slack_message",
          label: "Selected request",
          locator: "https://example.test/selected-message",
          observedAt: at,
          freshness: "fresh",
        },
      ],
      participants: [
        { principalId: owner.principalId, roles: ["owner"] },
        { principalId: creator.principalId, roles: ["requester"] },
        { principalId: reviewer.principalId, roles: ["contributor"] },
      ],
      privacyScope: { kind: "selected_people" },
    };
    const provenance: readonly ContractFieldProvenance[] = [
      "goal",
      "accountableOwnerPrincipalId",
      "definitionOfDone",
      "nextMove",
      "reviewPoint",
      "evidence",
      "participants",
      "privacyScope",
    ].map((field) => ({
      field: field as ContractFieldProvenance["field"],
      source: "user" as const,
      evidenceIds: [`source:${suffix}`],
      freshness: "fresh" as const,
      confirmedByPrincipalId: creator.principalId,
      confirmedAt: at,
    }));
    const audience: AuthorizedAudience = {
      grants: [
        {
          id: `creator:${suffix}`,
          subject: { kind: "principal", principalId: creator.principalId },
          permissions: ["view", "edit", "evidence_access"],
        },
        {
          id: `owner:${suffix}`,
          subject: { kind: "principal", principalId: owner.principalId },
          permissions: ["view", "edit", "execute", "evidence_access"],
        },
        {
          id: `reviewer:${suffix}`,
          subject: { kind: "principal", principalId: reviewer.principalId },
          permissions: ["view", "approve", "evidence_access"],
        },
      ],
    };

    const created = await service.createConfirmedOutcome({
      actor: creator,
      type: "request",
      contract,
      provenance,
      audience,
      at,
    });
    const active = await service.acceptOwnership(created.id, owner, at);
    await service.setSlackCardReference(active.id, owner, {
      channelId: `G${suffix}`,
      messageTs: "1710000000.000100",
      audience: {
        kind: "personal",
        principalIds: [owner.principalId],
      },
      blocks: [{ type: "section", text: { type: "plain_text", text: "Before" } }],
      fallbackText: "Before",
    });

    const plan = await service.previewSlackCardUpdate(
      active.id,
      owner,
      at,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approvals = await Promise.allSettled([
      service.approveAction(plan.id, reviewer, at),
      service.approveAction(plan.id, reviewer, at),
    ]);
    expect(approvals.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const approved = approvals.find(
      (
        result,
      ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.approveAction>>> =>
        result.status === "fulfilled",
    )?.value;
    expect(approved?.state).toBe("approved");
    expect(approved?.approval?.approverPrincipalId).toBe(reviewer.principalId);
    const recordedApproval = await database.pool.query<{
      approver_principal_id: string;
      decision: string;
    }>("select approver_principal_id, decision from approvals where action_plan_id = $1", [
      plan.id,
    ]);
    expect(recordedApproval.rows).toContainEqual({
      approver_principal_id: reviewer.principalId,
      decision: "approved",
    });

    const executions = await Promise.allSettled([
      service.executeApprovedAction(plan.id, owner, at, plan.planHash, executor),
      service.executeApprovedAction(plan.id, owner, at, plan.planHash, executor),
    ]);
    expect(executions.filter((result) => result.status === "fulfilled")).toHaveLength(1);

    await expect(
      service.rollbackAction(plan.id, owner, "different-version", executor),
    ).rejects.toThrow("changed");
    const compensated = await service.rollbackAction(plan.id, owner, "after-card-v1", executor);
    expect(compensated.state).toBe("compensated");

    const foreignActor = await identities.resolve({
      slackTeamId: `Tforeign${suffix}`,
      slackUserId: `Uforeign${suffix}`,
      correlationId: `foreign:${suffix}`,
      authenticatedAt: at,
    });
    await expect(service.getOutcome(active.id, foreignActor as ActorContext)).rejects.toThrow(
      "no longer exists",
    );
    expect(await store.listAudit(active.id, creator.workspaceId)).not.toHaveLength(0);

    const rls = await database.pool.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'outcomes'",
    );
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    await database.pool.query(
      "do $$ begin create role knot_rls_test nologin; exception when duplicate_object then null; end $$;",
    );
    await database.pool.query("grant usage on schema public to knot_rls_test");
    await database.pool.query("grant select on outcomes to knot_rls_test");
    const rlsClient = await database.pool.connect();
    try {
      await rlsClient.query("begin");
      await rlsClient.query("set local role knot_rls_test");
      const unscopedRead = await rlsClient.query<{ count: string }>(
        "select count(*) from outcomes where id = $1",
        [active.id],
      );
      await rlsClient.query("commit");
      expect(Number(unscopedRead.rows[0]?.count ?? "0")).toBe(0);
    } finally {
      await rlsClient.query("rollback").catch(() => undefined);
      rlsClient.release();
    }
  });

  it("removes superseded evidence before deletion and retains only the scoped audit tombstone", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL integration suite.");
    }
    database ??= createDatabase(databaseUrl);
    const store = new PostgresOutcomeStore(database.pool);
    const service = new OutcomeService(store);
    const identities = new PostgresActorIdentityResolver(database.pool);
    const suffix = randomUUID();
    const actor = await identities.resolve({
      slackTeamId: `Tdelete${suffix}`,
      slackUserId: `Udelete${suffix}`,
      correlationId: `delete:${suffix}`,
      authenticatedAt: at,
    });
    const contract: OutcomeContract = {
      goal: "Delete this private source content.",
      accountableOwnerPrincipalId: actor.principalId,
      definitionOfDone: "The private content is removed.",
      nextMove: { description: "Delete the outcome.", actorPrincipalId: actor.principalId },
      reviewPoint: { kind: "on_event", event: "Immediately" },
      evidence: [
        {
          id: `private-source:${suffix}`,
          kind: "slack_message",
          label: "Private source",
          locator: "https://example.test/private-source",
          observedAt: at,
          freshness: "fresh",
        },
      ],
      participants: [{ principalId: actor.principalId, roles: ["owner", "requester"] }],
      privacyScope: { kind: "private" },
    };
    const audience: AuthorizedAudience = {
      grants: [
        {
          id: `private:${suffix}`,
          subject: { kind: "principal", principalId: actor.principalId },
          permissions: ["view", "edit", "approve", "execute", "evidence_access"],
        },
      ],
    };
    const created = await service.createConfirmedOutcome({
      actor,
      type: "other",
      contract,
      provenance: [],
      audience,
      at,
    });
    const active = await service.acceptOwnership(created.id, actor, at);
    const replacementEvidence = {
      id: `replacement-source:${suffix}`,
      kind: "slack_message" as const,
      label: "Corrected private source",
      locator: "https://example.test/corrected-private-source",
      observedAt: at,
      freshness: "fresh" as const,
    };
    const corrected = await service.correctOutcome(active.id, actor, at, {
      contract: { ...contract, evidence: [replacementEvidence] },
      provenance: [],
      audience,
      reason: "Replace the source reference after a privacy correction.",
    });

    const evidenceClient = await database.pool.connect();
    try {
      await evidenceClient.query("begin");
      await evidenceClient.query("select set_config('app.workspace_id', $1, true)", [
        actor.workspaceId,
      ]);
      const evidenceProjection = await evidenceClient.query<{
        evidence_key: string;
        source_permalink: string | null;
      }>(
        "select evidence_key, source_permalink from evidence_references where outcome_id = $1 order by evidence_key",
        [created.id],
      );
      await evidenceClient.query("commit");
      expect(evidenceProjection.rows).toEqual([
        {
          evidence_key: replacementEvidence.id,
          source_permalink: replacementEvidence.locator,
        },
      ]);
    } finally {
      await evidenceClient.query("rollback").catch(() => undefined);
      evidenceClient.release();
    }

    await service.deleteOutcome(corrected.id, actor, at, "privacy_request");

    const scopedClient = await database.pool.connect();
    try {
      await scopedClient.query("begin");
      await scopedClient.query("select set_config('app.workspace_id', $1, true)", [
        actor.workspaceId,
      ]);
      const removed = await scopedClient.query<{ count: string }>(
        "select count(*) from outcomes where id = $1",
        [created.id],
      );
      const tombstone = await scopedClient.query<{
        outcome_id: string | null;
        after_value: Record<string, unknown>;
      }>(
        `select outcome_id, after_value
           from audit_events
          where workspace_id = $1 and type = 'outcome.deleted_tombstone'
            and correlation_id = $2`,
        [actor.workspaceId, actor.correlationId],
      );
      await scopedClient.query("commit");

      expect(Number(removed.rows[0]?.count ?? "0")).toBe(0);
      expect(tombstone.rows).toHaveLength(1);
      expect(tombstone.rows[0]?.outcome_id).toBeNull();
      expect(tombstone.rows[0]?.after_value).toMatchObject({
        priorState: "active",
        outcomeType: "other",
        reasonCode: "privacy_request",
      });
      expect(tombstone.rows[0]?.after_value).not.toHaveProperty("goal");
    } finally {
      await scopedClient.query("rollback").catch(() => undefined);
      scopedClient.release();
    }
  });

  it("keeps only the source permalink needed by the single-use Slack modal context", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL integration suite.");
    }
    database ??= createDatabase(databaseUrl);
    const identities = new PostgresActorIdentityResolver(database.pool);
    const contexts = new PostgresInteractionContextStore(database.pool);
    const suffix = randomUUID();
    const actor = await identities.resolve({
      slackTeamId: `Tcontext${suffix}`,
      slackUserId: `Ucontext${suffix}`,
      correlationId: `context:${suffix}`,
      authenticatedAt: at,
    });
    const context = await contexts.create({
      creator: { workspaceId: actor.workspaceId, principalId: actor.principalId },
      source: {
        channelId: `C${suffix}`,
        messageTs: "1710000000.000300",
        text: "private source text that must not be retained",
        permalink: "https://example.slack.com/archives/C1/p1710000000000300",
        observedAt: at,
      },
    });
    expect(context.source.text).toBe("");
    expect(context.source.permalink).toBe(
      "https://example.slack.com/archives/C1/p1710000000000300",
    );

    await expect(
      contexts.consume(context.reference, {
        workspaceId: actor.workspaceId,
        principalId: actor.principalId,
      }),
    ).resolves.toMatchObject({ reference: context.reference });
    await expect(
      contexts.get(context.reference, {
        workspaceId: actor.workspaceId,
        principalId: actor.principalId,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a persisted Slack delivery-key collision instead of treating it as a retry", async () => {
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is required for the PostgreSQL integration suite.");
    }
    database ??= createDatabase(databaseUrl);
    const ingress = new PostgresSlackIngressReceiptStore(database.pool);
    const suffix = randomUUID();
    const receipt = {
      deliveryKey: `delivery:${suffix}`,
      workspaceSlackTeamId: `T${suffix}`,
      payload: { action: "owner_accept", value: suffix },
    };

    await expect(ingress.claim(receipt)).resolves.toBe(true);
    await expect(ingress.claim(receipt)).resolves.toBe(false);
    await expect(
      ingress.claim({ ...receipt, payload: { action: "owner_decline", value: suffix } }),
    ).rejects.toThrow("refused the collision");
  });
});
