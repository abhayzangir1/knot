import { randomUUID } from "node:crypto";

import {
  type ActionPlan,
  type ActorContext,
  type AudiencePermission,
  type AuthorityPolicy,
  type AuthorizedAudience,
  assertApprovalSeparationOfDuty,
  assertAudienceRespectsPrivacyScope,
  assertAuthority,
  assertClosureReadiness,
  assertCompensationCanProceed,
  assertCompleteOutcomeContract,
  assertExecutablePlan,
  type ContractFieldProvenance,
  createActionPlan,
  type DelegationPermission,
  DelegationSchema,
  defaultAuthorityPolicy,
  type EvidenceReference,
  type ExecutionReceipt,
  hashExternalState,
  isDelegationActive,
  type Outcome,
  type OutcomeContract,
  OutcomeDomainError,
  type OutcomeType,
  type PrivacyScope,
  transitionOutcome,
} from "../outcomes/index.js";
import type { OutcomeStore, SlackCardReference } from "./outcome-store.js";

export type CreateConfirmedOutcomeInput = {
  id?: string;
  actor: ActorContext;
  type: OutcomeType;
  contract: OutcomeContract;
  provenance: readonly ContractFieldProvenance[];
  audience: AuthorizedAudience;
  at: string;
};

export type CorrectOutcomeInput = {
  contract: OutcomeContract;
  provenance: readonly ContractFieldProvenance[];
  audience: AuthorizedAudience;
  reason: string;
};

export type ReassignDeclinedOwnershipInput = {
  contract: OutcomeContract;
  provenance: readonly ContractFieldProvenance[];
  audience: AuthorizedAudience;
  reason: string;
};

export type OutcomeAssessment = {
  state: Outcome["state"];
  reason: string;
  nextMove: string;
  evidenceStatus: "available" | "missing" | "stale" | "conflicting";
};

export type SlackCardUpdateAction = {
  kind: "slack.card.update";
  channelId: string;
  messageTs: string;
  beforeBlocks: readonly Record<string, unknown>[];
  afterBlocks: readonly Record<string, unknown>[];
  beforeFallbackText: string;
  afterFallbackText: string;
};

export type ActionPlanBinding = {
  actionPlanId: string;
  idempotencyKey: string;
};

export interface ActionExecutor {
  getSlackCardVersion(action: SlackCardUpdateAction): Promise<string | undefined>;
  executeSlackCardUpdate(action: SlackCardUpdateAction): Promise<{
    receipt: Record<string, unknown>;
    externalVersion?: string;
  }>;
  rollbackSlackCardUpdate(action: SlackCardUpdateAction): Promise<{
    receipt: Record<string, unknown>;
    externalVersion?: string;
  }>;
}

const MUTABLE_WORKING_STATES: ReadonlySet<Outcome["state"]> = new Set([
  "active",
  "waiting",
  "at_risk",
  "blocked",
]);

function externalFailureCode(error: unknown): string {
  if (error instanceof OutcomeDomainError) {
    return error.code;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const directCode = record.code;
    if (typeof directCode === "string" && /^[a-z0-9_.-]{1,120}$/iu.test(directCode)) {
      return directCode;
    }
    const data = record.data;
    if (data && typeof data === "object") {
      const providerCode = (data as Record<string, unknown>).error;
      if (typeof providerCode === "string" && /^[a-z0-9_.-]{1,120}$/iu.test(providerCode)) {
        return providerCode;
      }
    }
  }
  return error instanceof Error ? error.name.slice(0, 120) : "unknown_error";
}

export class OutcomeService {
  public constructor(
    private readonly store: OutcomeStore,
    private readonly policy: AuthorityPolicy = defaultAuthorityPolicy,
  ) {}

  public async createConfirmedOutcome(input: CreateConfirmedOutcomeInput): Promise<Outcome> {
    return this.store.transaction(async () => {
      const contract = assertCompleteOutcomeContract(input.contract);
      this.assertSharedContractConfirmed(
        input.provenance,
        contract.privacyScope,
        input.actor.principalId,
      );

      const outcome: Outcome = {
        id: input.id ?? randomUUID(),
        workspaceId: input.actor.workspaceId,
        createdByPrincipalId: input.actor.principalId,
        type: input.type,
        state: "awaiting_owner_acceptance",
        contract,
        contractFieldProvenance: [...input.provenance],
        ownerAcceptance: {
          requestedOwnerPrincipalId: contract.accountableOwnerPrincipalId,
          status: "pending",
        },
        audience: input.audience,
        connectedSystems: [],
        delegations: [],
        version: 1,
        contractVersion: 1,
        createdAt: input.at,
        updatedAt: input.at,
      };

      await this.store.createOutcome(outcome);
      await this.record(outcome, input.actor, "outcome.created", { type: outcome.type });
      return outcome;
    });
  }

  public async acceptOwnership(
    outcomeId: string,
    actor: ActorContext,
    at: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "accept_ownership", at);
      if (
        current.state !== "awaiting_owner_acceptance" ||
        current.ownerAcceptance.status !== "pending"
      ) {
        throw new OutcomeDomainError(
          "ownership_request_not_pending",
          "This ownership request is no longer pending.",
        );
      }

      const accepted: Outcome = {
        ...current,
        ownerAcceptance: {
          requestedOwnerPrincipalId: current.ownerAcceptance.requestedOwnerPrincipalId,
          status: "accepted",
          respondedByPrincipalId: actor.principalId,
          respondedAt: at,
        },
        version: current.version + 1,
        updatedAt: at,
      };

      const active = transitionOutcome(accepted, {
        to: "active",
        at,
        actorPrincipalId: actor.principalId,
      });
      await this.store.updateOutcome(active, current.version);
      await this.record(active, actor, "ownership.accepted", {});
      return active;
    });
  }

  public async declineOwnership(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    reason: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "accept_ownership", at);
      if (
        current.state !== "awaiting_owner_acceptance" ||
        current.ownerAcceptance.status !== "pending"
      ) {
        throw new OutcomeDomainError(
          "ownership_request_not_pending",
          "This ownership request is no longer pending.",
        );
      }

      const declined: Outcome = {
        ...current,
        state: "clarified",
        ownerAcceptance: {
          requestedOwnerPrincipalId: current.ownerAcceptance.requestedOwnerPrincipalId,
          status: "declined",
          respondedByPrincipalId: actor.principalId,
          respondedAt: at,
          declineReason: reason,
        },
        version: current.version + 1,
        updatedAt: at,
      };
      await this.store.updateOutcome(declined, current.version);
      await this.record(declined, actor, "ownership.declined", { reason });
      return declined;
    });
  }

  public async reassignDeclinedOwnership(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    reassignment: ReassignDeclinedOwnershipInput,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "edit", at);
      if (current.createdByPrincipalId !== actor.principalId) {
        throw new OutcomeDomainError(
          "ownership_reassignment_forbidden",
          "Only the outcome creator may reassign a declined ownership request.",
        );
      }
      if (current.state !== "clarified" || current.ownerAcceptance.status !== "declined") {
        throw new OutcomeDomainError(
          "ownership_decline_missing",
          "Only a declined ownership request can be reassigned.",
        );
      }

      const reason = reassignment.reason.trim();
      if (reason.length === 0 || reason.length > 1_000) {
        throw new OutcomeDomainError(
          "ownership_reassignment_reason_invalid",
          "Ownership reassignment needs a reason of at most 1,000 characters.",
        );
      }

      const contract = assertCompleteOutcomeContract(reassignment.contract);
      if (
        contract.accountableOwnerPrincipalId === current.ownerAcceptance.requestedOwnerPrincipalId
      ) {
        throw new OutcomeDomainError(
          "ownership_reassignment_unchanged",
          "Choose a different proposed owner after an ownership decline.",
        );
      }
      this.assertSharedContractConfirmed(
        reassignment.provenance,
        contract.privacyScope,
        current.createdByPrincipalId,
      );

      const reassignedDraft: Outcome = {
        ...current,
        contract,
        contractFieldProvenance: [...reassignment.provenance],
        ownerAcceptance: {
          requestedOwnerPrincipalId: contract.accountableOwnerPrincipalId,
          status: "pending",
        },
        audience: reassignment.audience,
        delegations: current.delegations.map((delegation) =>
          delegation.status === "active"
            ? { ...delegation, status: "revoked" as const }
            : delegation,
        ),
        contractVersion: current.contractVersion + 1,
      };
      assertAudienceRespectsPrivacyScope(reassignedDraft);
      const reassigned = transitionOutcome(reassignedDraft, {
        to: "awaiting_owner_acceptance",
        at,
        actorPrincipalId: actor.principalId,
      });

      await this.store.updateOutcome(reassigned, current.version);
      await this.record(reassigned, actor, "ownership.reassigned", {
        previousRequestedOwnerPrincipalId: current.ownerAcceptance.requestedOwnerPrincipalId,
        requestedOwnerPrincipalId: contract.accountableOwnerPrincipalId,
        reason,
      });
      return reassigned;
    });
  }

  public async cancelOutcome(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    reason: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "edit", at);
      if (current.state === "closed" || current.state === "cancelled") {
        throw new OutcomeDomainError(
          "outcome_not_cancellable",
          "A closed or already cancelled outcome cannot be cancelled.",
        );
      }
      const cancelled = transitionOutcome(current, {
        to: "cancelled",
        at,
        actorPrincipalId: actor.principalId,
      });
      await this.store.updateOutcome(cancelled, current.version);
      await this.record(cancelled, actor, "outcome.cancelled", { reason });
      return cancelled;
    });
  }

  public async delegateOwnerAuthority(
    outcomeId: string,
    actor: ActorContext,
    delegatePrincipalId: string,
    permissions: readonly DelegationPermission[],
    at: string,
    expiresAt?: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "delegate", at);
      if (current.state === "closed" || current.state === "cancelled") {
        throw new OutcomeDomainError(
          "outcome_not_delegatable",
          "A closed or cancelled outcome cannot receive a new delegation.",
        );
      }
      const ownerPrincipalId = current.contract.accountableOwnerPrincipalId;
      if (!ownerPrincipalId) {
        throw new OutcomeDomainError("owner_missing", "The outcome has no accountable owner.");
      }
      const requestedPermissions = [...new Set(permissions)].sort();
      const existingEquivalentDelegation = current.delegations.find(
        (delegation) =>
          isDelegationActive(delegation, at) &&
          delegation.delegatorPrincipalId === ownerPrincipalId &&
          delegation.delegatePrincipalId === delegatePrincipalId &&
          delegation.grantedAt === at &&
          (delegation.expiresAt ?? undefined) === (expiresAt ?? undefined) &&
          [...delegation.permissions].sort().join("|") === requestedPermissions.join("|"),
      );
      if (existingEquivalentDelegation) {
        return current;
      }
      const delegation = DelegationSchema.parse({
        id: randomUUID(),
        delegatorPrincipalId: ownerPrincipalId,
        delegatePrincipalId,
        permissions: requestedPermissions,
        status: "active",
        grantedAt: at,
        ...(expiresAt ? { expiresAt } : {}),
      });
      const participants = [...(current.contract.participants ?? [])];
      const existingParticipant = participants.find(
        (participant) => participant.principalId === delegatePrincipalId,
      );
      if (existingParticipant) {
        if (!existingParticipant.roles.includes("delegate")) {
          existingParticipant.roles = [...existingParticipant.roles, "delegate"];
        }
      } else {
        participants.push({ principalId: delegatePrincipalId, roles: ["delegate"] });
      }
      const requiredAudiencePermissions = new Set<AudiencePermission>([
        "view",
        "edit",
        "evidence_access",
        ...(permissions.includes("execute") || permissions.includes("act_as_owner")
          ? (["execute"] as const)
          : []),
      ]);
      const audienceGrants = structuredClone(current.audience.grants);
      const existingGrant = audienceGrants.find(
        (grant) =>
          grant.subject.kind === "principal" && grant.subject.principalId === delegatePrincipalId,
      );
      if (existingGrant) {
        existingGrant.permissions = [
          ...new Set([...existingGrant.permissions, ...requiredAudiencePermissions]),
        ];
      } else {
        audienceGrants.push({
          id: `audience:${delegatePrincipalId}`,
          subject: { kind: "principal", principalId: delegatePrincipalId },
          permissions: [...requiredAudiencePermissions],
        });
      }
      const updated: Outcome = {
        ...current,
        contract: { ...current.contract, participants },
        contractFieldProvenance: current.contractFieldProvenance.map((entry) =>
          entry.field === "participants"
            ? {
                ...entry,
                source: "user" as const,
                confirmedByPrincipalId: actor.principalId,
                confirmedAt: at,
              }
            : entry,
        ),
        audience: { grants: audienceGrants },
        delegations: [...current.delegations, delegation],
        contractVersion: current.contractVersion + 1,
        version: current.version + 1,
        updatedAt: at,
      };
      assertAudienceRespectsPrivacyScope(updated);
      await this.store.updateOutcome(updated, current.version);
      await this.record(updated, actor, "outcome.delegated", {
        delegationId: delegation.id,
        delegatePrincipalId,
        permissions,
        expiresAt,
      });
      return updated;
    });
  }

  public async correctOutcome(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    correction: CorrectOutcomeInput,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "edit", at);
      if (current.state === "closed" || current.state === "cancelled") {
        throw new OutcomeDomainError(
          "outcome_not_correctable",
          "Reopen a closed outcome before correcting it; cancelled outcomes remain immutable.",
        );
      }
      const contract = assertCompleteOutcomeContract(correction.contract);
      const reason = correction.reason.trim();
      if (reason.length === 0 || reason.length > 1_000) {
        throw new OutcomeDomainError(
          "outcome_correction_reason_invalid",
          "Outcome correction needs a reason of at most 1,000 characters.",
        );
      }
      if (contract.accountableOwnerPrincipalId !== current.contract.accountableOwnerPrincipalId) {
        throw new OutcomeDomainError(
          "ownership_transfer_required",
          "Changing the accountable owner requires a separate ownership-transfer action.",
        );
      }
      this.assertSharedContractConfirmed(
        correction.provenance,
        contract.privacyScope,
        actor.principalId,
      );
      const corrected: Outcome = {
        ...current,
        contract,
        contractFieldProvenance: [...correction.provenance],
        audience: correction.audience,
        contractVersion: current.contractVersion + 1,
        version: current.version + 1,
        updatedAt: at,
      };
      assertAudienceRespectsPrivacyScope(corrected);
      await this.store.updateOutcome(corrected, current.version);
      await this.record(corrected, actor, "outcome.corrected", { reason });
      return corrected;
    });
  }

  public async reopenOutcome(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    reason: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "close", at);
      if (
        current.state === "active" &&
        current.updatedAt === at &&
        current.closureEvidenceIds === undefined
      ) {
        return current;
      }
      if (current.state !== "closed") {
        throw new OutcomeDomainError(
          "outcome_not_closed",
          "Only a closed outcome can be reopened.",
        );
      }
      const closureIds = new Set(current.closureEvidenceIds ?? []);
      const {
        closedAt: _closedAt,
        closedByPrincipalId: _closedBy,
        closureEvidenceIds,
        ...base
      } = current;
      const reopened: Outcome = {
        ...base,
        state: "active",
        contract: {
          ...current.contract,
          evidence: (current.contract.evidence ?? []).map((evidence) =>
            closureIds.has(evidence.id) ? { ...evidence, freshness: "stale" as const } : evidence,
          ),
        },
        contractVersion: current.contractVersion + 1,
        version: current.version + 1,
        updatedAt: at,
      };
      await this.store.updateOutcome(reopened, current.version);
      await this.record(reopened, actor, "outcome.reopened", {
        reason,
        invalidatedClosureEvidenceIds: closureEvidenceIds ?? [],
      });
      return reopened;
    });
  }

  public async deleteOutcome(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    reasonCode: "user_request" | "privacy_request",
  ): Promise<void> {
    await this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "edit", at);
      if (actor.principalId !== current.createdByPrincipalId && !actor.isWorkspaceAdmin) {
        throw new OutcomeDomainError(
          "outcome_deletion_forbidden",
          "Only the outcome creator or an authorized workspace administrator may delete its private content.",
        );
      }
      await this.record(current, actor, "outcome.deleted_tombstone", {
        outcomeReferenceHash: hashExternalState({
          workspaceId: current.workspaceId,
          outcomeId: current.id,
        }),
        priorState: current.state,
        outcomeType: current.type,
        reasonCode,
      });
      await this.store.deleteOutcome(current.id, current.workspaceId);
    });
  }

  public async getAssessment(outcomeId: string, actor: ActorContext): Promise<OutcomeAssessment> {
    const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "view", actor.authenticatedAt);

    if (outcome.state === "closed") {
      return {
        state: outcome.state,
        reason:
          "The authorized owner confirmed fresh, type-appropriate completion evidence. Knot verified policy metadata, not the external page contents.",
        nextMove: "No further action is required unless the accountable owner reopens it.",
        evidenceStatus: "available",
      };
    }

    if (outcome.state === "cancelled") {
      return {
        state: outcome.state,
        reason: "Coordination was cancelled without claiming completion.",
        nextMove: "No further action is scheduled for this outcome.",
        evidenceStatus: "available",
      };
    }

    if (outcome.state === "closure_requested") {
      return {
        state: outcome.state,
        reason:
          "A closure evidence reference was submitted and deterministic policy checks are pending.",
        nextMove:
          "Wait for policy validation; Knot will return the outcome to Active if the reference is invalid.",
        evidenceStatus: "available",
      };
    }

    if (outcome.state === "clarified") {
      return {
        state: outcome.state,
        reason:
          outcome.ownerAcceptance.status === "declined"
            ? "The proposed owner declined accountability, so the outcome is not active."
            : "The Outcome Contract needs correction before ownership can be requested again.",
        nextMove: "The requester should correct or cancel this outcome.",
        evidenceStatus: "available",
      };
    }

    if (outcome.state === "awaiting_owner_acceptance") {
      return {
        state: outcome.state,
        reason: "The proposed owner has not accepted accountability yet.",
        nextMove: "Ask the proposed owner to accept, decline, or suggest another person.",
        evidenceStatus: "available",
      };
    }

    const evidence = outcome.contract.evidence ?? [];
    if (evidence.some((item) => item.freshness === "conflicting")) {
      return {
        state: "at_risk",
        reason: "The available evidence conflicts.",
        nextMove: "Resolve the conflicting evidence before changing the outcome.",
        evidenceStatus: "conflicting",
      };
    }

    if (evidence.some((item) => item.freshness === "stale")) {
      return {
        state: "at_risk",
        reason: "The evidence is stale.",
        nextMove: "Refresh the evidence before taking a consequential action.",
        evidenceStatus: "stale",
      };
    }

    return {
      state: outcome.state,
      reason: "The Outcome Contract is complete and the owner has accepted accountability.",
      nextMove: outcome.contract.nextMove?.description ?? "Clarify the next move.",
      evidenceStatus: evidence.length > 0 ? "available" : "missing",
    };
  }

  public async getOutcome(outcomeId: string, actor: ActorContext): Promise<Outcome> {
    const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "view", actor.authenticatedAt);
    return outcome;
  }

  public async getOutcomeForEdit(outcomeId: string, actor: ActorContext): Promise<Outcome> {
    const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "edit", actor.authenticatedAt);
    return outcome;
  }

  public async getOutcomeForDelegation(outcomeId: string, actor: ActorContext): Promise<Outcome> {
    const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "delegate", actor.authenticatedAt);
    return outcome;
  }

  public async getActionPlan(actionPlanId: string, actor: ActorContext): Promise<ActionPlan> {
    const plan = await this.requirePlan(actionPlanId, actor.workspaceId);
    const outcome = await this.requireOutcome(plan.outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "view", actor.authenticatedAt);
    return plan;
  }

  public async getSlackCardReference(
    outcomeId: string,
    actor: ActorContext,
  ): Promise<SlackCardReference> {
    const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "view", actor.authenticatedAt);
    return this.requireCard(outcomeId, actor.workspaceId);
  }

  public async previewSlackCardUpdate(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    afterBlocks: readonly Record<string, unknown>[],
    afterFallbackText: string,
    binding?: ActionPlanBinding,
  ): Promise<ActionPlan> {
    return this.store.transaction(async () => {
      const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(outcome, actor, "execute", at);
      if (binding) {
        this.assertValidActionPlanBinding(binding);
        const existing = await this.store.getActionPlan(binding.actionPlanId, actor.workspaceId);
        if (existing) {
          if (
            existing.workspaceId !== actor.workspaceId ||
            existing.outcomeId !== outcome.id ||
            existing.createdByPrincipalId !== actor.principalId ||
            existing.executorPrincipalId !== actor.principalId ||
            existing.idempotencyKey !== binding.idempotencyKey
          ) {
            throw new OutcomeDomainError(
              "action_preview_binding_mismatch",
              "The action-preview retry binding belongs to a different command.",
            );
          }
          return existing;
        }
      }
      if (!MUTABLE_WORKING_STATES.has(outcome.state)) {
        throw new OutcomeDomainError(
          "action_preview_invalid_state",
          "A Slack card update may be prepared only while the outcome is in an active working state.",
        );
      }
      this.assertActorOwnsCurrentNextMove(outcome, actor, at);
      const card = await this.requireCard(outcomeId, actor.workspaceId);

      const action: SlackCardUpdateAction = {
        kind: "slack.card.update",
        channelId: card.channelId,
        messageTs: card.messageTs,
        beforeBlocks: card.blocks,
        afterBlocks,
        beforeFallbackText: card.fallbackText,
        afterFallbackText,
      };
      const plan = createActionPlan({
        ...(binding ? { id: binding.actionPlanId } : {}),
        workspaceId: outcome.workspaceId,
        outcomeId: outcome.id,
        outcomeVersion: outcome.version,
        contractVersion: outcome.contractVersion,
        createdByPrincipalId: actor.principalId,
        executorPrincipalId: actor.principalId,
        policyVersion: this.policy.version,
        evidenceSnapshotIds: outcome.contract.evidence?.map((evidence) => evidence.id) ?? [],
        beforeState: {
          card: {
            channelId: card.channelId,
            messageTs: card.messageTs,
            audience: card.audience,
            blocks: card.blocks,
            fallbackText: card.fallbackText,
          },
        },
        proposedActions: [action],
        reversibility: "reversible",
        idempotencyKey: binding?.idempotencyKey ?? randomUUID(),
        expiresAt: new Date(Date.parse(at) + 10 * 60 * 1000).toISOString(),
      });

      await this.store.saveActionPlan(plan);
      await this.record(outcome, actor, "action.previewed", {
        actionPlanId: plan.id,
        planHash: plan.planHash,
      });
      return plan;
    });
  }

  public async approveAction(
    actionPlanId: string,
    actor: ActorContext,
    at: string,
  ): Promise<ActionPlan> {
    return this.store.transaction(async () => {
      const plan = await this.requirePlan(actionPlanId, actor.workspaceId);
      const outcome = await this.requireOutcome(plan.outcomeId, actor.workspaceId);
      assertAuthority(outcome, actor, "approve", at);
      this.assertPlanMatchesCurrentOutcome(plan, outcome);
      assertApprovalSeparationOfDuty(
        actor,
        {
          requesterPrincipalId: outcome.createdByPrincipalId,
          executorPrincipalId: plan.executorPrincipalId,
          ...(outcome.contract.accountableOwnerPrincipalId
            ? { ownerPrincipalId: outcome.contract.accountableOwnerPrincipalId }
            : {}),
        },
        this.policy,
        this.isPersonalReversibleCardPlan(plan, outcome, actor),
      );

      if (plan.state !== "planned") {
        throw new OutcomeDomainError(
          "action_plan_not_planned",
          "Only a planned action can be approved.",
        );
      }
      if (at >= plan.expiresAt) {
        throw new OutcomeDomainError(
          "action_plan_expired",
          "The action preview expired and must be recreated before approval.",
        );
      }

      const approved: ActionPlan = {
        ...plan,
        state: "approved",
        version: plan.version + 1,
        approval: {
          approverPrincipalId: actor.principalId,
          approvedAt: at,
          policyVersion: this.policy.version,
          planHash: plan.planHash,
        },
      };
      await this.store.updateActionPlan(approved, plan.version);
      await this.record(outcome, actor, "action.approved", {
        actionPlanId: plan.id,
        approvedAt: at,
      });
      return approved;
    });
  }

  public async executeApprovedAction(
    actionPlanId: string,
    actor: ActorContext,
    at: string,
    approvalPlanHash: string,
    executor: ActionExecutor,
  ): Promise<ActionPlan> {
    let plan = await this.requirePlan(actionPlanId, actor.workspaceId);
    const outcome = await this.requireOutcome(plan.outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "execute", at);
    if (plan.executorPrincipalId !== actor.principalId) {
      throw new OutcomeDomainError(
        "execution_actor_mismatch",
        "Only the actor named in the approved plan may execute it.",
      );
    }
    const action = this.asSlackCardUpdate(plan);
    if (plan.state === "applied") {
      if (!plan.executionReceipt) {
        throw new OutcomeDomainError(
          "execution_receipt_missing",
          "An applied action is missing its durable execution receipt and requires reconciliation.",
        );
      }
      await this.ensureAppliedProjection(plan, outcome, actor, at, action);
      return plan;
    }
    if (plan.state === "dispatching" || plan.state === "unknown") {
      if (plan.planHash !== approvalPlanHash || !plan.approval) {
        throw new OutcomeDomainError(
          "approval_plan_hash_mismatch",
          "The dispatching action is not bound to this exact approved plan.",
        );
      }
      this.assertPlanMatchesCurrentOutcome(plan, outcome);
      let currentVersion: string | undefined;
      try {
        currentVersion = await executor.getSlackCardVersion(action);
      } catch (error) {
        await this.record(outcome, actor, "action.dispatch_reconciliation_unavailable", {
          actionPlanId: plan.id,
          errorCode: externalFailureCode(error),
        });
        throw new OutcomeDomainError(
          "action_reconciliation_pending",
          "Knot could not inspect the Slack card after an uncertain dispatch. It will not dispatch again until the external state can be reconciled.",
        );
      }
      const expectedBeforeVersion = hashExternalState({
        text: action.beforeFallbackText,
        blocks: action.beforeBlocks,
      });
      const expectedAfterVersion = hashExternalState({
        text: action.afterFallbackText,
        blocks: action.afterBlocks,
      });
      if (currentVersion === expectedAfterVersion) {
        return this.finalizeAppliedAction(plan, outcome, actor, at, action, {
          receipt: { reconciled: true, observedState: "approved_after_state" },
          externalVersion: currentVersion,
        });
      }
      if (currentVersion === expectedBeforeVersion) {
        const recovered: ActionPlan = {
          ...plan,
          state: "approved",
          version: plan.version + 1,
        };
        await this.store.updateActionPlan(recovered, plan.version);
        await this.record(outcome, actor, "action.dispatch_recovered_before_effect", {
          actionPlanId: plan.id,
        });
        plan = recovered;
      } else {
        if (plan.state !== "unknown") {
          const unknown: ActionPlan = { ...plan, state: "unknown", version: plan.version + 1 };
          await this.store.updateActionPlan(unknown, plan.version);
        }
        await this.record(outcome, actor, "action.dispatch_reconciliation_unknown", {
          actionPlanId: plan.id,
        });
        throw new OutcomeDomainError(
          "action_state_unknown",
          "Knot could not match the Slack card to the exact before or after state. It will not dispatch again; manual reconciliation is required.",
        );
      }
    }
    assertExecutablePlan(plan, outcome, at, approvalPlanHash);

    const expectedBeforeVersion = hashExternalState({
      text: action.beforeFallbackText,
      blocks: action.beforeBlocks,
    });
    let currentBeforeVersion: string | undefined;
    try {
      currentBeforeVersion = await executor.getSlackCardVersion(action);
    } catch (_error) {
      await this.failBeforeDispatch(plan, outcome, actor, "external_before_state_unavailable");
      throw new OutcomeDomainError(
        "external_before_state_unavailable",
        "Knot could not verify the current Slack card, so it did not execute the update.",
      );
    }
    if (!currentBeforeVersion || currentBeforeVersion !== expectedBeforeVersion) {
      await this.failBeforeDispatch(plan, outcome, actor, "external_before_state_changed");
      throw new OutcomeDomainError(
        "external_before_state_changed",
        "The Slack card changed after the preview. Knot did not overwrite it; prepare a new exact update.",
      );
    }

    const dispatching: ActionPlan = { ...plan, state: "dispatching", version: plan.version + 1 };
    await this.store.updateActionPlan(dispatching, plan.version);

    const dispatchingAction = this.asSlackCardUpdate(dispatching);
    let result: { receipt: Record<string, unknown>; externalVersion?: string };
    try {
      result = await executor.executeSlackCardUpdate(dispatchingAction);
    } catch (error) {
      await this.record(outcome, actor, "action.dispatch_ambiguous", {
        actionPlanId: dispatching.id,
        errorCode: externalFailureCode(error),
      });
      throw new OutcomeDomainError(
        "action_reconciliation_pending",
        "Slack may have received the update, but Knot did not receive a conclusive result. It will reconcile the exact card state before any retry.",
      );
    }

    return this.finalizeAppliedAction(dispatching, outcome, actor, at, dispatchingAction, result);
  }

  public async rollbackAction(
    actionPlanId: string,
    actor: ActorContext,
    currentExternalVersion: string | undefined,
    executor: ActionExecutor,
  ): Promise<ActionPlan> {
    let plan = await this.requirePlan(actionPlanId, actor.workspaceId);
    const outcome = await this.requireOutcome(plan.outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "execute", actor.authenticatedAt);
    if (plan.executorPrincipalId !== actor.principalId) {
      throw new OutcomeDomainError(
        "compensation_actor_mismatch",
        "Only the original executor named in the action plan may compensate this action.",
      );
    }
    const action = this.asSlackCardUpdate(plan);
    if (plan.state === "compensated") {
      if (!plan.compensationReceipt) {
        throw new OutcomeDomainError(
          "compensation_receipt_missing",
          "A compensated action is missing its durable compensation receipt.",
        );
      }
      await this.ensureCompensatedProjection(plan, outcome, actor, action);
      return plan;
    }
    const receipt = plan.executionReceipt;
    if (!receipt) {
      throw new OutcomeDomainError(
        "execution_receipt_missing",
        "Knot cannot compensate an action without its durable execution receipt.",
      );
    }
    if (plan.state === "compensating") {
      const observedVersion =
        currentExternalVersion ?? (await executor.getSlackCardVersion(action));
      const expectedBeforeVersion = hashExternalState({
        text: action.beforeFallbackText,
        blocks: action.beforeBlocks,
      });
      const expectedAfterVersion = hashExternalState({
        text: action.afterFallbackText,
        blocks: action.afterBlocks,
      });
      if (observedVersion === expectedBeforeVersion) {
        return this.finalizeCompensatedAction(plan, outcome, actor, action, {
          receipt: { reconciled: true, observedState: "restored_before_state" },
          externalVersion: observedVersion,
        });
      }
      if (observedVersion === (receipt.externalVersion ?? expectedAfterVersion)) {
        const recovered: ActionPlan = {
          ...plan,
          state: "applied",
          version: plan.version + 1,
        };
        await this.store.updateActionPlan(recovered, plan.version);
        await this.record(outcome, actor, "action.compensation_recovered_before_effect", {
          actionPlanId: plan.id,
        });
        plan = recovered;
      } else {
        const manual: ActionPlan = {
          ...plan,
          state: "manual_resolution",
          version: plan.version + 1,
        };
        await this.store.updateActionPlan(manual, plan.version);
        await this.record(outcome, actor, "action.compensation_reconciliation_unknown", {
          actionPlanId: plan.id,
        });
        throw new OutcomeDomainError(
          "compensation_state_unknown",
          "Knot could not match the Slack card to the exact applied or restored state. It will not restore again; manual reconciliation is required.",
        );
      }
    }
    const verifiedExternalVersion =
      currentExternalVersion ?? (await executor.getSlackCardVersion(action));
    assertCompensationCanProceed(plan, receipt, verifiedExternalVersion);

    const compensating: ActionPlan = { ...plan, state: "compensating", version: plan.version + 1 };
    await this.store.updateActionPlan(compensating, plan.version);
    let result: { receipt: Record<string, unknown>; externalVersion?: string };
    try {
      result = await executor.rollbackSlackCardUpdate(action);
    } catch (error) {
      const manual: ActionPlan = {
        ...compensating,
        state: "manual_resolution",
        version: compensating.version + 1,
      };
      await this.store.updateActionPlan(manual, compensating.version);
      await this.record(outcome, actor, "action.compensation_failed", {
        actionPlanId: plan.id,
        errorCode: externalFailureCode(error),
      });
      throw error;
    }

    return this.finalizeCompensatedAction(compensating, outcome, actor, action, result);
  }

  public async verifyAndClose(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    closureEvidenceIds: readonly string[],
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "close", at);
      if (current.state !== "closure_requested") {
        throw new OutcomeDomainError(
          "closure_not_requested",
          "Closure evidence must enter verification before the outcome can close.",
        );
      }
      assertClosureReadiness(current, closureEvidenceIds);
      const closed = transitionOutcome(current, {
        to: "closed",
        at,
        actorPrincipalId: actor.principalId,
        closureEvidenceIds,
      });
      await this.store.updateOutcome(closed, current.version);
      await this.record(closed, actor, "outcome.closed", { closureEvidenceIds });
      return closed;
    });
  }

  public async requestClosure(
    outcomeId: string,
    actor: ActorContext,
    at: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "close", at);
      if (!["active", "waiting", "at_risk", "blocked"].includes(current.state)) {
        throw new OutcomeDomainError(
          "closure_request_invalid_state",
          "Only an active working outcome can enter closure verification.",
        );
      }
      const requested = transitionOutcome(current, {
        to: "closure_requested",
        at,
        actorPrincipalId: actor.principalId,
      });
      await this.store.updateOutcome(requested, current.version);
      await this.record(requested, actor, "outcome.closure_requested", {});
      return requested;
    });
  }

  public async rejectClosure(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    reasonCode: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const current = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(current, actor, "close", at);
      if (current.state !== "closure_requested") {
        return current;
      }
      const active = transitionOutcome(current, {
        to: "active",
        at,
        actorPrincipalId: actor.principalId,
      });
      await this.store.updateOutcome(active, current.version);
      await this.record(active, actor, "outcome.closure_rejected", { reasonCode });
      return active;
    });
  }

  public async setSlackCardReference(
    outcomeId: string,
    actor: ActorContext,
    card: SlackCardReference,
  ): Promise<void> {
    const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
    assertAuthority(outcome, actor, "edit", actor.authenticatedAt);
    await this.store.setSlackCardReference(outcomeId, outcome.workspaceId, card);
  }

  /**
   * Closure may replace the owner's status projection only after the domain
   * transition has already been authorized and recorded. This is a state
   * projection, not a newly planned consequential action.
   */
  public async projectClosedSlackCard(
    outcomeId: string,
    actor: ActorContext,
    at: string,
    card: SlackCardReference,
  ): Promise<void> {
    await this.store.transaction(async () => {
      const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(outcome, actor, "close", at);
      if (outcome.state !== "closed") {
        throw new OutcomeDomainError(
          "outcome_not_closed",
          "Knot may project a closed card only after authorized owner attestation and deterministic closure validation.",
        );
      }
      await this.store.setSlackCardReference(outcomeId, outcome.workspaceId, card);
      await this.record(outcome, actor, "outcome.closed_card_projected", {
        channelId: card.channelId,
        messageTs: card.messageTs,
      });
    });
  }

  public async recordEvidence(
    outcomeId: string,
    actor: ActorContext,
    evidence: EvidenceReference,
    at: string,
  ): Promise<Outcome> {
    return this.store.transaction(async () => {
      const outcome = await this.requireOutcome(outcomeId, actor.workspaceId);
      assertAuthority(outcome, actor, "edit", at);
      return this.recordEvidenceInternal(outcome, actor, evidence, at);
    });
  }

  private async finalizeAppliedAction(
    dispatching: ActionPlan,
    outcome: Outcome,
    actor: ActorContext,
    at: string,
    action: SlackCardUpdateAction,
    result: { receipt: Record<string, unknown>; externalVersion?: string },
  ): Promise<ActionPlan> {
    const receipt: ExecutionReceipt = {
      actionPlanId: dispatching.id,
      ...(result.externalVersion ? { externalVersion: result.externalVersion } : {}),
      receipt: result.receipt,
    };
    let applied: ActionPlan = {
      ...dispatching,
      state: "applied",
      version: dispatching.version + 1,
      executionReceipt: receipt,
    };
    try {
      await this.store.updateActionPlan(applied, dispatching.version);
    } catch (error) {
      const latest = await this.requirePlan(dispatching.id, actor.workspaceId).catch(
        () => undefined,
      );
      if (latest?.state === "applied" && latest.executionReceipt) {
        applied = latest;
      } else {
        const unknown: ActionPlan = {
          ...dispatching,
          state: "unknown",
          version: dispatching.version + 1,
          executionReceipt: receipt,
        };
        await this.store.updateActionPlan(unknown, dispatching.version).catch(() => undefined);
        await this.record(outcome, actor, "action.unknown", {
          actionPlanId: dispatching.id,
          receipt: result.receipt,
          errorCode: externalFailureCode(error),
        });
        throw new OutcomeDomainError(
          "action_state_unknown",
          "Slack accepted the update, but Knot could not confirm its durable final state. Do not execute it again; manual reconciliation is required.",
        );
      }
    }

    await this.ensureAppliedProjection(applied, outcome, actor, at, action);
    return applied;
  }

  private async finalizeCompensatedAction(
    compensating: ActionPlan,
    outcome: Outcome,
    actor: ActorContext,
    action: SlackCardUpdateAction,
    result: { receipt: Record<string, unknown>; externalVersion?: string },
  ): Promise<ActionPlan> {
    const compensationReceipt: ExecutionReceipt = {
      actionPlanId: compensating.id,
      ...(result.externalVersion ? { externalVersion: result.externalVersion } : {}),
      receipt: result.receipt,
    };
    let compensated: ActionPlan = {
      ...compensating,
      state: "compensated",
      version: compensating.version + 1,
      compensationReceipt,
    };
    try {
      await this.store.updateActionPlan(compensated, compensating.version);
    } catch (error) {
      const latest = await this.requirePlan(compensating.id, actor.workspaceId).catch(
        () => undefined,
      );
      if (latest?.state === "compensated" && latest.compensationReceipt) {
        compensated = latest;
      } else {
        const manual: ActionPlan = {
          ...compensating,
          state: "manual_resolution",
          version: compensating.version + 1,
          compensationReceipt,
        };
        await this.store.updateActionPlan(manual, compensating.version).catch(() => undefined);
        await this.record(outcome, actor, "action.compensation_unknown", {
          actionPlanId: compensating.id,
          receipt: result.receipt,
          errorCode: externalFailureCode(error),
        });
        throw new OutcomeDomainError(
          "compensation_state_unknown",
          "Slack accepted the restore operation, but Knot could not confirm its durable final state. Do not restore it again; manual reconciliation is required.",
        );
      }
    }

    await this.ensureCompensatedProjection(compensated, outcome, actor, action);
    return compensated;
  }

  private async ensureCompensatedProjection(
    compensated: ActionPlan,
    outcome: Outcome,
    actor: ActorContext,
    action: SlackCardUpdateAction,
  ): Promise<void> {
    try {
      await this.store.transaction(async () => {
        const latestOutcome = await this.requireOutcome(outcome.id, outcome.workspaceId);
        await this.store.setSlackCardReference(outcome.id, outcome.workspaceId, {
          channelId: action.channelId,
          messageTs: action.messageTs,
          audience: this.cardAudience(compensated),
          blocks: action.beforeBlocks,
          fallbackText: action.beforeFallbackText,
        });
        const evidenceId = `execution:${compensated.id}`;
        const evidenceWasFresh = latestOutcome.contract.evidence?.some(
          (evidence) => evidence.id === evidenceId && evidence.freshness === "fresh",
        );
        if (!evidenceWasFresh) {
          return;
        }
        const correctedOutcome = await this.markEvidenceStaleInternal(
          latestOutcome,
          actor,
          evidenceId,
          actor.authenticatedAt,
        );
        await this.record(correctedOutcome, actor, "action.compensated", {
          actionPlanId: compensated.id,
          receipt: compensated.compensationReceipt?.receipt,
        });
      });
    } catch (error) {
      await this.record(outcome, actor, "action.compensation_persistence_incomplete", {
        actionPlanId: compensated.id,
        receipt: compensated.compensationReceipt?.receipt,
        errorCode: externalFailureCode(error),
      });
      throw new OutcomeDomainError(
        "compensation_applied_persistence_incomplete",
        "Slack restored the previous card and Knot recorded the compensation receipt, but its outcome projection is incomplete. Do not restore it again; reconciliation is required.",
      );
    }
  }

  private async ensureAppliedProjection(
    applied: ActionPlan,
    outcome: Outcome,
    actor: ActorContext,
    at: string,
    action: SlackCardUpdateAction,
  ): Promise<void> {
    try {
      await this.store.transaction(async () => {
        const latestOutcome = await this.requireOutcome(outcome.id, outcome.workspaceId);
        await this.store.setSlackCardReference(outcome.id, outcome.workspaceId, {
          channelId: action.channelId,
          messageTs: action.messageTs,
          audience: this.cardAudience(applied),
          blocks: action.afterBlocks,
          fallbackText: action.afterFallbackText,
        });
        const evidenceId = `execution:${applied.id}`;
        if (latestOutcome.contract.evidence?.some((evidence) => evidence.id === evidenceId)) {
          return;
        }
        const evidencedOutcome = await this.recordEvidenceInternal(
          latestOutcome,
          actor,
          {
            id: evidenceId,
            kind: "system_record",
            label: "Slack outcome-card update receipt",
            locator: `slack://${action.channelId}/${action.messageTs}`,
            observedAt: at,
            freshness: "fresh",
            verification: {
              method: "provider_receipt",
              verifiedAt: at,
            },
          },
          at,
        );
        await this.record(evidencedOutcome, actor, "action.applied", {
          actionPlanId: applied.id,
          receipt: applied.executionReceipt?.receipt,
          externalVersion: applied.executionReceipt?.externalVersion,
        });
      });
    } catch (error) {
      await this.record(outcome, actor, "action.applied_persistence_incomplete", {
        actionPlanId: applied.id,
        receipt: applied.executionReceipt?.receipt,
        errorCode: externalFailureCode(error),
      });
      throw new OutcomeDomainError(
        "action_applied_persistence_incomplete",
        "Slack applied the update and Knot recorded its execution receipt, but the outcome projection is incomplete. Do not execute it again; reconciliation is required.",
      );
    }
  }

  private assertSharedContractConfirmed(
    provenance: readonly ContractFieldProvenance[],
    privacyScope: PrivacyScope,
    creatorPrincipalId: string,
  ): void {
    if (privacyScope.kind === "private") {
      return;
    }
    const required = new Set<ContractFieldProvenance["field"]>([
      "goal",
      "accountableOwnerPrincipalId",
      "definitionOfDone",
      "nextMove",
      "reviewPoint",
      "evidence",
      "participants",
      "privacyScope",
    ]);
    const confirmed = new Set(
      provenance
        .filter(
          (entry) =>
            entry.confirmedByPrincipalId === creatorPrincipalId && entry.confirmedAt !== undefined,
        )
        .map((entry) => entry.field),
    );
    const missing = [...required].filter((field) => !confirmed.has(field));
    if (missing.length > 0) {
      throw new OutcomeDomainError(
        "contract_confirmation_missing",
        `Shared activation requires confirmation of: ${missing.join(", ")}.`,
      );
    }
  }

  private async requireOutcome(outcomeId: string, workspaceId?: string): Promise<Outcome> {
    const outcome = await this.store.getOutcome(outcomeId, workspaceId);
    if (!outcome) {
      throw new OutcomeDomainError("outcome_not_found", "The requested outcome no longer exists.");
    }
    return outcome;
  }

  private async recordEvidenceInternal(
    outcome: Outcome,
    actor: ActorContext,
    evidence: EvidenceReference,
    at: string,
  ): Promise<Outcome> {
    const existingEvidence = outcome.contract.evidence ?? [];
    if (existingEvidence.some((item) => item.id === evidence.id)) {
      return outcome;
    }
    const updated: Outcome = {
      ...outcome,
      contract: {
        ...outcome.contract,
        evidence: [...existingEvidence, evidence],
      },
      contractVersion: outcome.contractVersion + 1,
      version: outcome.version + 1,
      updatedAt: at,
    };
    await this.store.updateOutcome(updated, outcome.version);
    await this.record(updated, actor, "evidence.recorded", { evidenceId: evidence.id });
    return updated;
  }

  private async markEvidenceStaleInternal(
    outcome: Outcome,
    actor: ActorContext,
    evidenceId: string,
    at: string,
  ): Promise<Outcome> {
    const evidence = outcome.contract.evidence ?? [];
    const current = evidence.find((item) => item.id === evidenceId);
    if (current?.freshness !== "fresh") {
      return outcome;
    }
    const updated: Outcome = {
      ...outcome,
      contract: {
        ...outcome.contract,
        evidence: evidence.map((item) =>
          item.id === evidenceId ? { ...item, freshness: "stale" as const } : item,
        ),
      },
      contractVersion: outcome.contractVersion + 1,
      version: outcome.version + 1,
      updatedAt: at,
    };
    await this.store.updateOutcome(updated, outcome.version);
    await this.record(updated, actor, "evidence.staled", { evidenceId });
    return updated;
  }

  private async requirePlan(actionPlanId: string, workspaceId?: string): Promise<ActionPlan> {
    const plan = await this.store.getActionPlan(actionPlanId, workspaceId);
    if (!plan) {
      throw new OutcomeDomainError("action_plan_not_found", "The action preview no longer exists.");
    }
    return plan;
  }

  private async requireCard(outcomeId: string, workspaceId?: string): Promise<SlackCardReference> {
    const card = await this.store.getSlackCardReference(outcomeId, workspaceId);
    if (!card) {
      throw new OutcomeDomainError(
        "outcome_card_missing",
        "No app-owned Slack card is available to update.",
      );
    }
    return card;
  }

  private asSlackCardUpdate(plan: ActionPlan): SlackCardUpdateAction {
    const action = plan.proposedActions[0];
    if (action?.kind !== "slack.card.update") {
      throw new OutcomeDomainError(
        "unsupported_action",
        "The action plan does not contain a Slack card update.",
      );
    }
    return action as unknown as SlackCardUpdateAction;
  }

  private cardAudience(plan: ActionPlan): SlackCardReference["audience"] {
    const card = plan.beforeState.card;
    if (!card || typeof card !== "object") {
      throw new OutcomeDomainError(
        "action_card_state_missing",
        "The action plan does not contain its card audience.",
      );
    }
    const audience = (card as Record<string, unknown>).audience;
    if (!audience || typeof audience !== "object") {
      throw new OutcomeDomainError(
        "action_card_audience_missing",
        "The action plan does not contain a valid card audience.",
      );
    }
    const kind = (audience as Record<string, unknown>).kind;
    const principalIds = (audience as Record<string, unknown>).principalIds;
    if (
      (kind !== "personal" && kind !== "selected_people") ||
      !Array.isArray(principalIds) ||
      principalIds.length === 0 ||
      principalIds.some(
        (principalId) => typeof principalId !== "string" || principalId.length === 0,
      )
    ) {
      throw new OutcomeDomainError(
        "action_card_audience_missing",
        "The action plan does not contain a valid card audience.",
      );
    }
    return { kind, principalIds: [...principalIds] };
  }

  private isPersonalReversibleCardPlan(
    plan: ActionPlan,
    outcome: Outcome,
    actor: ActorContext,
  ): boolean {
    if (plan.reversibility !== "reversible") {
      return false;
    }
    if (outcome.contract.privacyScope?.kind !== "private") {
      return false;
    }
    const audience = this.cardAudience(plan);
    return (
      audience.kind === "personal" &&
      audience.principalIds.length === 1 &&
      audience.principalIds[0] === actor.principalId &&
      plan.createdByPrincipalId === actor.principalId
    );
  }

  private assertActorOwnsCurrentNextMove(outcome: Outcome, actor: ActorContext, at: string): void {
    const nextMoveActor = outcome.contract.nextMove?.actorPrincipalId;
    if (nextMoveActor && actor.principalId === nextMoveActor) {
      return;
    }
    const ownerDelegatedTheNextMove =
      nextMoveActor === outcome.contract.accountableOwnerPrincipalId &&
      outcome.delegations.some(
        (delegation) =>
          delegation.delegatorPrincipalId === nextMoveActor &&
          delegation.delegatePrincipalId === actor.principalId &&
          delegation.permissions.includes("act_as_owner") &&
          isDelegationActive(delegation, at),
      );
    if (!ownerDelegatedTheNextMove) {
      throw new OutcomeDomainError(
        "next_move_actor_mismatch",
        "Only the person named for the current next move may prepare its update.",
      );
    }
  }

  private assertPlanMatchesCurrentOutcome(plan: ActionPlan, outcome: Outcome): void {
    if (
      plan.workspaceId !== outcome.workspaceId ||
      plan.outcomeId !== outcome.id ||
      plan.outcomeVersion !== outcome.version ||
      plan.contractVersion !== outcome.contractVersion
    ) {
      throw new OutcomeDomainError(
        "action_plan_stale",
        "The outcome changed after this action preview. Prepare a new exact update.",
      );
    }
    if (plan.policyVersion !== this.policy.version) {
      throw new OutcomeDomainError(
        "action_policy_stale",
        "The authority policy changed after this action preview. Prepare a new exact update.",
      );
    }
    const currentEvidenceIds = (outcome.contract.evidence ?? [])
      .map((evidence) => evidence.id)
      .sort();
    const plannedEvidenceIds = [...plan.evidenceSnapshotIds].sort();
    if (JSON.stringify(currentEvidenceIds) !== JSON.stringify(plannedEvidenceIds)) {
      throw new OutcomeDomainError(
        "action_evidence_stale",
        "The evidence changed after this action preview. Prepare a new exact update.",
      );
    }
  }

  private assertValidActionPlanBinding(binding: ActionPlanBinding): void {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        binding.actionPlanId,
      ) ||
      binding.idempotencyKey.trim().length === 0 ||
      binding.idempotencyKey.length > 256
    ) {
      throw new OutcomeDomainError(
        "action_preview_binding_invalid",
        "The action-preview retry binding is invalid.",
      );
    }
  }

  private async failBeforeDispatch(
    plan: ActionPlan,
    outcome: Outcome,
    actor: ActorContext,
    reasonCode: string,
  ): Promise<void> {
    const failed: ActionPlan = { ...plan, state: "failed", version: plan.version + 1 };
    await this.store.updateActionPlan(failed, plan.version);
    await this.record(outcome, actor, "action.execution_rejected", {
      actionPlanId: plan.id,
      reasonCode,
    });
  }

  private async record(
    outcome: Outcome,
    actor: ActorContext,
    type: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendAudit({
      id: randomUUID(),
      workspaceId: outcome.workspaceId,
      outcomeId: outcome.id,
      actorPrincipalId: actor.principalId,
      type,
      correlationId: actor.correlationId,
      causationId: actor.correlationId,
      at: new Date().toISOString(),
      details,
      policyVersion: this.policy.version,
    });
  }
}
