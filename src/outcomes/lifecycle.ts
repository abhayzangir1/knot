import {
  assertAudienceRespectsPrivacyScope,
  assertCompleteOutcomeContract,
  type EvidenceReference,
  type Outcome,
  type OutcomeContract,
  OutcomeDomainError,
  type OutcomeState,
  type ParticipantRole,
} from "./types.js";

const allowedTransitions: Readonly<Record<OutcomeState, readonly OutcomeState[]>> = {
  proposed: ["clarified", "cancelled"],
  clarified: ["awaiting_owner_acceptance", "cancelled"],
  awaiting_owner_acceptance: ["clarified", "active", "cancelled"],
  active: ["waiting", "at_risk", "blocked", "closure_requested", "cancelled"],
  waiting: ["active", "at_risk", "blocked", "closure_requested", "cancelled"],
  at_risk: ["active", "waiting", "blocked", "closure_requested", "cancelled"],
  blocked: ["active", "waiting", "at_risk", "closure_requested", "cancelled"],
  closure_requested: ["active", "closed", "cancelled"],
  closed: [],
  cancelled: [],
};

export type LifecycleTransition = {
  to: OutcomeState;
  at: string;
  actorPrincipalId: string;
  closureEvidenceIds?: readonly string[];
};

export function canTransition(from: OutcomeState, to: OutcomeState): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertActivationReadiness(outcome: Outcome): void {
  const contract = assertCompleteOutcomeContract(outcome.contract);

  if (outcome.ownerAcceptance.status !== "accepted") {
    throw new OutcomeDomainError(
      "owner_not_accepted",
      "An outcome cannot become active until its accountable owner accepts.",
    );
  }

  if (outcome.ownerAcceptance.requestedOwnerPrincipalId !== contract.accountableOwnerPrincipalId) {
    throw new OutcomeDomainError(
      "owner_acceptance_mismatch",
      "The accepted owner does not match the Outcome Contract.",
    );
  }

  assertAudienceRespectsPrivacyScope(outcome);
}

export function assertClosureReadiness(
  outcome: Outcome,
  closureEvidenceIds: readonly string[] | undefined,
): void {
  const contract = assertCompleteOutcomeContract(outcome.contract);

  if (
    outcome.ownerAcceptance.status !== "accepted" ||
    outcome.ownerAcceptance.requestedOwnerPrincipalId !== contract.accountableOwnerPrincipalId
  ) {
    throw new OutcomeDomainError(
      "closure_owner_not_accepted",
      "Knot cannot close an outcome until its current accountable owner has accepted.",
    );
  }

  assertAudienceRespectsPrivacyScope(outcome);

  if (!closureEvidenceIds || closureEvidenceIds.length === 0) {
    throw new OutcomeDomainError(
      "closure_evidence_missing",
      "Knot cannot close an outcome without closure evidence.",
    );
  }

  if (new Set(closureEvidenceIds).size !== closureEvidenceIds.length) {
    throw new OutcomeDomainError(
      "closure_evidence_duplicate",
      "Closure evidence references must not be duplicated.",
    );
  }

  const evidenceById = new Map(
    (outcome.contract.evidence ?? []).map((evidence) => [evidence.id, evidence]),
  );
  const unknownEvidence = closureEvidenceIds.find((evidenceId) => !evidenceById.has(evidenceId));
  if (unknownEvidence) {
    throw new OutcomeDomainError(
      "closure_evidence_unknown",
      "Closure evidence must be an accessible evidence reference on the outcome.",
    );
  }

  const staleEvidence = closureEvidenceIds.find(
    (evidenceId) => evidenceById.get(evidenceId)?.freshness !== "fresh",
  );
  if (staleEvidence) {
    throw new OutcomeDomainError(
      "closure_evidence_stale",
      "Knot cannot close an outcome with stale, conflicting, or unknown evidence.",
    );
  }

  const closureEvidence = closureEvidenceIds.map((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      throw new OutcomeDomainError(
        "closure_evidence_unknown",
        "Closure evidence must be an accessible evidence reference on the outcome.",
      );
    }
    return evidence;
  });
  if (closureEvidence.some((evidence) => !evidence.verification)) {
    throw new OutcomeDomainError(
      "closure_evidence_unconfirmed",
      "Closure evidence must include an explicit verification method and timestamp.",
    );
  }

  if (
    closureEvidence.some(
      (evidence) =>
        evidence.verification?.method === "authorized_user_attestation" &&
        !evidence.verification.verifiedByPrincipalId,
    )
  ) {
    throw new OutcomeDomainError(
      "closure_attestation_actor_missing",
      "An authorized-user attestation must identify the principal who made it.",
    );
  }

  const inaccessibleViewGrant = outcome.audience.grants.find(
    (grant) => grant.permissions.includes("view") && !grant.permissions.includes("evidence_access"),
  );
  if (inaccessibleViewGrant) {
    throw new OutcomeDomainError(
      "closure_evidence_audience_inaccessible",
      "Everyone authorized to view the outcome must also be able to access its closure evidence.",
    );
  }

  assertTypeSpecificClosure(outcome, contract, closureEvidence);
}

function hasParticipantRole(
  contract: OutcomeContract,
  role: ParticipantRole,
  principalId?: string,
): boolean {
  return contract.participants.some(
    (participant) =>
      participant.roles.includes(role) &&
      (principalId === undefined || participant.principalId === principalId),
  );
}

function hasPrincipalEvidenceAccess(outcome: Outcome, principalId: string): boolean {
  return outcome.audience.grants.some(
    (grant) =>
      grant.subject.kind === "principal" &&
      grant.subject.principalId === principalId &&
      grant.permissions.includes("view") &&
      grant.permissions.includes("evidence_access"),
  );
}

function hasEvidenceKind(
  evidence: readonly EvidenceReference[],
  kinds: readonly EvidenceReference["kind"][],
): boolean {
  return evidence.some((reference) => kinds.includes(reference.kind));
}

function assertTypeSpecificClosure(
  outcome: Outcome,
  contract: OutcomeContract,
  closureEvidence: readonly EvidenceReference[],
): void {
  switch (outcome.type) {
    case "request":
      if (!hasParticipantRole(contract, "requester")) {
        throw new OutcomeDomainError(
          "request_requester_missing",
          "A request must identify its requester before it can close.",
        );
      }
      if (
        !hasEvidenceKind(closureEvidence, ["completion_record", "slack_thread", "decision_record"])
      ) {
        throw new OutcomeDomainError(
          "request_closure_evidence_invalid",
          "A request needs a verified delivery, answer, or explicit-decline record.",
        );
      }
      return;

    case "decision": {
      const decider = contract.participants.find((participant) =>
        participant.roles.includes("decider"),
      );
      if (!decider) {
        throw new OutcomeDomainError(
          "decision_decider_missing",
          "A decision must identify an authorized decider before it can close.",
        );
      }
      if (!hasPrincipalEvidenceAccess(outcome, decider.principalId)) {
        throw new OutcomeDomainError(
          "decision_decider_access_missing",
          "The decider must have explicit view and evidence access; participant status alone grants no access.",
        );
      }
      const acknowledgedDecision = closureEvidence.find(
        (reference) =>
          reference.kind === "decision_record" &&
          reference.verification?.verifiedByPrincipalId === decider.principalId,
      );
      if (!acknowledgedDecision) {
        throw new OutcomeDomainError(
          "decision_closure_evidence_invalid",
          "A decision needs a verified decision record acknowledged by its authorized decider.",
        );
      }
      return;
    }

    case "commitment":
      if (!hasEvidenceKind(closureEvidence, ["completion_record", "decision_record"])) {
        throw new OutcomeDomainError(
          "commitment_closure_evidence_invalid",
          "A commitment needs an owner-attested completion record or an authorized renegotiation or decline record.",
        );
      }
      return;

    case "handoff":
      if (
        !hasParticipantRole(contract, "handoff_recipient", contract.accountableOwnerPrincipalId)
      ) {
        throw new OutcomeDomainError(
          "handoff_recipient_missing",
          "A handoff's accepted accountable owner must be identified as the receiving participant.",
        );
      }
      if (!hasParticipantRole(contract, "handoff_sender")) {
        throw new OutcomeDomainError(
          "handoff_sender_missing",
          "A handoff must identify the sending participant.",
        );
      }
      if (!hasPrincipalEvidenceAccess(outcome, contract.accountableOwnerPrincipalId)) {
        throw new OutcomeDomainError(
          "handoff_recipient_access_missing",
          "The receiving owner must have explicit view and evidence access; participant status alone grants no access.",
        );
      }
      if (!hasEvidenceKind(closureEvidence, ["handoff_confirmation"])) {
        throw new OutcomeDomainError(
          "handoff_closure_evidence_invalid",
          "A handoff needs verified receiving-owner acceptance and an accessible handoff confirmation.",
        );
      }
      return;

    case "other":
      if (!hasEvidenceKind(closureEvidence, ["completion_record"])) {
        throw new OutcomeDomainError(
          "other_closure_evidence_invalid",
          "An Other outcome needs an owner-attested completion record supporting its observable definition of done.",
        );
      }
      return;
  }
}

export function transitionOutcome(outcome: Outcome, transition: LifecycleTransition): Outcome {
  if (!canTransition(outcome.state, transition.to)) {
    throw new OutcomeDomainError(
      "invalid_lifecycle_transition",
      `Cannot transition an outcome from ${outcome.state} to ${transition.to}.`,
    );
  }

  if (transition.to === "active") {
    assertActivationReadiness(outcome);
  }

  if (transition.to === "closed") {
    assertClosureReadiness(outcome, transition.closureEvidenceIds);
  }

  return {
    ...outcome,
    state: transition.to,
    version: outcome.version + 1,
    updatedAt: transition.at,
    ...(transition.to === "closed"
      ? {
          closedAt: transition.at,
          closedByPrincipalId: transition.actorPrincipalId,
          closureEvidenceIds: [...(transition.closureEvidenceIds ?? [])],
        }
      : {}),
  };
}
