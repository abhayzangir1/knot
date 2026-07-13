import { describe, expect, it } from "vitest";
import { OUTCOME_CONTRACT_FIELDS } from "../../src/outcomes/index.js";
import { slackIds } from "../../src/slack/constants.js";
import {
  bindContractSubmission,
  contractInputBlockIds,
  parseContractSubmission,
  submissionErrors,
} from "../../src/slack/contract-input.js";

const source = {
  id: "slack:C1:1710000000.000100",
  permalink: "https://example.test/archives/C1/p1710000000000100",
  observedAt: "2026-07-12T12:00:00.000Z",
};

function state(input: {
  type?: "request" | "decision" | "commitment" | "handoff" | "other";
  owner: string;
  nextMoveActor?: string;
  reviewer?: string;
  reviewKind?: "at" | "on_event";
  reviewEvent?: string;
  confirmEvidence?: boolean;
  confirmParticipants?: boolean;
  visibility: "private" | "selected_people";
}) {
  const confirmed = { selected_options: [{ value: "confirmed" }] };
  return {
    [slackIds.blocks.outcomeType]: {
      value: { selected_option: { value: input.type ?? "request" } },
    },
    [slackIds.blocks.goal]: { value: { value: "Get the release decision." } },
    [slackIds.blocks.owner]: { value: { selected_user: input.owner } },
    [slackIds.blocks.reviewer]: { value: { selected_user: input.reviewer ?? null } },
    [slackIds.blocks.definition]: { value: { value: "The decision is recorded." } },
    [slackIds.blocks.nextMove]: { value: { value: "Review the release plan." } },
    [slackIds.blocks.nextMoveActor]: {
      value: { selected_user: input.nextMoveActor ?? input.owner },
    },
    [slackIds.blocks.reviewPoint]: {
      value: { selected_option: { value: input.reviewKind ?? "at" } },
    },
    [contractInputBlockIds.reviewPointAt]: {
      value: { selected_date_time: String(Date.parse("2026-07-14T12:00:00.000Z") / 1_000) },
    },
    [contractInputBlockIds.reviewPointEvent]: {
      value: { value: input.reviewEvent ?? "When the customer replies" },
    },
    [contractInputBlockIds.evidenceConfirmation]: {
      value: input.confirmEvidence === false ? { selected_options: [] } : confirmed,
    },
    [contractInputBlockIds.participantsConfirmation]: {
      value: input.confirmParticipants === false ? { selected_options: [] } : confirmed,
    },
    [slackIds.blocks.visibility]: {
      value: { selected_option: { value: input.visibility } },
    },
  };
}

describe("Slack contract confirmation", () => {
  it.each([
    ["source evidence", { confirmEvidence: false }, contractInputBlockIds.evidenceConfirmation],
    [
      "participant roles",
      { confirmParticipants: false },
      contractInputBlockIds.participantsConfirmation,
    ],
  ] as const)("requires explicit confirmation of %s", (_label, flags, errorBlockId) => {
    let error: unknown;
    try {
      parseContractSubmission({
        state: state({
          owner: "UCREATOR",
          visibility: "private",
          ...flags,
        }),
        creatorSlackUserId: "UCREATOR",
        evidence: source,
      });
    } catch (caught) {
      error = caught;
    }

    expect(submissionErrors(error)).toHaveProperty(errorBlockId);
  });

  it("records explicit confirmation of all eight contract fields", () => {
    const raw = parseContractSubmission({
      state: state({ owner: "UCREATOR", visibility: "private" }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });

    expect(raw.confirmedFields).toEqual(OUTCOME_CONTRACT_FIELDS);
  });

  it("requires an independent reviewer for a shared contract", () => {
    expect(() =>
      parseContractSubmission({
        state: state({ owner: "UOWNER", visibility: "selected_people" }),
        creatorSlackUserId: "UCREATOR",
        evidence: source,
      }),
    ).toThrow("independent reviewer");
  });

  it("returns a field-level modal error instead of discarding an invalid shared form", () => {
    let error: unknown;
    try {
      parseContractSubmission({
        state: state({ owner: "UOWNER", visibility: "selected_people" }),
        creatorSlackUserId: "UCREATOR",
        evidence: source,
      });
    } catch (caught) {
      error = caught;
    }

    expect(submissionErrors(error)).toEqual({
      [slackIds.blocks.reviewer]:
        "A shared outcome needs an independent reviewer before it can safely approve updates.",
    });
  });

  it("does not allow private ownership to be assigned to another person", () => {
    expect(() =>
      parseContractSubmission({
        state: state({ owner: "UOWNER", visibility: "private" }),
        creatorSlackUserId: "UCREATOR",
        evidence: source,
      }),
    ).toThrow("private outcome");
  });

  it("binds signed Slack selections to internal principals only at the edge", () => {
    const raw = parseContractSubmission({
      state: state({ owner: "UOWNER", reviewer: "UREVIEWER", visibility: "selected_people" }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });
    const bound = bindContractSubmission({
      raw,
      creatorPrincipalId: "creator-internal",
      ownerPrincipalId: "owner-internal",
      nextMoveActorPrincipalId: "owner-internal",
      reviewerPrincipalId: "reviewer-internal",
      at: source.observedAt,
    });

    expect(bound.contract.accountableOwnerPrincipalId).toBe("owner-internal");
    expect(bound.type).toBe("request");
    expect(bound.contract.nextMove?.actorPrincipalId).toBe("owner-internal");
    expect(bound.contract.participants.map((participant) => participant.principalId)).toEqual([
      "owner-internal",
      "creator-internal",
      "reviewer-internal",
    ]);
    expect(bound.audience.grants.map((grant) => grant.subject)).not.toContainEqual({
      kind: "principal",
      principalId: "UOWNER",
    });
    expect(
      bound.audience.grants.find((grant) => grant.id === "audience:creator-internal")?.permissions,
    ).toEqual(["view", "edit", "evidence_access"]);
    expect(
      bound.audience.grants.find((grant) => grant.id === "audience:owner-internal")?.permissions,
    ).toContain("execute");
    expect(
      bound.audience.grants.find((grant) => grant.id === "audience:reviewer-internal")?.permissions,
    ).toEqual(["view", "approve", "evidence_access"]);
    expect(bound.provenance.map((entry) => entry.field)).toEqual(OUTCOME_CONTRACT_FIELDS);
    expect(
      bound.provenance.every((entry) => entry.confirmedByPrincipalId === "creator-internal"),
    ).toBe(true);
  });

  it("fails closed if durable transport omits any field confirmation", () => {
    const raw = parseContractSubmission({
      state: state({ owner: "UCREATOR", visibility: "private" }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });

    expect(() =>
      bindContractSubmission({
        raw: {
          ...raw,
          confirmedFields: raw.confirmedFields.filter((field) => field !== "participants"),
        },
        creatorPrincipalId: "creator-internal",
        ownerPrincipalId: "creator-internal",
        nextMoveActorPrincipalId: "creator-internal",
        at: source.observedAt,
      }),
    ).toThrow("participants");
  });

  it("revalidates private principal bindings after durable transport", () => {
    const raw = parseContractSubmission({
      state: state({ owner: "UCREATOR", visibility: "private" }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });

    expect(() =>
      bindContractSubmission({
        raw,
        creatorPrincipalId: "creator-internal",
        ownerPrincipalId: "different-owner-internal",
        nextMoveActorPrincipalId: "creator-internal",
        at: source.observedAt,
      }),
    ).toThrow("remain owned by its creator");
    expect(() =>
      bindContractSubmission({
        raw,
        creatorPrincipalId: "creator-internal",
        ownerPrincipalId: "creator-internal",
        nextMoveActorPrincipalId: "creator-internal",
        reviewerPrincipalId: "unexpected-reviewer-internal",
        at: source.observedAt,
      }),
    ).toThrow("cannot bind an independent reviewer");
  });

  it("revalidates the handoff receiving owner after durable transport", () => {
    const raw = parseContractSubmission({
      state: state({
        type: "handoff",
        owner: "UOWNER",
        reviewer: "UREVIEWER",
        visibility: "selected_people",
      }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });

    expect(() =>
      bindContractSubmission({
        raw,
        creatorPrincipalId: "same-internal",
        ownerPrincipalId: "same-internal",
        nextMoveActorPrincipalId: "next-internal",
        reviewerPrincipalId: "reviewer-internal",
        at: source.observedAt,
      }),
    ).toThrow("different receiving accountable owner");
  });

  it.each([
    "decision",
    "commitment",
    "handoff",
    "other",
  ] as const)("preserves the selected %s outcome type", (type) => {
    const raw = parseContractSubmission({
      state: state({
        type,
        owner: "UOWNER",
        reviewer: "UREVIEWER",
        visibility: "selected_people",
      }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });

    expect(raw.type).toBe(type);
  });

  it("records type-specific decision and handoff participant roles", () => {
    const decisionRaw = parseContractSubmission({
      state: state({
        type: "decision",
        owner: "UOWNER",
        reviewer: "UREVIEWER",
        visibility: "selected_people",
      }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });
    const decision = bindContractSubmission({
      raw: decisionRaw,
      creatorPrincipalId: "creator-internal",
      ownerPrincipalId: "owner-internal",
      nextMoveActorPrincipalId: "owner-internal",
      reviewerPrincipalId: "reviewer-internal",
      at: source.observedAt,
    });
    expect(
      decision.contract.participants.find(
        (participant) => participant.principalId === "owner-internal",
      )?.roles,
    ).toEqual(["owner", "decider", "contributor"]);

    const handoffRaw = parseContractSubmission({
      state: state({
        type: "handoff",
        owner: "UOWNER",
        reviewer: "UREVIEWER",
        visibility: "selected_people",
      }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });
    const handoff = bindContractSubmission({
      raw: handoffRaw,
      creatorPrincipalId: "creator-internal",
      ownerPrincipalId: "owner-internal",
      nextMoveActorPrincipalId: "owner-internal",
      reviewerPrincipalId: "reviewer-internal",
      at: source.observedAt,
    });
    expect(
      handoff.contract.participants.find(
        (participant) => participant.principalId === "owner-internal",
      )?.roles,
    ).toEqual(["owner", "handoff_recipient", "contributor"]);
    expect(
      handoff.contract.participants.find(
        (participant) => participant.principalId === "creator-internal",
      )?.roles,
    ).toEqual(["requester", "handoff_sender"]);
  });

  it("rejects a handoff to the creator because there is no receiving owner", () => {
    expect(() =>
      parseContractSubmission({
        state: state({ type: "handoff", owner: "UCREATOR", visibility: "private" }),
        creatorSlackUserId: "UCREATOR",
        evidence: source,
      }),
    ).toThrow("different receiving");
  });

  it("parses a friendly event review point and caps it at 500 characters", () => {
    const raw = parseContractSubmission({
      state: state({
        owner: "UCREATOR",
        visibility: "private",
        reviewKind: "on_event",
        reviewEvent: "When the customer replies",
      }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });
    expect(raw.reviewPoint).toEqual({
      kind: "on_event",
      event: "When the customer replies",
    });

    expect(() =>
      parseContractSubmission({
        state: state({
          owner: "UCREATOR",
          visibility: "private",
          reviewKind: "on_event",
          reviewEvent: "r".repeat(501),
        }),
        creatorSlackUserId: "UCREATOR",
        evidence: source,
      }),
    ).toThrow("500 characters");
  });

  it("assigns the mutable next-move control only to the selected internal principal", () => {
    const raw = parseContractSubmission({
      state: state({
        owner: "UOWNER",
        nextMoveActor: "UNEXT",
        reviewer: "UREVIEWER",
        visibility: "selected_people",
      }),
      creatorSlackUserId: "UCREATOR",
      evidence: source,
    });
    const bound = bindContractSubmission({
      raw,
      creatorPrincipalId: "creator-internal",
      ownerPrincipalId: "owner-internal",
      nextMoveActorPrincipalId: "next-internal",
      reviewerPrincipalId: "reviewer-internal",
      at: source.observedAt,
    });

    expect(bound.contract.nextMove?.actorPrincipalId).toBe("next-internal");
    expect(bound.contract.participants.map((participant) => participant.principalId)).toContain(
      "next-internal",
    );
    expect(
      bound.audience.grants.find((grant) => grant.id === "audience:next-internal")?.permissions,
    ).toEqual(["view", "execute", "evidence_access"]);
    expect(
      bound.audience.grants.find((grant) => grant.id === "audience:owner-internal")?.permissions,
    ).not.toContain("execute");
  });
});
