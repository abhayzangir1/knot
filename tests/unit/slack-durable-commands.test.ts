import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { OUTCOME_CONTRACT_FIELDS } from "../../src/outcomes/index.js";
import {
  deterministicCommandUuid,
  durableCommandDedupeKey,
  durableSlackIdentity,
  parseSlackDurableCommand,
  serializeContractSubmission,
} from "../../src/slack/durable-commands.js";

const verifiedIdentity = {
  slackTeamId: "T123",
  slackUserId: "U123",
  correlationId: "interaction:123",
  authenticatedAt: "2026-07-13T12:00:00.000Z",
};
const identity = durableSlackIdentity(verifiedIdentity);
const durableSubmission = {
  type: "request" as const,
  goal: "Publish the hackathon demo.",
  ownerSlackUserId: "UOWNER",
  reviewerSlackUserId: "UREVIEWER",
  definitionOfDone: "A durable release reference is recorded.",
  nextMove: "Publish the release candidate.",
  nextMoveActorSlackUserId: "UNEXTMOVE",
  reviewPoint: { kind: "on_event" as const, event: "When the release is published" },
  privacyScope: { kind: "selected_people" as const },
  confirmedFields: [...OUTCOME_CONTRACT_FIELDS],
  title: "Publish the hackathon demo",
};

describe("durable Slack command boundary", () => {
  it("accepts a complete, explicitly confirmed contract command", () => {
    const command = {
      kind: "contract_create" as const,
      identity,
      opaqueReference: randomUUID(),
      intendedOutcomeId: randomUUID(),
      submission: durableSubmission,
    };

    expect(parseSlackDurableCommand(command)).toEqual(command);
  });

  it("rejects contract transport that omits or duplicates field confirmations", () => {
    const submission = {
      type: "request" as const,
      goal: "Publish the hackathon demo.",
      ownerSlackUserId: "UOWNER",
      definitionOfDone: "A durable release reference is recorded.",
      nextMove: "Publish the release candidate.",
      nextMoveActorSlackUserId: "UNEXTMOVE",
      reviewPoint: { kind: "on_event" as const, event: "When the release is published" },
      privacyScope: { kind: "private" as const },
      confirmedFields: [...OUTCOME_CONTRACT_FIELDS],
      title: "Publish the hackathon demo",
    };
    const command = {
      kind: "contract_create" as const,
      identity,
      opaqueReference: randomUUID(),
      intendedOutcomeId: randomUUID(),
      submission,
    };

    expect(() =>
      parseSlackDurableCommand({
        ...command,
        submission: {
          ...submission,
          confirmedFields: submission.confirmedFields.slice(0, -1),
        },
      }),
    ).toThrow();
    expect(() =>
      parseSlackDurableCommand({
        ...command,
        submission: {
          ...submission,
          confirmedFields: [
            ...submission.confirmedFields.slice(0, -1),
            submission.confirmedFields[0],
          ],
        },
      }),
    ).toThrow();
  });

  it("removes transient source evidence and volatile identity fields before durable storage", () => {
    const submission = serializeContractSubmission({
      type: "request",
      goal: "Publish the release.",
      ownerSlackUserId: "UOWNER",
      definitionOfDone: "The release is visible.",
      nextMove: "Publish it.",
      nextMoveActorSlackUserId: "UOWNER",
      reviewPoint: { kind: "on_event", event: "When published" },
      privacyScope: { kind: "private" },
      evidence: {
        id: "source-1",
        permalink: "https://example.slack.com/archives/C1/p1",
        observedAt: verifiedIdentity.authenticatedAt,
      },
      confirmedFields: [...OUTCOME_CONTRACT_FIELDS],
      title: "Publish the release",
    });

    expect(submission).not.toHaveProperty("evidence");
    expect(durableSlackIdentity(verifiedIdentity)).toEqual({
      slackTeamId: "T123",
      slackUserId: "U123",
    });
    expect(deterministicCommandUuid("same-command")).toBe(deterministicCommandUuid("same-command"));
    expect(deterministicCommandUuid("same-command")).not.toBe(
      deterministicCommandUuid("different-command"),
    );
  });

  it("accepts only a bounded actor-bound action preview request", () => {
    const command = {
      kind: "action_preview" as const,
      identity,
      outcomeId: randomUUID(),
    };

    expect(parseSlackDurableCommand(command)).toEqual(command);
    expect(() => parseSlackDurableCommand({ ...command, proposedText: "run this" })).toThrow();
  });

  it("accepts a bounded, actor-bound closure command", () => {
    const command = {
      kind: "closure_confirm" as const,
      identity,
      outcomeId: randomUUID(),
      evidenceId: `closure:${randomUUID()}`,
      locator: "https://example.test/evidence/1",
    };

    expect(parseSlackDurableCommand(command)).toEqual(command);
  });

  it("accepts bounded recovery commands and rejects hidden authority fields", () => {
    const outcomeId = randomUUID();
    const interaction = {
      channelId: "D123",
      messageTs: "1710000000.000100",
      slackUserId: identity.slackUserId,
    };
    const commands = [
      {
        kind: "outcome_correct" as const,
        identity,
        outcomeId,
        submission: durableSubmission,
        reason: "Clarified the result.",
      },
      {
        kind: "owner_reassign" as const,
        identity,
        outcomeId,
        submission: durableSubmission,
        reason: "The first owner declined.",
      },
      {
        kind: "outcome_delegate" as const,
        identity,
        outcomeId,
        delegateSlackUserId: "UDELEGATE",
        permissions: ["edit", "close"] as const,
        expiresAt: "2026-07-15T12:00:00.000Z",
      },
      {
        kind: "outcome_delete" as const,
        identity,
        outcomeId,
        interaction,
        reasonCode: "user_request" as const,
      },
      {
        kind: "outcome_reopen" as const,
        identity,
        outcomeId,
        interaction,
        reason: "The result needs more work.",
      },
    ];

    for (const command of commands) {
      expect(parseSlackDurableCommand(command)).toEqual(command);
      expect(() =>
        parseSlackDurableCommand({ ...command, authorityGrantedByButton: true }),
      ).toThrow();
    }
  });

  it("rejects non-HTTPS evidence, unknown fields, and malformed opaque references", () => {
    const base = {
      kind: "closure_confirm" as const,
      identity,
      outcomeId: randomUUID(),
      evidenceId: `closure:${randomUUID()}`,
      locator: "https://example.test/evidence/1",
    };

    expect(() => parseSlackDurableCommand({ ...base, locator: "http://example.test" })).toThrow();
    expect(() =>
      parseSlackDurableCommand({ ...base, unreviewedInstruction: "execute this" }),
    ).toThrow();
    expect(() => parseSlackDurableCommand({ ...base, outcomeId: "not-an-opaque-id" })).toThrow();
  });

  it("binds dedupe keys to Slack tenant, actor, reference, and interaction nonce", () => {
    const base = {
      label: "owner-accept",
      identity,
      opaqueReference: randomUUID(),
      nonce: "1710000000.000100",
    };
    const first = durableCommandDedupeKey(base);

    expect(durableCommandDedupeKey(base)).toBe(first);
    expect(
      durableCommandDedupeKey({
        ...base,
        identity: { ...identity, slackUserId: "U456" },
      }),
    ).not.toBe(first);
    expect(durableCommandDedupeKey({ ...base, nonce: "1710000000.000200" })).not.toBe(first);
  });
});
