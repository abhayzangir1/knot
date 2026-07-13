import { describe, expect, it } from "vitest";

import {
  type EvidenceReference,
  type Outcome,
  type OutcomeType,
  transitionOutcome,
} from "../../src/outcomes/index.js";
import { makeOutcome, timestamp } from "../helpers/outcome.js";

type EvidenceKind = EvidenceReference["kind"];

function addTypeSpecificParticipants(outcome: Outcome): Outcome {
  const ownerId = outcome.contract.accountableOwnerPrincipalId;
  const participants = (outcome.contract.participants ?? []).map((participant) => {
    const roles = new Set(participant.roles);
    if (participant.principalId === ownerId && outcome.type === "decision") {
      roles.add("decider");
    }
    if (participant.principalId === ownerId && outcome.type === "handoff") {
      roles.add("handoff_recipient");
    }
    if (participant.principalId === outcome.createdByPrincipalId && outcome.type === "handoff") {
      roles.add("handoff_sender");
    }
    return { ...participant, roles: [...roles] };
  });
  return { ...outcome, contract: { ...outcome.contract, participants } };
}

function evidence(
  id: string,
  kind: EvidenceKind,
  overrides: Partial<EvidenceReference> = {},
): EvidenceReference {
  return {
    id,
    kind,
    label: `${kind} closure record`,
    locator: `https://example.test/${kind}/${id}`,
    observedAt: timestamp,
    freshness: "fresh",
    verification: {
      method: "authorized_user_attestation",
      verifiedAt: timestamp,
      verifiedByPrincipalId: "owner-1",
    },
    ...overrides,
  };
}

function closureReadyOutcome(type: OutcomeType, kind: EvidenceKind): Outcome {
  const base = addTypeSpecificParticipants(makeOutcome({ state: "closure_requested", type }));
  return {
    ...base,
    contract: {
      ...base.contract,
      evidence: [...(base.contract.evidence ?? []), evidence(`closure-${type}`, kind)],
    },
  };
}

function close(outcome: Outcome, evidenceId = `closure-${outcome.type}`): Outcome {
  return transitionOutcome(outcome, {
    to: "closed",
    at: timestamp,
    actorPrincipalId: "owner-1",
    closureEvidenceIds: [evidenceId],
  });
}

describe("outcome lifecycle", () => {
  it("does not activate before owner acceptance", () => {
    const outcome = makeOutcome({
      ownerAcceptance: {
        requestedOwnerPrincipalId: "owner-1",
        status: "pending",
      },
    });

    expect(() =>
      transitionOutcome(outcome, {
        to: "active",
        at: timestamp,
        actorPrincipalId: "creator-1",
      }),
    ).toThrow("accepts");
  });

  it("activates a complete accepted outcome", () => {
    const active = transitionOutcome(makeOutcome(), {
      to: "active",
      at: timestamp,
      actorPrincipalId: "owner-1",
    });

    expect(active.state).toBe("active");
    expect(active.version).toBe(2);
  });

  it("requires evidence before closure", () => {
    expect(() =>
      transitionOutcome(makeOutcome({ state: "closure_requested" }), {
        to: "closed",
        at: timestamp,
        actorPrincipalId: "owner-1",
      }),
    ).toThrow("closure evidence");
  });

  it("rejects an evidence ID that is not on the contract", () => {
    const outcome = closureReadyOutcome("request", "completion_record");

    expect(() => close(outcome, "unknown-evidence")).toThrow("accessible evidence reference");
  });

  it.each([
    ["request", "completion_record"],
    ["decision", "decision_record"],
    ["commitment", "completion_record"],
    ["handoff", "handoff_confirmation"],
    ["other", "completion_record"],
  ] as const)("closes a semantically complete %s", (type, kind) => {
    const closed = close(closureReadyOutcome(type, kind));

    expect(closed.state).toBe("closed");
    expect(closed.closedByPrincipalId).toBe("owner-1");
  });

  it.each([
    "slack_thread",
    "decision_record",
  ] as const)("accepts a verified %s as a request answer or explicit decline", (kind) => {
    expect(close(closureReadyOutcome("request", kind)).state).toBe("closed");
  });

  it("requires a requester relationship for Request closure", () => {
    const base = closureReadyOutcome("request", "completion_record");
    const outcome = {
      ...base,
      contract: {
        ...base.contract,
        participants: base.contract.participants?.map((participant) => ({
          ...participant,
          roles: participant.roles.map((role) => (role === "requester" ? "observer" : role)),
        })),
      },
    };

    expect(() => close(outcome)).toThrow("identify its requester");
  });

  it("rejects a non-request closure record for Request", () => {
    expect(() => close(closureReadyOutcome("request", "handoff_confirmation"))).toThrow(
      "delivery, answer, or explicit-decline",
    );
  });

  it("requires an authorized decider relationship and explicit evidence access", () => {
    const base = closureReadyOutcome("decision", "decision_record");
    const withoutDecider = {
      ...base,
      contract: {
        ...base.contract,
        participants: base.contract.participants?.map((participant) => ({
          ...participant,
          roles: participant.roles.filter((role) => role !== "decider"),
        })),
      },
    };
    expect(() => close(withoutDecider)).toThrow("authorized decider");

    const withoutAccess = {
      ...base,
      audience: {
        grants: base.audience.grants.map((grant) =>
          grant.subject.kind === "principal" && grant.subject.principalId === "owner-1"
            ? { ...grant, permissions: ["view" as const] }
            : grant,
        ),
      },
    };
    expect(() => close(withoutAccess)).toThrow("closure evidence");
  });

  it("requires the authorized decider to acknowledge the decision record", () => {
    const base = closureReadyOutcome("decision", "decision_record");
    const outcome = {
      ...base,
      contract: {
        ...base.contract,
        evidence: base.contract.evidence?.map((reference) =>
          reference.id === "closure-decision"
            ? {
                ...reference,
                verification: {
                  method: "authorized_user_attestation" as const,
                  verifiedAt: timestamp,
                  verifiedByPrincipalId: "creator-1",
                },
              }
            : reference,
        ),
      },
    };

    expect(() => close(outcome)).toThrow("acknowledged by its authorized decider");
  });

  it("accepts an authorized renegotiation record for Commitment", () => {
    expect(close(closureReadyOutcome("commitment", "decision_record")).state).toBe("closed");
  });

  it("rejects unrelated evidence for Commitment", () => {
    expect(() => close(closureReadyOutcome("commitment", "slack_thread"))).toThrow(
      "completion record or an authorized renegotiation",
    );
  });

  it.each([
    ["handoff_recipient", "receiving participant"],
    ["handoff_sender", "sending participant"],
  ] as const)("requires the %s relationship for Handoff", (missingRole, message) => {
    const base = closureReadyOutcome("handoff", "handoff_confirmation");
    const outcome = {
      ...base,
      contract: {
        ...base.contract,
        participants: base.contract.participants?.map((participant) => ({
          ...participant,
          roles: participant.roles.filter((role) => role !== missingRole),
        })),
      },
    };

    expect(() => close(outcome)).toThrow(message);
  });

  it("rejects a non-handoff closure record for Handoff", () => {
    expect(() => close(closureReadyOutcome("handoff", "completion_record"))).toThrow(
      "handoff confirmation",
    );
  });

  it("requires a completion record for Other", () => {
    expect(() => close(closureReadyOutcome("other", "decision_record"))).toThrow(
      "observable definition of done",
    );
  });

  it("rejects closure after owner acceptance becomes missing or mismatched", () => {
    const base = closureReadyOutcome("request", "completion_record");
    const outcome = {
      ...base,
      ownerAcceptance: {
        requestedOwnerPrincipalId: "different-owner",
        status: "accepted" as const,
        respondedByPrincipalId: "different-owner",
        respondedAt: timestamp,
      },
    };

    expect(() => close(outcome)).toThrow("current accountable owner has accepted");
  });

  it("rejects stale, duplicate, or unconfirmed closure evidence", () => {
    const base = closureReadyOutcome("request", "completion_record");
    const stale = {
      ...base,
      contract: {
        ...base.contract,
        evidence: base.contract.evidence?.map((reference) =>
          reference.id === "closure-request"
            ? { ...reference, freshness: "stale" as const }
            : reference,
        ),
      },
    };
    expect(() => close(stale)).toThrow("stale, conflicting, or unknown");

    expect(() =>
      transitionOutcome(base, {
        to: "closed",
        at: timestamp,
        actorPrincipalId: "owner-1",
        closureEvidenceIds: ["closure-request", "closure-request"],
      }),
    ).toThrow("must not be duplicated");

    const unverified = {
      ...base,
      contract: {
        ...base.contract,
        evidence: base.contract.evidence?.map((reference) =>
          reference.id === "closure-request"
            ? { ...reference, verification: undefined }
            : reference,
        ),
      },
    };
    expect(() => close(unverified)).toThrow("verification method");
  });

  it("requires a principal on authorized-user attestations", () => {
    const base = closureReadyOutcome("request", "completion_record");
    const outcome = {
      ...base,
      contract: {
        ...base.contract,
        evidence: base.contract.evidence?.map((reference) =>
          reference.id === "closure-request"
            ? {
                ...reference,
                verification: {
                  method: "authorized_user_attestation" as const,
                  verifiedAt: timestamp,
                },
              }
            : reference,
        ),
      },
    };

    expect(() => close(outcome)).toThrow("identify the principal");
  });
});
