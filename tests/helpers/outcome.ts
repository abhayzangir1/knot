import type { Outcome } from "../../src/outcomes/index.js";

export const timestamp = "2026-07-12T12:00:00.000Z";

export function makeOutcome(overrides: Partial<Outcome> = {}): Outcome {
  const base: Outcome = {
    id: "outcome-1",
    workspaceId: "workspace-1",
    createdByPrincipalId: "creator-1",
    type: "request",
    state: "awaiting_owner_acceptance",
    contract: {
      goal: "Get the release plan reviewed.",
      accountableOwnerPrincipalId: "owner-1",
      definitionOfDone: "The reviewer records an approval or requested revision.",
      nextMove: {
        description: "Review the release plan.",
        actorPrincipalId: "owner-1",
      },
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
      ],
      privacyScope: { kind: "selected_people" },
    },
    contractFieldProvenance: [],
    ownerAcceptance: {
      requestedOwnerPrincipalId: "owner-1",
      status: "accepted",
      respondedByPrincipalId: "owner-1",
      respondedAt: timestamp,
    },
    audience: {
      grants: [
        {
          id: "audience-creator",
          subject: { kind: "principal", principalId: "creator-1" },
          permissions: ["view", "edit", "approve", "execute", "evidence_access"],
        },
        {
          id: "audience-owner",
          subject: { kind: "principal", principalId: "owner-1" },
          permissions: ["view", "edit", "evidence_access"],
        },
      ],
    },
    connectedSystems: [],
    delegations: [],
    version: 1,
    contractVersion: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return { ...base, ...overrides };
}
