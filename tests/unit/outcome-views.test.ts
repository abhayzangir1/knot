import { describe, expect, it } from "vitest";

import { slackIds } from "../../src/slack/constants.js";
import { contractInputBlockIds } from "../../src/slack/contract-input.js";
import {
  buildActionPreviewModal,
  buildActionQueuedModal,
  buildClosureProofModal,
  buildContractPreviewModal,
  buildDelegationModal,
  buildOperationFailedModal,
} from "../../src/slack/views/outcome-views.js";

const actionPreviewInput = {
  opaqueReference: "00000000-0000-4000-8000-000000000001",
  outcomeTitle: "Publish the demo",
  target: { channelId: "D123", messageTs: "1710000000.000100" },
  beforeText: "Before state",
  afterText: "After state",
  beforeBlocksHash: "before-hash",
  afterBlocksHash: "after-hash",
  planHash: "plan-hash",
  outcomeVersion: 4,
  contractVersion: 3,
  policyVersion: "policy-v1",
  evidenceSnapshotIds: ["evidence-1", "evidence-2"],
  expiresAt: "2026-07-14T12:10:00.000Z",
  reversibility: "reversible" as const,
};

describe("Outcome contract modal", () => {
  it("defaults a selected message to the least-privilege single-person flow", () => {
    const view = buildContractPreviewModal({
      opaqueReference: "00000000-0000-4000-8000-000000000001",
      creatorSlackUserId: "UCREATOR",
      goal: "Publish the demo",
      definitionOfDone: "A release URL is verified.",
      nextMove: "Post a progress update.",
      reviewPoint: "2026-07-14T12:00:00.000Z",
      sourceEvidencePermalink: "https://example.slack.com/archives/C1/p1710000000000100",
    });
    const blocks = view.blocks as Record<string, unknown>[];
    const owner = blocks.find((block) => block.block_id === slackIds.blocks.owner);
    const nextMoveActor = blocks.find((block) => block.block_id === slackIds.blocks.nextMoveActor);
    const visibility = blocks.find((block) => block.block_id === slackIds.blocks.visibility);
    const reviewPoint = blocks.find((block) => block.block_id === slackIds.blocks.reviewPoint);
    const reviewAt = blocks.find((block) => block.block_id === contractInputBlockIds.reviewPointAt);
    const participantsConfirmation = blocks.find(
      (block) => block.block_id === contractInputBlockIds.participantsConfirmation,
    );
    const evidenceConfirmation = blocks.find(
      (block) => block.block_id === contractInputBlockIds.evidenceConfirmation,
    );

    expect(owner?.element as Record<string, unknown>).toMatchObject({
      initial_user: "UCREATOR",
    });
    expect(nextMoveActor?.element as Record<string, unknown>).toMatchObject({
      initial_user: "UCREATOR",
    });
    expect(visibility?.element as Record<string, unknown>).toMatchObject({
      initial_option: { value: "private" },
    });
    expect(reviewPoint?.element as Record<string, unknown>).toMatchObject({
      initial_option: { value: "at" },
    });
    expect(reviewAt?.element as Record<string, unknown>).toMatchObject({
      type: "datetimepicker",
      initial_date_time: Date.parse("2026-07-14T12:00:00.000Z") / 1_000,
    });
    expect(participantsConfirmation?.element as Record<string, unknown>).not.toHaveProperty(
      "initial_options",
    );
    expect(evidenceConfirmation?.element as Record<string, unknown>).not.toHaveProperty(
      "initial_options",
    );
    expect(JSON.stringify(view)).toContain("no automatic reminder is scheduled");
    expect(JSON.stringify(view)).toContain("Participants do not automatically receive access");
    expect(JSON.stringify(view)).toContain("Open selected Slack message");
    expect(JSON.stringify(view)).not.toContain("2026-07-14T12:00:00.000Z");
  });

  it("shows a friendly event review point without exposing a raw ISO field", () => {
    const view = buildContractPreviewModal({
      opaqueReference: "00000000-0000-4000-8000-000000000001",
      creatorSlackUserId: "UCREATOR",
      goal: "Publish the demo",
      definitionOfDone: "A release URL is verified.",
      nextMove: "Post a progress update.",
      reviewPoint: "When the customer replies",
      sourceEvidencePermalink: "https://example.slack.com/archives/C1/p1710000000000100",
    });
    const blocks = view.blocks as Record<string, unknown>[];
    const event = blocks.find((block) => block.block_id === contractInputBlockIds.reviewPointEvent);

    expect(event?.element as Record<string, unknown>).toMatchObject({
      initial_value: "When the customer replies",
      max_length: 500,
    });
    expect(JSON.stringify(view)).toContain("When an event happens");
  });

  it("repopulates a correction with role, privacy, type, and reason confirmation controls", () => {
    const view = buildContractPreviewModal({
      opaqueReference: "00000000-0000-4000-8000-000000000001",
      creatorSlackUserId: "UCREATOR",
      workflow: "correct",
      outcomeType: "decision",
      ownerSlackUserId: "UOWNER",
      reviewerSlackUserId: "UREVIEWER",
      nextMoveActorSlackUserId: "UNEXT",
      privacyScope: "selected_people",
      goal: "Record the launch decision",
      definitionOfDone: "A final decision record exists.",
      nextMove: "Review the options.",
      reviewPoint: "When the review finishes",
      sourceEvidencePermalink: "https://example.slack.com/archives/C1/p1710000000000100",
    });
    const serialized = JSON.stringify(view);

    expect(view.callback_id).toBe(slackIds.views.contractCorrection);
    expect(view.submit).toEqual({ type: "plain_text", text: "Save correction" });
    expect(serialized).toContain(slackIds.blocks.changeReason);
    expect(serialized).toContain("UOWNER");
    expect(serialized).toContain("UREVIEWER");
    expect(serialized).toContain("UNEXT");
    expect(serialized).toContain("selected_people");
    expect(serialized).toContain("decision");
  });

  it("makes delegation scope explicit and does not transfer accountability", () => {
    const view = buildDelegationModal({
      outcomeId: "00000000-0000-4000-8000-000000000001",
      outcomeTitle: "Publish the demo",
    });
    const serialized = JSON.stringify(view);

    expect(view.callback_id).toBe(slackIds.views.delegation);
    expect(serialized).toContain("Accountability remains with you");
    expect(serialized).toContain(slackIds.blocks.delegateUser);
    expect(serialized).toContain(slackIds.blocks.delegatePermissions);
    expect(serialized).toContain(slackIds.blocks.delegateExpiry);
    expect(serialized).toContain("act_as_owner");
  });

  it("keeps long before-and-after previews inside Slack section limits", () => {
    const view = buildActionPreviewModal({
      ...actionPreviewInput,
      beforeText: "b".repeat(10_000),
      afterText: "a".repeat(10_000),
    });
    const sectionTexts = (view.blocks as Record<string, unknown>[]).flatMap((block) => {
      const text = block.text as { text?: unknown } | undefined;
      return typeof text?.text === "string" ? [text.text] : [];
    });

    expect(sectionTexts.every((text) => text.length <= 3_000)).toBe(true);
    expect(sectionTexts.some((text) => text.endsWith("…"))).toBe(true);
  });

  it("bounds previews after mrkdwn entity expansion", () => {
    const view = buildActionPreviewModal({
      ...actionPreviewInput,
      outcomeTitle: "<&>".repeat(2_000),
      beforeText: "<&>".repeat(2_000),
      afterText: "<&>".repeat(2_000),
      evidenceSnapshotIds: ["<&>".repeat(2_000)],
    });
    const sectionTexts = (view.blocks as Record<string, unknown>[]).flatMap((block) => {
      const text = block.text as { text?: unknown } | undefined;
      return typeof text?.text === "string" ? [text.text] : [];
    });

    expect(sectionTexts.every((text) => text.length <= 3_000)).toBe(true);
    expect(sectionTexts.some((text) => text.endsWith("…"))).toBe(true);
    expect(sectionTexts.every((text) => !/&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?…$/u.test(text))).toBe(
      true,
    );
  });

  it("splits and bounds closure goal and definition sections independently", () => {
    const view = buildClosureProofModal({
      outcomeId: "outcome-1",
      outcomeTitle: "<&>".repeat(2_000),
      outcomeType: "request",
      definitionOfDone: "<&>".repeat(2_000),
    });
    const sectionTexts = (view.blocks as Record<string, unknown>[]).flatMap((block) => {
      const text = block.text as { text?: unknown } | undefined;
      return typeof text?.text === "string" ? [text.text] : [];
    });

    expect(sectionTexts.some((text) => text.startsWith("*Outcome*\n"))).toBe(true);
    expect(sectionTexts.some((text) => text.startsWith("*Definition of done*\n"))).toBe(true);
    expect(sectionTexts.every((text) => text.length <= 3_000)).toBe(true);
  });

  it("bounds model-provided plain-text defaults to their input limits", () => {
    const view = buildContractPreviewModal({
      opaqueReference: "00000000-0000-4000-8000-000000000001",
      creatorSlackUserId: "UCREATOR",
      goal: "g".repeat(2_001),
      definitionOfDone: "d".repeat(2_001),
      nextMove: "n".repeat(1_001),
      reviewPoint: "When the release is ready",
      sourceEvidencePermalink: "https://example.slack.com/archives/C1/p1710000000000100",
    });
    const blocks = view.blocks as Record<string, unknown>[];
    const initialValue = (blockId: string): string => {
      const block = blocks.find((candidate) => candidate.block_id === blockId);
      const element = block?.element as { initial_value?: unknown } | undefined;
      if (typeof element?.initial_value !== "string") {
        throw new Error(`Missing initial value for ${blockId}`);
      }
      return element.initial_value;
    };

    expect(initialValue(slackIds.blocks.goal)).toHaveLength(2_000);
    expect(initialValue(slackIds.blocks.definition)).toHaveLength(2_000);
    expect(initialValue(slackIds.blocks.nextMove)).toHaveLength(1_000);
  });

  it("shows the exact target, immutable bindings, hashes, evidence, and expiry", () => {
    const view = buildActionPreviewModal(actionPreviewInput);
    const serialized = JSON.stringify(view);

    expect(serialized).toContain("Approve exact update");
    expect(serialized).toContain("D123");
    expect(serialized).toContain("1710000000.000100");
    expect(serialized).toContain("before-hash");
    expect(serialized).toContain("after-hash");
    expect(serialized).toContain("plan-hash");
    expect(serialized).toContain("Outcome version: 4; contract version: 3");
    expect(serialized).toContain("policy-v1");
    expect(serialized).toContain("evidence-1");
    expect(serialized).toContain("2026-07-14T12:10:00.000Z");
    expect(serialized).toContain("This is reversible");
  });

  it("confirms durable preview acceptance without claiming approval or execution", () => {
    const view = buildActionQueuedModal();
    const serialized = JSON.stringify(view);

    expect(view).not.toHaveProperty("submit");
    expect(serialized).toContain("accepted the durable preview request");
    expect(serialized).toContain("Nothing has been approved or run");
  });

  it("escapes failure copy before putting it in mrkdwn", () => {
    expect(JSON.stringify(buildOperationFailedModal("Do not ping <@U1> & retry."))).toContain(
      "&lt;@U1&gt; &amp; retry.",
    );
  });
});
