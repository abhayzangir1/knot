import {
  type AudiencePermission,
  hasAudiencePermission,
  isDelegationActive,
  type Outcome,
  OutcomeDomainError,
} from "./types.js";

export type ActorContext = {
  workspaceId: string;
  principalId: string;
  slackUserId: string;
  correlationId: string;
  authenticatedAt: string;
  isWorkspaceAdmin: boolean;
  resolvedAudienceSubjects: readonly { kind: "channel"; channelId: string }[];
};

export type AuthorityAction =
  | "view"
  | "edit"
  | "approve"
  | "execute"
  | "accept_ownership"
  | "delegate"
  | "close";

export type AuthorityPolicy = {
  version: string;
  allowPersonalSelfConfirmation: boolean;
  prohibitConsequentialSelfApproval: boolean;
};

export const defaultAuthorityPolicy: AuthorityPolicy = {
  version: "authority-policy-v1",
  allowPersonalSelfConfirmation: true,
  prohibitConsequentialSelfApproval: true,
};

const permissionByAction: Readonly<
  Record<Exclude<AuthorityAction, "accept_ownership">, AudiencePermission>
> = {
  view: "view",
  edit: "edit",
  approve: "approve",
  execute: "execute",
  delegate: "edit",
  close: "edit",
};

function isOwnerOrActiveDelegateForClosure(
  outcome: Outcome,
  actor: ActorContext,
  at: string,
): boolean {
  const ownerId = outcome.contract.accountableOwnerPrincipalId;
  if (actor.principalId === ownerId) {
    return true;
  }

  return outcome.delegations.some(
    (delegation) =>
      delegation.delegatorPrincipalId === ownerId &&
      delegation.delegatePrincipalId === actor.principalId &&
      (delegation.permissions.includes("close") ||
        delegation.permissions.includes("act_as_owner")) &&
      isDelegationActive(delegation, at),
  );
}

export function assertActorMatchesOutcomeWorkspace(outcome: Outcome, actor: ActorContext): void {
  if (outcome.workspaceId !== actor.workspaceId) {
    throw new OutcomeDomainError("tenant_mismatch", "The actor is not in this outcome workspace.");
  }
}

export function assertAuthority(
  outcome: Outcome,
  actor: ActorContext,
  action: AuthorityAction,
  at: string,
): void {
  assertActorMatchesOutcomeWorkspace(outcome, actor);

  if (action === "accept_ownership") {
    if (outcome.ownerAcceptance.requestedOwnerPrincipalId !== actor.principalId) {
      throw new OutcomeDomainError(
        "owner_acceptance_forbidden",
        "Only the proposed owner can accept ownership.",
      );
    }
    return;
  }

  const permission = permissionByAction[action];
  if (
    !hasAudiencePermission({
      audience: outcome.audience,
      actorPrincipalId: actor.principalId,
      permission,
      resolvedSubjects: actor.resolvedAudienceSubjects,
    })
  ) {
    throw new OutcomeDomainError(
      "audience_forbidden",
      "The actor is not authorized for this outcome action.",
    );
  }

  if (action === "delegate" && actor.principalId !== outcome.contract.accountableOwnerPrincipalId) {
    throw new OutcomeDomainError(
      "delegation_forbidden",
      "Only the accountable owner may delegate owner authority.",
    );
  }

  if (action === "close" && !isOwnerOrActiveDelegateForClosure(outcome, actor, at)) {
    throw new OutcomeDomainError(
      "closure_authority_missing",
      "Only the accountable owner or an active delegate with closure authority can close this outcome.",
    );
  }
}

export type ApprovalActors = {
  requesterPrincipalId?: string;
  executorPrincipalId: string;
  ownerPrincipalId?: string;
  soleBeneficiaryPrincipalId?: string;
};

export function assertApprovalSeparationOfDuty(
  approver: ActorContext,
  actors: ApprovalActors,
  policy: AuthorityPolicy,
  isPersonalReversibleAction: boolean,
): void {
  if (isPersonalReversibleAction && policy.allowPersonalSelfConfirmation) {
    return;
  }

  if (!policy.prohibitConsequentialSelfApproval) {
    return;
  }

  const prohibited = new Set(
    [
      actors.requesterPrincipalId,
      actors.executorPrincipalId,
      actors.ownerPrincipalId,
      actors.soleBeneficiaryPrincipalId,
    ].filter((id): id is string => Boolean(id)),
  );

  if (prohibited.has(approver.principalId)) {
    throw new OutcomeDomainError(
      "self_approval_forbidden",
      "A requester, executor, owner, or sole beneficiary cannot self-approve this consequential action.",
    );
  }
}
