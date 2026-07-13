import { describe, expect, it } from "vitest";

import {
  type ActorContext,
  type AuthorizedAudience,
  type ContractFieldProvenance,
  hashExternalState,
  type OutcomeContract,
  OutcomeDomainError,
} from "../../src/outcomes/index.js";
import { type ActionExecutor, OutcomeService } from "../../src/services/outcome-service.js";
import { InMemoryOutcomeStore, type SlackCardReference } from "../../src/services/outcome-store.js";
import { timestamp } from "../helpers/outcome.js";

const actor = (principalId: string): ActorContext => ({
  workspaceId: "workspace-1",
  principalId,
  slackUserId: `slack-${principalId}`,
  correlationId: `corr-${principalId}`,
  authenticatedAt: timestamp,
  isWorkspaceAdmin: false,
  resolvedAudienceSubjects: [],
});

const workspaceAdmin = (principalId: string): ActorContext => ({
  ...actor(principalId),
  isWorkspaceAdmin: true,
});

const sharedContract: OutcomeContract = {
  goal: "Get a release review.",
  accountableOwnerPrincipalId: "owner-1",
  definitionOfDone: "The reviewer records approval or a required revision.",
  nextMove: { description: "Review the release notes.", actorPrincipalId: "owner-1" },
  reviewPoint: { kind: "at", at: "2026-07-14T12:00:00.000Z" },
  evidence: [
    {
      id: "evidence-1",
      kind: "slack_message",
      label: "Original request",
      locator: "https://example.slack.com/archives/C1/p1",
      observedAt: timestamp,
      freshness: "fresh",
    },
  ],
  participants: [
    { principalId: "owner-1", roles: ["owner"] },
    { principalId: "creator-1", roles: ["requester"] },
    { principalId: "reviewer-1", roles: ["contributor"] },
  ],
  privacyScope: { kind: "selected_people" },
};

const confirmedProvenance: readonly ContractFieldProvenance[] = [
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
  evidenceIds: ["evidence-1"],
  freshness: "fresh" as const,
  confirmedByPrincipalId: "creator-1",
  confirmedAt: timestamp,
}));

const sharedAudience: AuthorizedAudience = {
  grants: [
    {
      id: "creator",
      subject: { kind: "principal" as const, principalId: "creator-1" },
      permissions: ["view", "edit", "evidence_access"],
    },
    {
      id: "owner",
      subject: { kind: "principal" as const, principalId: "owner-1" },
      permissions: ["view", "edit", "approve", "execute", "evidence_access"],
    },
    {
      id: "reviewer",
      subject: { kind: "principal" as const, principalId: "reviewer-1" },
      permissions: ["view", "approve", "evidence_access"],
    },
  ],
};

class AuditFailingStore extends InMemoryOutcomeStore {
  public failAudit = false;

  public override async appendAudit(
    event: Parameters<InMemoryOutcomeStore["appendAudit"]>[0],
  ): Promise<void> {
    if (this.failAudit) {
      throw new Error("simulated audit failure");
    }
    await super.appendAudit(event);
  }
}

const executor: ActionExecutor = {
  getSlackCardVersion: async (action) =>
    hashExternalState({ text: action.beforeFallbackText, blocks: action.beforeBlocks }),
  executeSlackCardUpdate: async (action) => ({
    receipt: { ok: true },
    externalVersion: hashExternalState({
      text: action.afterFallbackText,
      blocks: action.afterBlocks,
    }),
  }),
  rollbackSlackCardUpdate: async (action) => ({
    receipt: { ok: true },
    externalVersion: hashExternalState({
      text: action.beforeFallbackText,
      blocks: action.beforeBlocks,
    }),
  }),
};

class ToggleProjectionStore extends InMemoryOutcomeStore {
  public failProjection = false;

  public override async setSlackCardReference(
    outcomeId: string,
    workspaceId: string,
    card: SlackCardReference,
  ): Promise<void> {
    if (this.failProjection) {
      throw new Error("Projection write unavailable");
    }
    await super.setSlackCardReference(outcomeId, workspaceId, card);
  }
}

async function createActiveSharedOutcome(service: OutcomeService) {
  const created = await service.createConfirmedOutcome({
    actor: actor("creator-1"),
    type: "request",
    contract: sharedContract,
    provenance: confirmedProvenance,
    audience: sharedAudience,
    at: timestamp,
  });
  const active = await service.acceptOwnership(created.id, actor("owner-1"), timestamp);
  await service.setSlackCardReference(active.id, actor("owner-1"), {
    channelId: "Downer",
    messageTs: "1710000000.000100",
    audience: { kind: "personal", principalIds: ["owner-1"] },
    blocks: [{ type: "section", text: { type: "plain_text", text: "Before" } }],
    fallbackText: "Before",
  });
  return active;
}

describe("OutcomeService walking skeleton", () => {
  it("rolls back a lifecycle write when its required audit event cannot persist", async () => {
    const store = new AuditFailingStore();
    const service = new OutcomeService(store);
    const outcomeId = "f46ba9c8-29cd-4a55-8e38-74f7c088da5d";
    store.failAudit = true;

    await expect(
      service.createConfirmedOutcome({
        id: outcomeId,
        actor: actor("creator-1"),
        type: "request",
        contract: sharedContract,
        provenance: confirmedProvenance,
        audience: sharedAudience,
        at: timestamp,
      }),
    ).rejects.toThrow("simulated audit failure");
    await expect(store.getOutcome(outcomeId, "workspace-1")).resolves.toBeUndefined();
  });
  it("uses separated roles for a shared update, rollback, and closure", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("creator-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
      ),
    ).rejects.toThrow("authorized");

    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    await expect(service.approveAction(plan.id, actor("owner-1"), timestamp)).rejects.toThrow(
      "self-approve",
    );

    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const applied = await service.executeApprovedAction(
      approved.id,
      actor("owner-1"),
      timestamp,
      approved.planHash,
      executor,
    );
    expect(applied.state).toBe("applied");

    const compensated = await service.rollbackAction(
      applied.id,
      actor("owner-1"),
      applied.executionReceipt?.externalVersion,
      executor,
    );
    expect(compensated.state).toBe("compensated");

    await service.recordEvidence(
      active.id,
      actor("owner-1"),
      {
        id: "closure-evidence-1",
        kind: "completion_record",
        label: "Review completed",
        locator: "https://example.test/completion/1",
        observedAt: timestamp,
        freshness: "fresh",
        verification: {
          method: "authorized_user_attestation",
          verifiedAt: timestamp,
          verifiedByPrincipalId: "owner-1",
        },
      },
      timestamp,
    );
    await service.requestClosure(active.id, actor("owner-1"), timestamp);
    const closed = await service.verifyAndClose(active.id, actor("owner-1"), timestamp, [
      "closure-evidence-1",
    ]);
    expect(closed.state).toBe("closed");
  });

  it("returns one deterministically bound action plan across concurrent preview retries", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const binding = {
      actionPlanId: "742ab00d-a107-4b85-b139-0e6b7a4e942d",
      idempotencyKey: "action-preview:742ab00d-a107-4b85-b139-0e6b7a4e942d",
    };
    const preview = () =>
      service.previewSlackCardUpdate(
        active.id,
        actor("owner-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
        binding,
      );

    const [first, retry] = await Promise.all([preview(), preview()]);

    expect(first).toEqual(retry);
    expect(first).toMatchObject({
      id: binding.actionPlanId,
      idempotencyKey: binding.idempotencyKey,
      outcomeId: active.id,
      createdByPrincipalId: "owner-1",
      executorPrincipalId: "owner-1",
      state: "planned",
    });
    const audit = await store.listAudit(active.id, active.workspaceId);
    expect(audit.filter((event) => event.type === "action.previewed")).toHaveLength(1);

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("owner-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
        { ...binding, idempotencyKey: "action-preview:different-command" },
      ),
    ).rejects.toThrow("different command");
  });

  it("rejects malformed deterministic action-plan bindings before persistence", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("owner-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
        { actionPlanId: "not-a-uuid", idempotencyKey: "" },
      ),
    ).rejects.toThrow("retry binding is invalid");
    const audit = await store.listAudit(active.id, active.workspaceId);
    expect(audit.filter((event) => event.type === "action.previewed")).toHaveLength(0);
  });

  it("does not grant an unlisted workspace administrator break-glass action authority", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const administrator = workspaceAdmin("admin-1");
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );

    await expect(service.approveAction(plan.id, administrator, timestamp)).rejects.toThrow(
      "not authorized",
    );
    await expect(
      service.delegateOwnerAuthority(
        active.id,
        administrator,
        "delegate-1",
        ["act_as_owner"],
        timestamp,
      ),
    ).rejects.toThrow("not authorized");
    await expect(service.requestClosure(active.id, administrator, timestamp)).rejects.toThrow(
      "not authorized",
    );

    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    await expect(
      service.executeApprovedAction(
        approved.id,
        administrator,
        timestamp,
        approved.planHash,
        executor,
      ),
    ).rejects.toThrow("not authorized");

    const applied = await service.executeApprovedAction(
      approved.id,
      actor("owner-1"),
      timestamp,
      approved.planHash,
      executor,
    );
    await expect(
      service.rollbackAction(
        applied.id,
        administrator,
        applied.executionReceipt?.externalVersion,
        executor,
      ),
    ).rejects.toThrow("not authorized");
  });

  it("keeps an ACL-listed workspace administrator bound to owner and exact-plan roles", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const administrator = workspaceAdmin("admin-1");
    const explicitlyListed = {
      ...active,
      audience: {
        grants: [
          ...active.audience.grants,
          {
            id: "admin",
            subject: { kind: "principal" as const, principalId: administrator.principalId },
            permissions: [
              "view",
              "edit",
              "execute",
            ] as AuthorizedAudience["grants"][number]["permissions"],
          },
        ],
      },
      version: active.version + 1,
    };
    await store.updateOutcome(explicitlyListed, active.version);

    await expect(
      service.delegateOwnerAuthority(
        active.id,
        administrator,
        "delegate-1",
        ["act_as_owner"],
        timestamp,
      ),
    ).rejects.toThrow("accountable owner");
    await expect(service.requestClosure(active.id, administrator, timestamp)).rejects.toThrow(
      "closure authority",
    );

    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    await expect(
      service.executeApprovedAction(
        approved.id,
        administrator,
        timestamp,
        approved.planHash,
        executor,
      ),
    ).rejects.toThrow("named in the approved plan");

    const applied = await service.executeApprovedAction(
      approved.id,
      actor("owner-1"),
      timestamp,
      approved.planHash,
      executor,
    );
    await expect(
      service.rollbackAction(
        applied.id,
        administrator,
        applied.executionReceipt?.externalVersion,
        executor,
      ),
    ).rejects.toThrow("original executor");
  });

  it.each([
    "proposed",
    "clarified",
    "awaiting_owner_acceptance",
    "closure_requested",
    "closed",
    "cancelled",
  ] as const)("rejects a Slack card update preview while the outcome is %s", async (state) => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    await store.updateOutcome(
      {
        ...active,
        state,
        version: active.version + 1,
        ...(state === "closed"
          ? {
              closedAt: timestamp,
              closedByPrincipalId: "owner-1",
              closureEvidenceIds: ["evidence-1"],
            }
          : {}),
      },
      active.version,
    );

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("owner-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
      ),
    ).rejects.toMatchObject({ code: "action_preview_invalid_state" });
  });

  it("rejects a Slack card update preview after the outcome is deleted", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    await service.deleteOutcome(active.id, actor("creator-1"), timestamp, "user_request");

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("creator-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
      ),
    ).rejects.toMatchObject({ code: "outcome_not_found" });
  });

  it("lets the selected executor compensate without granting unrelated edit authority", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const executorContract: OutcomeContract = {
      ...sharedContract,
      nextMove: {
        description: "Publish the approved progress update.",
        actorPrincipalId: "executor-1",
      },
      participants: [
        ...(sharedContract.participants ?? []),
        { principalId: "executor-1", roles: ["contributor"] },
      ],
    };
    const executorAudience: AuthorizedAudience = {
      grants: [
        ...sharedAudience.grants,
        {
          id: "executor",
          subject: { kind: "principal", principalId: "executor-1" },
          permissions: ["view", "execute", "evidence_access"],
        },
      ],
    };
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: executorContract,
      provenance: confirmedProvenance,
      audience: executorAudience,
      at: timestamp,
    });
    const active = await service.acceptOwnership(created.id, actor("owner-1"), timestamp);
    await service.setSlackCardReference(active.id, actor("owner-1"), {
      channelId: "Downer",
      messageTs: "1710000000.000200",
      audience: { kind: "personal", principalIds: ["owner-1"] },
      blocks: [{ type: "section", text: { type: "plain_text", text: "Before" } }],
      fallbackText: "Before",
    });
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("executor-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const applied = await service.executeApprovedAction(
      plan.id,
      actor("executor-1"),
      timestamp,
      plan.planHash,
      executor,
    );

    await expect(
      service.rollbackAction(
        applied.id,
        actor("executor-1"),
        applied.executionReceipt?.externalVersion,
        executor,
      ),
    ).resolves.toMatchObject({ state: "compensated" });
  });

  it("does not allow a personal card to bypass shared separation of duty", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );

    await expect(service.approveAction(plan.id, actor("owner-1"), timestamp)).rejects.toThrow(
      "self-approve",
    );
  });

  it("binds an action preview to Slack's live normalized card snapshot", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const liveBeforeCard: SlackCardReference = {
      channelId: "Downer",
      messageTs: "1710000000.000100",
      audience: { kind: "personal", principalIds: ["owner-1"] },
      blocks: [
        {
          type: "section",
          block_id: "slack-normalized-block",
          text: { type: "mrkdwn", text: "*Before*" },
        },
      ],
      fallbackText: "Slack normalized before state",
    };

    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
      undefined,
      liveBeforeCard,
    );

    expect(plan.proposedActions[0]).toMatchObject({
      kind: "slack.card.update",
      beforeBlocks: liveBeforeCard.blocks,
      beforeFallbackText: liveBeforeCard.fallbackText,
    });
    await expect(service.getSlackCardReference(active.id, actor("owner-1"))).resolves.toMatchObject(
      liveBeforeCard,
    );
  });

  it("rejects a live preview snapshot that changes the card identity or audience", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("owner-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
        undefined,
        {
          channelId: "Dother",
          messageTs: "1710000000.000100",
          audience: { kind: "personal", principalIds: ["owner-1"] },
          blocks: [],
          fallbackText: "Different card",
        },
      ),
    ).rejects.toMatchObject({ code: "action_preview_card_mismatch" });
  });

  it("allows a private, single-message outcome to self-confirm its reversible update", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const privateContract: OutcomeContract = {
      ...sharedContract,
      accountableOwnerPrincipalId: "creator-1",
      nextMove: { description: "Resolve the selected message.", actorPrincipalId: "creator-1" },
      participants: [{ principalId: "creator-1", roles: ["owner", "requester"] }],
      privacyScope: { kind: "private" },
    };
    const privateAudience: AuthorizedAudience = {
      grants: [
        {
          id: "creator",
          subject: { kind: "principal", principalId: "creator-1" },
          permissions: ["view", "edit", "approve", "execute", "evidence_access"],
        },
      ],
    };
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "other",
      contract: privateContract,
      provenance: confirmedProvenance,
      audience: privateAudience,
      at: timestamp,
    });
    const active = await service.acceptOwnership(created.id, actor("creator-1"), timestamp);
    await service.setSlackCardReference(active.id, actor("creator-1"), {
      channelId: "Dcreator",
      messageTs: "1710000000.000100",
      audience: { kind: "personal", principalIds: ["creator-1"] },
      blocks: [{ type: "section", text: { type: "plain_text", text: "Before" } }],
      fallbackText: "Before",
    });
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("creator-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );

    await expect(
      service.approveAction(plan.id, actor("creator-1"), timestamp),
    ).resolves.toMatchObject({
      state: "approved",
    });
  });

  it("enforces the person explicitly named for the current next move", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const audienceWithAnotherExecutor: AuthorizedAudience = {
      grants: [
        ...sharedAudience.grants,
        {
          id: "other-executor",
          subject: { kind: "principal", principalId: "other-1" },
          permissions: ["view", "execute"],
        },
      ],
    };
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: audienceWithAnotherExecutor,
      at: timestamp,
    });
    const active = await service.acceptOwnership(created.id, actor("owner-1"), timestamp);

    await expect(
      service.previewSlackCardUpdate(
        active.id,
        actor("other-1"),
        timestamp,
        [{ type: "section", text: { type: "plain_text", text: "After" } }],
        "After",
      ),
    ).rejects.toThrow("current next move");
  });

  it("does not create a shared outcome with unconfirmed model fields", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());

    await expect(
      service.createConfirmedOutcome({
        actor: actor("creator-1"),
        type: "request",
        contract: sharedContract,
        provenance: [],
        audience: sharedAudience,
        at: timestamp,
      }),
    ).rejects.toThrow(OutcomeDomainError);
  });

  it("requires the creator, not another participant, to confirm every shared field", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const confirmedByOwner = confirmedProvenance.map((entry) => ({
      ...entry,
      confirmedByPrincipalId: "owner-1",
    }));

    await expect(
      service.createConfirmedOutcome({
        actor: actor("creator-1"),
        type: "request",
        contract: sharedContract,
        provenance: confirmedByOwner,
        audience: sharedAudience,
        at: timestamp,
      }),
    ).rejects.toThrow("confirmation");
  });

  it("fails closed when an action plan has expired before approval", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );

    await expect(
      service.approveAction(plan.id, actor("reviewer-1"), "2026-07-12T12:11:00.000Z"),
    ).rejects.toThrow("expired");
  });

  it("rejects approval after outcome evidence changes", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    await service.recordEvidence(
      active.id,
      actor("owner-1"),
      {
        id: "new-evidence-after-preview",
        kind: "manual_note",
        label: "New evidence",
        locator: "https://example.test/new-evidence",
        observedAt: timestamp,
        freshness: "fresh",
      },
      timestamp,
    );

    await expect(service.approveAction(plan.id, actor("reviewer-1"), timestamp)).rejects.toThrow(
      "outcome changed",
    );
  });

  it("does not overwrite a Slack card that changed after exact-plan approval", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    let mutationCalled = false;
    const changedCardExecutor: ActionExecutor = {
      getSlackCardVersion: async () => "a-newer-card-version",
      executeSlackCardUpdate: async () => {
        mutationCalled = true;
        return { receipt: { ok: true } };
      },
      rollbackSlackCardUpdate: async () => ({ receipt: { ok: true } }),
    };

    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        changedCardExecutor,
      ),
    ).rejects.toThrow("changed after the preview");
    expect(mutationCalled).toBe(false);
    await expect(service.getActionPlan(approved.id, actor("owner-1"))).resolves.toMatchObject({
      state: "failed",
    });
  });

  it("reconciles a crash after Slack applied an update without dispatching it twice", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const dispatching = {
      ...approved,
      state: "dispatching" as const,
      version: approved.version + 1,
    };
    await store.updateActionPlan(dispatching, approved.version);
    let dispatches = 0;
    const reconciler: ActionExecutor = {
      getSlackCardVersion: async (action) =>
        hashExternalState({ text: action.afterFallbackText, blocks: action.afterBlocks }),
      executeSlackCardUpdate: async () => {
        dispatches += 1;
        return { receipt: { ok: true } };
      },
      rollbackSlackCardUpdate: async () => ({ receipt: { ok: true } }),
    };

    await expect(
      service.executeApprovedAction(
        dispatching.id,
        actor("owner-1"),
        timestamp,
        dispatching.planHash,
        reconciler,
      ),
    ).resolves.toMatchObject({
      state: "applied",
      executionReceipt: { receipt: { reconciled: true } },
    });
    expect(dispatches).toBe(0);
  });

  it("reconciles an ambiguous timeout after Slack applied the update without dispatching twice", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const timedOutAfterApply: ActionExecutor = {
      getSlackCardVersion: executor.getSlackCardVersion,
      executeSlackCardUpdate: async () => {
        const error = new Error("request timed out after dispatch");
        Object.assign(error, { code: "ETIMEDOUT" });
        throw error;
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };

    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        timedOutAfterApply,
      ),
    ).rejects.toMatchObject({ code: "action_reconciliation_pending" });
    await expect(service.getActionPlan(approved.id, actor("owner-1"))).resolves.toMatchObject({
      state: "dispatching",
    });

    let redispatches = 0;
    const afterStateReconciler: ActionExecutor = {
      getSlackCardVersion: async (action) =>
        hashExternalState({ text: action.afterFallbackText, blocks: action.afterBlocks }),
      executeSlackCardUpdate: async () => {
        redispatches += 1;
        return { receipt: { ok: true } };
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        afterStateReconciler,
      ),
    ).resolves.toMatchObject({
      state: "applied",
      executionReceipt: { receipt: { reconciled: true } },
    });
    expect(redispatches).toBe(0);
  });

  it("safely retries an ambiguous timeout after confirming Slack retained the before state", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const timeoutBeforeApply: ActionExecutor = {
      getSlackCardVersion: executor.getSlackCardVersion,
      executeSlackCardUpdate: async () => {
        const error = new Error("request timed out before a response");
        Object.assign(error, { code: "ETIMEDOUT" });
        throw error;
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        timeoutBeforeApply,
      ),
    ).rejects.toMatchObject({ code: "action_reconciliation_pending" });

    let safeDispatches = 0;
    const beforeStateReconciler: ActionExecutor = {
      getSlackCardVersion: executor.getSlackCardVersion,
      executeSlackCardUpdate: async (action) => {
        safeDispatches += 1;
        return {
          receipt: { ok: true },
          externalVersion: hashExternalState({
            text: action.afterFallbackText,
            blocks: action.afterBlocks,
          }),
        };
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        beforeStateReconciler,
      ),
    ).resolves.toMatchObject({ state: "applied" });
    expect(safeDispatches).toBe(1);
  });

  it("keeps an uncertain dispatch recoverable when card inspection is temporarily unavailable", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const ambiguousExecutor: ActionExecutor = {
      getSlackCardVersion: executor.getSlackCardVersion,
      executeSlackCardUpdate: async () => {
        throw Object.assign(new Error("socket closed without a response"), {
          code: "ECONNRESET",
        });
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        ambiguousExecutor,
      ),
    ).rejects.toMatchObject({ code: "action_reconciliation_pending" });

    let redispatches = 0;
    const unavailableReconciler: ActionExecutor = {
      getSlackCardVersion: async () => {
        throw Object.assign(new Error("Slack is temporarily unavailable"), {
          code: "slack_unavailable",
        });
      },
      executeSlackCardUpdate: async () => {
        redispatches += 1;
        return { receipt: { ok: true } };
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        unavailableReconciler,
      ),
    ).rejects.toMatchObject({ code: "action_reconciliation_pending" });
    await expect(service.getActionPlan(approved.id, actor("owner-1"))).resolves.toMatchObject({
      state: "dispatching",
    });
    expect(redispatches).toBe(0);
  });

  it("moves an uncertain dispatch to unknown when reconciliation matches neither exact state", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const ambiguousExecutor: ActionExecutor = {
      getSlackCardVersion: executor.getSlackCardVersion,
      executeSlackCardUpdate: async () => {
        throw Object.assign(new Error("socket closed without a response"), {
          code: "ECONNRESET",
        });
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        ambiguousExecutor,
      ),
    ).rejects.toMatchObject({ code: "action_reconciliation_pending" });

    let redispatches = 0;
    const conflictingStateReconciler: ActionExecutor = {
      getSlackCardVersion: async () => "a-third-state",
      executeSlackCardUpdate: async () => {
        redispatches += 1;
        return { receipt: { ok: true } };
      },
      rollbackSlackCardUpdate: executor.rollbackSlackCardUpdate,
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        conflictingStateReconciler,
      ),
    ).rejects.toMatchObject({ code: "action_state_unknown" });
    await expect(service.getActionPlan(approved.id, actor("owner-1"))).resolves.toMatchObject({
      state: "unknown",
    });
    expect(redispatches).toBe(0);
  });

  it("reconciles a crash after Slack restored a card without restoring it twice", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const applied = await service.executeApprovedAction(
      approved.id,
      actor("owner-1"),
      timestamp,
      approved.planHash,
      executor,
    );
    const compensating = {
      ...applied,
      state: "compensating" as const,
      version: applied.version + 1,
    };
    await store.updateActionPlan(compensating, applied.version);
    let restores = 0;
    const reconciler: ActionExecutor = {
      getSlackCardVersion: async (action) =>
        hashExternalState({ text: action.beforeFallbackText, blocks: action.beforeBlocks }),
      executeSlackCardUpdate: async () => ({ receipt: { ok: true } }),
      rollbackSlackCardUpdate: async () => {
        restores += 1;
        return { receipt: { ok: true } };
      },
    };

    await expect(
      service.rollbackAction(compensating.id, actor("owner-1"), undefined, reconciler),
    ).resolves.toMatchObject({
      state: "compensated",
      compensationReceipt: { receipt: { reconciled: true } },
    });
    expect(restores).toBe(0);
  });

  it("reports an applied external effect honestly when its projection is incomplete", async () => {
    const store = new ToggleProjectionStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    store.failProjection = true;

    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        executor,
      ),
    ).rejects.toThrow("Slack applied the update");
    await expect(service.getActionPlan(approved.id, actor("owner-1"))).resolves.toMatchObject({
      state: "applied",
      executionReceipt: { actionPlanId: approved.id },
    });

    store.failProjection = false;
    const replayGuard: ActionExecutor = {
      getSlackCardVersion: async () => {
        throw new Error("An already applied job must not redispatch.");
      },
      executeSlackCardUpdate: async () => {
        throw new Error("An already applied job must not redispatch.");
      },
      rollbackSlackCardUpdate: async () => {
        throw new Error("Not used");
      },
    };
    await expect(
      service.executeApprovedAction(
        approved.id,
        actor("owner-1"),
        timestamp,
        approved.planHash,
        replayGuard,
      ),
    ).resolves.toMatchObject({ state: "applied" });
    await expect(service.getOutcome(active.id, actor("owner-1"))).resolves.toMatchObject({
      contract: {
        evidence: expect.arrayContaining([
          expect.objectContaining({ id: `execution:${approved.id}`, freshness: "fresh" }),
        ]),
      },
    });
  });

  it("retains a compensation receipt when the restored projection is incomplete", async () => {
    const store = new ToggleProjectionStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);
    const plan = await service.previewSlackCardUpdate(
      active.id,
      actor("owner-1"),
      timestamp,
      [{ type: "section", text: { type: "plain_text", text: "After" } }],
      "After",
    );
    const approved = await service.approveAction(plan.id, actor("reviewer-1"), timestamp);
    const applied = await service.executeApprovedAction(
      approved.id,
      actor("owner-1"),
      timestamp,
      approved.planHash,
      executor,
    );
    store.failProjection = true;

    await expect(
      service.rollbackAction(
        applied.id,
        actor("owner-1"),
        applied.executionReceipt?.externalVersion,
        executor,
      ),
    ).rejects.toThrow("Slack restored the previous card");
    await expect(service.getActionPlan(applied.id, actor("owner-1"))).resolves.toMatchObject({
      state: "compensated",
      compensationReceipt: { actionPlanId: applied.id },
    });

    store.failProjection = false;
    const replayGuard: ActionExecutor = {
      getSlackCardVersion: async () => {
        throw new Error("An already compensated job must not query Slack again.");
      },
      executeSlackCardUpdate: async () => {
        throw new Error("Not used");
      },
      rollbackSlackCardUpdate: async () => {
        throw new Error("An already compensated job must not restore twice.");
      },
    };
    await expect(
      service.rollbackAction(applied.id, actor("owner-1"), undefined, replayGuard),
    ).resolves.toMatchObject({ state: "compensated" });
    await expect(service.getOutcome(active.id, actor("owner-1"))).resolves.toMatchObject({
      contract: {
        evidence: expect.arrayContaining([
          expect.objectContaining({ id: `execution:${applied.id}`, freshness: "stale" }),
        ]),
      },
    });
  });

  it("cancels a pending ownership request and rejects a stale acceptance", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: sharedAudience,
      at: timestamp,
    });

    const cancelled = await service.cancelOutcome(
      created.id,
      actor("creator-1"),
      timestamp,
      "Requester withdrew the owner request.",
    );

    expect(cancelled.state).toBe("cancelled");
    await expect(service.getAssessment(created.id, actor("creator-1"))).resolves.toMatchObject({
      state: "cancelled",
      reason: expect.stringContaining("without claiming completion"),
      nextMove: "No further action is scheduled for this outcome.",
    });
    await expect(service.acceptOwnership(created.id, actor("owner-1"), timestamp)).rejects.toThrow(
      "no longer pending",
    );
  });

  it("reassigns a declined request through a reconfirmed contract and fresh owner acceptance", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: sharedAudience,
      at: timestamp,
    });
    const declined = await service.declineOwnership(
      created.id,
      actor("owner-1"),
      "2026-07-12T12:01:00.000Z",
      "I cannot own this result.",
    );
    const reassignedContract: OutcomeContract = {
      ...sharedContract,
      accountableOwnerPrincipalId: "owner-2",
      nextMove: { description: "Review the release notes.", actorPrincipalId: "owner-2" },
      participants: [
        { principalId: "owner-2", roles: ["owner"] },
        { principalId: "creator-1", roles: ["requester"] },
        { principalId: "reviewer-1", roles: ["contributor"] },
      ],
    };
    const reassignedAudience: AuthorizedAudience = {
      grants: [
        ...sharedAudience.grants.filter(
          (grant) => grant.subject.kind !== "principal" || grant.subject.principalId !== "owner-1",
        ),
        {
          id: "owner-2",
          subject: { kind: "principal", principalId: "owner-2" },
          permissions: ["view", "edit", "execute", "evidence_access"],
        },
      ],
    };
    const reassignedAt = "2026-07-12T12:02:00.000Z";

    const reassigned = await service.reassignDeclinedOwnership(
      declined.id,
      actor("creator-1"),
      reassignedAt,
      {
        contract: reassignedContract,
        provenance: confirmedProvenance,
        audience: reassignedAudience,
        reason: "  The first proposed owner declined.  ",
      },
    );

    expect(reassigned).toMatchObject({
      state: "awaiting_owner_acceptance",
      version: declined.version + 1,
      contractVersion: declined.contractVersion + 1,
      contract: { accountableOwnerPrincipalId: "owner-2" },
      ownerAcceptance: {
        requestedOwnerPrincipalId: "owner-2",
        status: "pending",
      },
    });
    expect(reassigned.ownerAcceptance).not.toHaveProperty("declineReason");
    await expect(
      service.acceptOwnership(created.id, actor("owner-1"), reassignedAt),
    ).rejects.toThrow("Only the proposed owner");
    await expect(
      service.acceptOwnership(created.id, actor("owner-2"), "2026-07-12T12:03:00.000Z"),
    ).resolves.toMatchObject({ state: "active" });

    const audit = await store.listAudit(created.id, created.workspaceId);
    expect(audit.find((event) => event.type === "ownership.reassigned")?.details).toEqual({
      previousRequestedOwnerPrincipalId: "owner-1",
      requestedOwnerPrincipalId: "owner-2",
      reason: "The first proposed owner declined.",
    });
  });

  it("fails closed when a declined-owner reassignment is stale, unchanged, or not creator-authorized", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: sharedAudience,
      at: timestamp,
    });
    const declined = await service.declineOwnership(
      created.id,
      actor("owner-1"),
      "2026-07-12T12:01:00.000Z",
      "I cannot own this result.",
    );
    const unchanged = {
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: sharedAudience,
      reason: "Try again.",
    };

    await expect(
      service.reassignDeclinedOwnership(declined.id, actor("owner-1"), timestamp, unchanged),
    ).rejects.toThrow("Only the outcome creator");
    await expect(
      service.reassignDeclinedOwnership(declined.id, actor("creator-1"), timestamp, unchanged),
    ).rejects.toThrow("different proposed owner");
    await expect(
      service.reassignDeclinedOwnership(created.id, actor("creator-1"), timestamp, {
        ...unchanged,
        reason: "   ",
      }),
    ).rejects.toThrow("reason");

    const current = await service.getOutcome(created.id, actor("creator-1"));
    expect(current).toMatchObject({
      state: "clarified",
      version: declined.version,
      contractVersion: declined.contractVersion,
      ownerAcceptance: { status: "declined" },
    });
  });

  it("rejects reassignment unless the replacement contract is fully reconfirmed and audience-safe", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: sharedAudience,
      at: timestamp,
    });
    const declined = await service.declineOwnership(
      created.id,
      actor("owner-1"),
      "2026-07-12T12:01:00.000Z",
      "I cannot own this result.",
    );
    const replacementContract: OutcomeContract = {
      ...sharedContract,
      accountableOwnerPrincipalId: "owner-2",
      nextMove: { ...sharedContract.nextMove, actorPrincipalId: "owner-2" },
      participants: [
        { principalId: "owner-2", roles: ["owner"] },
        { principalId: "creator-1", roles: ["requester"] },
        { principalId: "reviewer-1", roles: ["contributor"] },
      ],
    };
    const replacementAudience: AuthorizedAudience = {
      grants: [
        ...sharedAudience.grants.filter(
          (grant) => grant.subject.kind !== "principal" || grant.subject.principalId !== "owner-1",
        ),
        {
          id: "owner-2",
          subject: { kind: "principal", principalId: "owner-2" },
          permissions: ["view", "edit", "execute", "evidence_access"],
        },
      ],
    };

    await expect(
      service.reassignDeclinedOwnership(declined.id, actor("creator-1"), timestamp, {
        contract: replacementContract,
        provenance: confirmedProvenance.filter((entry) => entry.field !== "privacyScope"),
        audience: replacementAudience,
        reason: "Select a replacement owner.",
      }),
    ).rejects.toThrow("confirmation of: privacyScope");
    await expect(
      service.reassignDeclinedOwnership(declined.id, actor("creator-1"), timestamp, {
        contract: replacementContract,
        provenance: confirmedProvenance,
        audience: {
          grants: [
            ...replacementAudience.grants,
            {
              id: "leaked-channel",
              subject: { kind: "channel", channelId: "C-private" },
              permissions: ["view"],
            },
          ],
        },
        reason: "Select a replacement owner.",
      }),
    ).rejects.toThrow("selected-people");

    await expect(service.getOutcome(declined.id, actor("creator-1"))).resolves.toMatchObject({
      state: "clarified",
      version: declined.version,
      contractVersion: declined.contractVersion,
      ownerAcceptance: { status: "declined" },
    });
  });

  it("permits only one concurrent reassignment of the same declined owner request", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const created = await service.createConfirmedOutcome({
      actor: actor("creator-1"),
      type: "request",
      contract: sharedContract,
      provenance: confirmedProvenance,
      audience: sharedAudience,
      at: timestamp,
    });
    await service.declineOwnership(
      created.id,
      actor("owner-1"),
      "2026-07-12T12:01:00.000Z",
      "I cannot own this result.",
    );
    const reassignmentFor = (newOwnerPrincipalId: string) => ({
      contract: {
        ...sharedContract,
        accountableOwnerPrincipalId: newOwnerPrincipalId,
        nextMove: {
          ...sharedContract.nextMove,
          actorPrincipalId: newOwnerPrincipalId,
        },
        participants: [
          { principalId: newOwnerPrincipalId, roles: ["owner" as const] },
          { principalId: "creator-1", roles: ["requester" as const] },
          { principalId: "reviewer-1", roles: ["contributor" as const] },
        ],
      },
      provenance: confirmedProvenance,
      audience: {
        grants: [
          ...sharedAudience.grants.filter(
            (grant) =>
              grant.subject.kind !== "principal" || grant.subject.principalId !== "owner-1",
          ),
          {
            id: newOwnerPrincipalId,
            subject: { kind: "principal" as const, principalId: newOwnerPrincipalId },
            permissions: [
              "view" as const,
              "edit" as const,
              "execute" as const,
              "evidence_access" as const,
            ],
          },
        ],
      },
      reason: `Reassign to ${newOwnerPrincipalId}.`,
    });

    const results = await Promise.allSettled([
      service.reassignDeclinedOwnership(
        created.id,
        actor("creator-1"),
        "2026-07-12T12:02:00.000Z",
        reassignmentFor("owner-2"),
      ),
      service.reassignDeclinedOwnership(
        created.id,
        actor("creator-1"),
        "2026-07-12T12:02:00.000Z",
        reassignmentFor("owner-3"),
      ),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(service.getOutcome(created.id, actor("creator-1"))).resolves.toMatchObject({
      state: "awaiting_owner_acceptance",
      ownerAcceptance: { status: "pending" },
    });
  });

  it("grants explicit delegate access without allowing subdelegation", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const delegated = await service.delegateOwnerAuthority(
      active.id,
      actor("owner-1"),
      "delegate-1",
      ["act_as_owner", "execute", "close"],
      timestamp,
    );

    expect(delegated.delegations).toHaveLength(1);
    expect(
      delegated.contract.participants?.find(
        (participant) => participant.principalId === "delegate-1",
      )?.roles,
    ).toContain("delegate");
    expect(
      delegated.audience.grants.find(
        (grant) => grant.subject.kind === "principal" && grant.subject.principalId === "delegate-1",
      )?.permissions,
    ).toEqual(expect.arrayContaining(["view", "edit", "execute", "evidence_access"]));

    const retried = await service.delegateOwnerAuthority(
      active.id,
      actor("owner-1"),
      "delegate-1",
      ["close", "execute", "act_as_owner"],
      timestamp,
    );
    expect(retried.version).toBe(delegated.version);
    expect(retried.delegations).toHaveLength(1);

    await expect(
      service.delegateOwnerAuthority(
        active.id,
        actor("delegate-1"),
        "delegate-2",
        ["act_as_owner"],
        timestamp,
      ),
    ).rejects.toThrow("accountable owner");
  });

  it("records a versioned correction but requires a separate ownership transfer", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const ownerConfirmedProvenance = confirmedProvenance.map((entry) => ({
      ...entry,
      confirmedByPrincipalId: "owner-1",
    }));
    await expect(
      service.correctOutcome(active.id, actor("owner-1"), timestamp, {
        contract: { ...sharedContract, goal: "Unconfirmed correction." },
        provenance: confirmedProvenance,
        audience: sharedAudience,
        reason: "This must fail confirmation checks.",
      }),
    ).rejects.toThrow("confirmation");
    const correctedAudience: AuthorizedAudience = {
      grants: sharedAudience.grants.map((grant) =>
        grant.subject.kind === "principal" && grant.subject.principalId === "creator-1"
          ? { ...grant, permissions: [...grant.permissions, "execute" as const] }
          : grant,
      ),
    };
    const corrected = await service.correctOutcome(active.id, actor("owner-1"), timestamp, {
      contract: {
        ...sharedContract,
        goal: "Get a verified release review.",
        nextMove: { description: "Publish the verified review.", actorPrincipalId: "creator-1" },
      },
      provenance: ownerConfirmedProvenance,
      audience: correctedAudience,
      reason: "Clarified the observable result.",
    });

    expect(corrected.contract.goal).toBe("Get a verified release review.");
    expect(corrected.contract.nextMove?.actorPrincipalId).toBe("creator-1");
    expect(corrected.audience).toEqual(correctedAudience);
    expect(corrected.contractVersion).toBe(active.contractVersion + 1);
    await expect(
      service.correctOutcome(active.id, actor("owner-1"), timestamp, {
        contract: {
          ...sharedContract,
          accountableOwnerPrincipalId: "creator-1",
          participants: [
            { principalId: "creator-1", roles: ["owner", "requester"] },
            { principalId: "reviewer-1", roles: ["contributor"] },
          ],
        },
        provenance: ownerConfirmedProvenance,
        audience: sharedAudience,
        reason: "Attempted owner change.",
      }),
    ).rejects.toThrow("ownership-transfer");
  });

  it("reopens an owner-attested closure and invalidates its former closure evidence", async () => {
    const service = new OutcomeService(new InMemoryOutcomeStore());
    const active = await createActiveSharedOutcome(service);
    const evidenced = await service.recordEvidence(
      active.id,
      actor("owner-1"),
      {
        id: "closure-evidence-reopen",
        kind: "completion_record",
        label: "Completion was initially verified",
        locator: "https://example.test/completion/reopen",
        observedAt: timestamp,
        freshness: "fresh",
        verification: {
          method: "authorized_user_attestation",
          verifiedAt: timestamp,
          verifiedByPrincipalId: "owner-1",
        },
      },
      timestamp,
    );
    await service.requestClosure(evidenced.id, actor("owner-1"), timestamp);
    const closed = await service.verifyAndClose(evidenced.id, actor("owner-1"), timestamp, [
      "closure-evidence-reopen",
    ]);
    await expect(service.getAssessment(closed.id, actor("owner-1"))).resolves.toMatchObject({
      state: "closed",
      reason: expect.stringContaining("type-appropriate completion evidence"),
    });
    const reopened = await service.reopenOutcome(
      closed.id,
      actor("owner-1"),
      "2026-07-12T12:05:00.000Z",
      "The completion reference was invalidated.",
    );

    expect(reopened.state).toBe("active");
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.closureEvidenceIds).toBeUndefined();
    expect(
      reopened.contract.evidence?.find((evidence) => evidence.id === "closure-evidence-reopen")
        ?.freshness,
    ).toBe("stale");
    const retried = await service.reopenOutcome(
      reopened.id,
      actor("owner-1"),
      "2026-07-12T12:05:00.000Z",
      "The completion reference was invalidated.",
    );
    expect(retried.version).toBe(reopened.version);
  });

  it("deletes private content while retaining a non-sensitive audit tombstone", async () => {
    const store = new InMemoryOutcomeStore();
    const service = new OutcomeService(store);
    const active = await createActiveSharedOutcome(service);

    await expect(
      service.deleteOutcome(active.id, actor("owner-1"), timestamp, "privacy_request"),
    ).rejects.toThrow("creator");
    await service.deleteOutcome(active.id, actor("creator-1"), timestamp, "privacy_request");

    await expect(service.getOutcome(active.id, actor("owner-1"))).rejects.toThrow(
      "no longer exists",
    );
    const audit = await store.listAudit(active.id, active.workspaceId);
    const tombstone = audit.find((event) => event.type === "outcome.deleted_tombstone");
    expect(tombstone?.details).toMatchObject({
      priorState: "active",
      outcomeType: "request",
      reasonCode: "privacy_request",
    });
    expect(tombstone?.details).not.toHaveProperty("goal");
  });
});
