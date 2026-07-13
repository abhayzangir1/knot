import { describe, expect, it } from "vitest";

import {
  buildActionReviewCard,
  buildClosureSummaryCard,
  buildDelegateOutcomeCard,
  buildExecutionCard,
  buildNextMoveCard,
  buildOutcomeCancelledCard,
  buildOwnerInvitationCard,
  buildOwnerOutcomeCard,
  buildReadOnlyOutcomeCard,
  buildRequesterActiveCard,
  buildRequesterDeclinedRecoveryCard,
  outcomeCardFallbackText,
} from "../../src/slack/blocks/outcome-cards.js";
import { slackIds } from "../../src/slack/constants.js";
import {
  boundedMrkdwn,
  escapeMrkdwn,
  slackTextLimits,
  truncateSlackText,
} from "../../src/slack/text-limits.js";

const input = {
  outcomeId: "outcome-1",
  title: "Resolve <@U_UNAUTHORIZED> safely",
  state: "active",
  owner: "<@UOWNER>",
  reason: "The owner accepted accountability.",
  nextMove: "Publish the outcome summary.",
  definitionOfDone: "The published outcome summary has a durable reference.",
  recipientRole: "Accountable owner",
  availableActions: ["Check status", "Prepare progress update", "Submit closure evidence"],
  canDelete: true,
};

const invitationInput = {
  outcomeId: "outcome-1",
  title: "Private outcome",
  outcomeType: "Request",
  definitionOfDone: "The requested release is published with a durable reference.",
  nextMove: "Publish the release candidate.",
  nextMoveActor: "<@UNEXTMOVE>",
  reviewPoint: "14 July 2026 at 5:30 PM IST",
  evidenceLabel: "Selected Slack message",
  evidenceLocator: "https://example.slack.com/archives/C123/p1710000000000100",
  participantsSummary: "Requester, accountable owner, next-move owner, independent reviewer",
  privacyScope: "Selected people",
};

const exactExecutionInput = {
  actionPlanId: "plan-1",
  title: "Publish demo",
  approvalKind: "independent" as const,
  target: "Slack app-owned card D123 at 1710000000.000100",
  beforeText: "Before state",
  afterText: "After state",
  planHash: "plan-hash-1",
  expiresAt: "2026-07-14T12:10:00.000Z",
};

function actionIds(blocks: readonly Record<string, unknown>[]): readonly string[] {
  return blocks.flatMap((block) => {
    if (block.type !== "actions" || !Array.isArray(block.elements)) {
      return [];
    }
    return block.elements.flatMap((element) => {
      const actionId =
        element && typeof element === "object" && typeof element.action_id === "string"
          ? element.action_id
          : undefined;
      return actionId ? [actionId] : [];
    });
  });
}

function sectionTexts(blocks: readonly Record<string, unknown>[]): readonly string[] {
  return blocks.flatMap((block) => {
    if (block.type !== "section") {
      return [];
    }
    const text = block.text as { text?: unknown } | undefined;
    return typeof text?.text === "string" ? [text.text] : [];
  });
}

describe("role-specific Slack cards", () => {
  it("limits mutations to the owner while allowing read-only recipients to check status", () => {
    expect(actionIds(buildOwnerOutcomeCard(input))).toEqual([
      slackIds.actions.outcomeCheck,
      slackIds.actions.outcomeMove,
      slackIds.actions.outcomeClose,
      slackIds.actions.outcomeCorrect,
      slackIds.actions.outcomeDelegate,
      slackIds.actions.outcomeDelete,
    ]);
    expect(
      actionIds(buildReadOnlyOutcomeCard({ ...input, recipientRole: "Independent reviewer" })),
    ).toEqual([slackIds.actions.outcomeCheck]);
    expect(actionIds(buildRequesterActiveCard(input))).toEqual([
      slackIds.actions.outcomeCheck,
      slackIds.actions.outcomeCorrect,
      slackIds.actions.outcomeDelete,
    ]);
    expect(actionIds(buildOwnerOutcomeCard({ ...input, canDelete: false }))).not.toContain(
      slackIds.actions.outcomeDelete,
    );
  });

  it("shows cancellation only on the creator's private ownership request", () => {
    expect(actionIds(buildOwnerInvitationCard(invitationInput))).toEqual([
      slackIds.actions.ownerAccept,
      slackIds.actions.ownerDecline,
    ]);
    expect(
      actionIds(
        buildOwnerInvitationCard({
          ...invitationInput,
          canCancel: true,
        }),
      ),
    ).toEqual([
      slackIds.actions.ownerAccept,
      slackIds.actions.ownerDecline,
      slackIds.actions.actionCancel,
    ]);
    expect(actionIds(buildOutcomeCancelledCard({ title: "Private outcome" }))).toEqual([]);
  });

  it("shows the proposed owner the complete contract before acceptance", () => {
    const serialized = JSON.stringify(buildOwnerInvitationCard(invitationInput));

    expect(serialized).toContain(invitationInput.title);
    expect(serialized).toContain(invitationInput.outcomeType);
    expect(serialized).toContain(invitationInput.definitionOfDone);
    expect(serialized).toContain(invitationInput.nextMove);
    expect(serialized).toContain(invitationInput.nextMoveActor);
    expect(serialized).toContain(invitationInput.reviewPoint);
    expect(serialized).toContain(invitationInput.evidenceLabel);
    expect(serialized).toContain(invitationInput.evidenceLocator);
    expect(serialized).toContain(invitationInput.participantsSummary);
    expect(serialized).toContain(invitationInput.privacyScope);
    expect(serialized).toContain("Review every field before accepting");
  });

  it("moves the prepare control to the selected next-move actor when that person is not the owner", () => {
    expect(actionIds(buildOwnerOutcomeCard({ ...input, canPrepareUpdate: false }))).toEqual([
      slackIds.actions.outcomeCheck,
      slackIds.actions.outcomeClose,
      slackIds.actions.outcomeCorrect,
      slackIds.actions.outcomeDelegate,
      slackIds.actions.outcomeDelete,
    ]);
    expect(actionIds(buildNextMoveCard({ ...input, canDelete: false }))).toEqual([
      slackIds.actions.outcomeMove,
    ]);
    expect(actionIds(buildNextMoveCard(input))).toEqual([
      slackIds.actions.outcomeMove,
      slackIds.actions.outcomeCorrect,
      slackIds.actions.outcomeDelete,
    ]);
  });

  it("keeps the definition of done visible on owner and next-move cards", () => {
    for (const card of [buildOwnerOutcomeCard(input), buildNextMoveCard(input)]) {
      const serialized = JSON.stringify(card);
      expect(serialized).toContain("Definition of done");
      expect(serialized).toContain(input.definitionOfDone);
    }
  });

  it("does not expose controls on the final closure summary", () => {
    const blocks = buildClosureSummaryCard({
      title: input.title,
      owner: input.owner,
      recipientRole: "Requester",
      definitionOfDone: "A verified release record exists.",
      evidenceLabel: "Published release",
      evidenceLocator: "https://example.test/releases/1",
      verificationNote:
        "Knot validated authorization and metadata, not the external page contents.",
    });
    expect(actionIds(blocks)).toEqual([]);
    expect(JSON.stringify(blocks)).not.toContain("Verified evidence");
    expect(JSON.stringify(blocks)).toContain("not the external page contents");
  });

  it("exposes reopen only on the accountable owner's canonical closure card", () => {
    const shared = {
      title: input.title,
      owner: input.owner,
      recipientRole: "Requester",
      definitionOfDone: "A verified release record exists.",
      evidenceLabel: "Published release",
      evidenceLocator: "https://example.test/releases/1",
      verificationNote: "The owner attested to this reference.",
    };
    expect(actionIds(buildClosureSummaryCard(shared))).toEqual([]);
    expect(
      actionIds(
        buildClosureSummaryCard({
          ...shared,
          outcomeId: input.outcomeId,
          recipientRole: "Accountable owner",
          canReopen: true,
        }),
      ),
    ).toEqual([slackIds.actions.outcomeReopen]);
  });

  it("limits a delegate card to the stored delegation permissions", () => {
    expect(
      actionIds(
        buildDelegateOutcomeCard({
          ...input,
          permissions: ["edit", "close"],
        }),
      ),
    ).toEqual([
      slackIds.actions.outcomeCheck,
      slackIds.actions.outcomeCorrect,
      slackIds.actions.outcomeClose,
    ]);
    expect(
      actionIds(
        buildDelegateOutcomeCard({
          ...input,
          permissions: ["act_as_owner"],
        }),
      ),
    ).toEqual([
      slackIds.actions.outcomeCheck,
      slackIds.actions.outcomeMove,
      slackIds.actions.outcomeClose,
    ]);
  });

  it("gives the requester an explicit recovery path after ownership decline", () => {
    expect(
      actionIds(
        buildRequesterDeclinedRecoveryCard({
          outcomeId: input.outcomeId,
          title: input.title,
          declineReason: "Cannot own this result.",
        }),
      ),
    ).toEqual([slackIds.actions.ownerReassign, slackIds.actions.actionCancel]);
  });

  it("escapes untrusted closure link delimiters and confirms consequential buttons", () => {
    const closure = buildClosureSummaryCard({
      title: input.title,
      owner: input.owner,
      recipientRole: "Requester",
      definitionOfDone: "A release reference exists.",
      evidenceLabel: "Published release",
      evidenceLocator: "https://example.test/releases/1|fake-label",
      verificationNote: "The owner attested to this reference.",
    });
    expect(JSON.stringify(closure)).toContain("%7Cfake-label");
    expect(JSON.stringify(closure)).not.toContain("|fake-label|Open");

    const execution = buildExecutionCard(exactExecutionInput);
    expect(JSON.stringify(execution)).toContain("Execute this approved update?");
    expect(JSON.stringify(buildOwnerInvitationCard(invitationInput))).toContain(
      "Decline ownership?",
    );
  });

  it("keeps the exact target, plan hash, expiry, and approved change visible", () => {
    const review = buildActionReviewCard({
      actionPlanId: exactExecutionInput.actionPlanId,
      title: exactExecutionInput.title,
      target: exactExecutionInput.target,
      planHash: exactExecutionInput.planHash,
      expiresAt: exactExecutionInput.expiresAt,
    });
    const execution = buildExecutionCard(exactExecutionInput);
    const reviewText = JSON.stringify(review);
    const executionText = JSON.stringify(execution);

    for (const value of [
      exactExecutionInput.target,
      exactExecutionInput.planHash,
      exactExecutionInput.expiresAt,
    ]) {
      expect(reviewText).toContain(value);
      expect(executionText).toContain(value);
    }
    expect(executionText).toContain(exactExecutionInput.beforeText);
    expect(executionText).toContain(exactExecutionInput.afterText);
    const executionSections = sectionTexts(execution);
    expect(executionSections.some((text) => text.startsWith("*Before*\n"))).toBe(true);
    expect(executionSections.some((text) => text.startsWith("*After*\n"))).toBe(true);
  });

  it("escapes user-derived Slack markup in card content", () => {
    const titleBlock = buildReadOnlyOutcomeCard({
      ...input,
      recipientRole: "Requester",
    }).find((block) => block.type === "section" && typeof block.text === "object");
    expect(JSON.stringify(titleBlock)).toContain("&lt;@U_UNAUTHORIZED&gt;");
  });

  it("shows a status projection note without changing the contract summary", () => {
    const card = buildOwnerOutcomeCard({
      ...input,
      statusNote: "Approved <projection>",
    });

    expect(JSON.stringify(card)).toContain("Approved &lt;projection&gt;");
    expect(JSON.stringify(card)).toContain(input.nextMove);
    expect(outcomeCardFallbackText({ ...input, statusNote: "Approved projection" })).toContain(
      "Status update: Approved projection",
    );
  });

  it("makes personal confirmation explicit on the execution card", () => {
    const card = buildExecutionCard({
      ...exactExecutionInput,
      title: "Publish <demo>",
      approvalKind: "personal",
    });

    expect(JSON.stringify(card)).toContain("You explicitly confirmed");
    expect(JSON.stringify(card)).not.toContain("An independent reviewer approved");
    expect(JSON.stringify(card)).toContain("Publish &lt;demo&gt;");
  });

  it("uses a plain owner fallback instead of exposing Slack mention syntax", () => {
    const generic = outcomeCardFallbackText(input);
    const named = outcomeCardFallbackText({ ...input, ownerFallback: "Release owner" });

    expect(generic).toContain("Owner: Accountable owner");
    expect(generic).not.toContain(input.owner);
    expect(named).toContain("Owner: Release owner");
  });

  it("bounds final escaped card content after entity expansion", () => {
    const entityHeavy = "<&>".repeat(2_000);
    const ownerCard = buildOwnerOutcomeCard({
      ...input,
      title: entityHeavy,
      reason: entityHeavy,
      nextMove: entityHeavy,
      definitionOfDone: entityHeavy,
      statusNote: entityHeavy,
    });
    const execution = buildExecutionCard({
      ...exactExecutionInput,
      title: entityHeavy,
      target: entityHeavy,
      beforeText: entityHeavy,
      afterText: entityHeavy,
    });

    for (const blocks of [ownerCard, execution]) {
      for (const block of blocks) {
        const text = block.text as { type?: unknown; text?: unknown } | undefined;
        if (typeof text?.text === "string" && text.type === "mrkdwn") {
          expect(text.text.length).toBeLessThanOrEqual(slackTextLimits.section);
          expect(text.text).not.toMatch(/&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?\u2026$/u);
        }
        if (Array.isArray(block.fields)) {
          for (const field of block.fields as { text?: unknown }[]) {
            if (typeof field.text === "string") {
              expect(field.text.length).toBeLessThanOrEqual(slackTextLimits.field);
            }
          }
        }
        if (block.type === "context" && Array.isArray(block.elements)) {
          for (const element of block.elements as { text?: unknown }[]) {
            if (typeof element.text === "string") {
              expect(element.text.length).toBeLessThanOrEqual(slackTextLimits.context);
              expect(element.text).not.toMatch(/&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?\u2026$/u);
            }
          }
        }
      }
    }
  });

  it("handles exact boundaries, entity boundaries, and surrogate pairs", () => {
    const exact = "x".repeat(slackTextLimits.section);
    expect(boundedMrkdwn(exact)).toBe(exact);

    const expanded = boundedMrkdwn(escapeMrkdwn("<".repeat(slackTextLimits.section)));
    expect(expanded.length).toBeLessThanOrEqual(slackTextLimits.section);
    expect(expanded.endsWith("\u2026")).toBe(true);
    expect(expanded).not.toMatch(/&(?:a(?:m(?:p)?)?|l(?:t)?|g(?:t)?)?\u2026$/u);

    const surrogateBoundary = truncateSlackText(
      `${"x".repeat(slackTextLimits.header - 2)}\ud83d\ude00z`,
      slackTextLimits.header,
    );
    expect(surrogateBoundary.length).toBeLessThanOrEqual(slackTextLimits.header);
    expect(surrogateBoundary).not.toContain("\ud83d\u2026");
    expect(surrogateBoundary.endsWith("\u2026")).toBe(true);
  });
});
