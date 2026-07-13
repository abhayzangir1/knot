import { brand } from "../../config/brand.js";
import type { OutcomeType } from "../../outcomes/index.js";
import { type SlackView, slackIds } from "../constants.js";
import { contractInputBlockIds } from "../contract-input.js";
import { boundedMrkdwn, boundedPlainText, escapeMrkdwn, slackTextLimits } from "../text-limits.js";

export type ContractPreviewDefaults = {
  opaqueReference: string;
  creatorSlackUserId: string;
  goal: string;
  definitionOfDone: string;
  nextMove: string;
  reviewPoint: string;
  sourceEvidencePermalink: string;
  workflow?: "create" | "correct" | "reassign";
  outcomeType?: OutcomeType;
  ownerSlackUserId?: string;
  reviewerSlackUserId?: string;
  nextMoveActorSlackUserId?: string;
  privacyScope?: "private" | "selected_people";
};

function sourceEvidenceLink(permalink: string): string {
  const parsed = new URL(permalink);
  if (parsed.protocol !== "https:") {
    throw new Error("Source evidence must use an HTTPS Slack permalink.");
  }
  return `<${parsed.toString()}|Open selected Slack message>`;
}

function reviewPointDefaults(
  reviewPoint: string,
): { kind: "at"; initialDateTime: number } | { kind: "on_event"; event: string } | undefined {
  if (!reviewPoint.trim()) {
    return undefined;
  }
  const parsed = Date.parse(reviewPoint);
  if (!Number.isNaN(parsed)) {
    return { kind: "at", initialDateTime: Math.floor(parsed / 1_000) };
  }
  return { kind: "on_event", event: reviewPoint.slice(0, 500) };
}

export function buildPreparingOutcomeModal(opaqueReference: string): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ ref: opaqueReference }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Preparing an outcome preview from the selected message. Nothing has been created or shared yet.",
        },
      },
    ],
  };
}

export function buildPreparingActionModal(opaqueReference: string): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ ref: opaqueReference }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Preparing an immutable preview of the proposed Slack update. Nothing has run yet.",
        },
      },
    ],
  };
}

export function buildPreparingClosureModal(outcomeId: string): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ ref: outcomeId }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Preparing the type-specific closure requirements. Nothing has been closed yet.",
        },
      },
    ],
  };
}

export function buildPreparingChangeModal(
  outcomeId: string,
  message = "Preparing the current Outcome Contract. Nothing has changed yet.",
): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify({ ref: outcomeId }),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: boundedMrkdwn(escapeMrkdwn(message)) },
      },
    ],
  };
}

export function buildDelegationModal(input: {
  outcomeId: string;
  outcomeTitle: string;
}): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.delegation,
    submit: { type: "plain_text", text: "Create delegation" },
    close: { type: "plain_text", text: "Cancel" },
    title: { type: "plain_text", text: "Delegate authority" },
    private_metadata: JSON.stringify({ ref: input.outcomeId }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Outcome*\n${escapeMrkdwn(input.outcomeTitle)}\nAccountability remains with you. The selected person receives only the checked permissions.`,
          ),
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.delegateUser,
        label: { type: "plain_text", text: "Who will act as your delegate?" },
        element: {
          type: "users_select",
          action_id: "value",
          placeholder: { type: "plain_text", text: "Choose an active human member" },
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.delegatePermissions,
        label: { type: "plain_text", text: "What may this delegate do?" },
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [
            { text: { type: "plain_text", text: "Edit the Outcome Contract" }, value: "edit" },
            { text: { type: "plain_text", text: "Execute an approved update" }, value: "execute" },
            { text: { type: "plain_text", text: "Submit closure evidence" }, value: "close" },
            {
              text: { type: "plain_text", text: "Act for the owner where policy allows" },
              value: "act_as_owner",
            },
          ],
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.delegateExpiry,
        optional: true,
        label: { type: "plain_text", text: "When should this delegation expire?" },
        hint: { type: "plain_text", text: "Optional. Leave blank for no automatic expiry." },
        element: { type: "datetimepicker", action_id: "value" },
      },
    ],
  };
}

export function buildActionQueuedModal(): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "Knot accepted the durable preview request. It will send a private *Review exact update* request when the immutable plan is ready. Nothing has been approved or run.",
        },
      },
    ],
  };
}

export function buildActionSentForReviewModal(): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "The immutable preview was sent to the independent reviewer. The update remains planned and will not run unless they approve this exact plan.",
        },
      },
    ],
  };
}

export function buildOperationFailedModal(message: string): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.preparing,
    title: { type: "plain_text", text: brand.name },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(`Knot could not finish that step. ${escapeMrkdwn(message)}`),
        },
      },
    ],
  };
}

export function buildContractPreviewModal(defaults: ContractPreviewDefaults): SlackView {
  const workflow = defaults.workflow ?? "create";
  const callbackId =
    workflow === "correct"
      ? slackIds.views.contractCorrection
      : workflow === "reassign"
        ? slackIds.views.ownerReassignment
        : slackIds.views.contractPreview;
  const submitLabel =
    workflow === "correct"
      ? "Save correction"
      : workflow === "reassign"
        ? "Request new owner"
        : "Create outcome";
  const selectedType = defaults.outcomeType ?? "request";
  const typeLabels: Record<OutcomeType, string> = {
    request: "Request",
    decision: "Decision",
    commitment: "Commitment",
    handoff: "Handoff",
    other: "Other",
  };
  const reviewPoint = reviewPointDefaults(defaults.reviewPoint);
  const reviewPointOptions = [
    {
      text: { type: "plain_text", text: "Specific date and time" },
      value: "at",
    },
    {
      text: { type: "plain_text", text: "When an event happens" },
      value: "on_event",
    },
  ];
  return {
    type: "modal",
    callback_id: callbackId,
    submit: { type: "plain_text", text: submitLabel },
    close: { type: "plain_text", text: "Cancel" },
    title: {
      type: "plain_text",
      text:
        workflow === "create"
          ? "Tie it up"
          : workflow === "correct"
            ? "Correct outcome"
            : "Reassign owner",
    },
    private_metadata: JSON.stringify({ ref: defaults.opaqueReference }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            workflow === "create"
              ? "Confirm or edit every field. Knot will not activate or share the outcome until the complete contract and ownership acceptance are recorded."
              : "Review every field again. The deterministic service will reject an unauthorized, incomplete, or stale change.",
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.outcomeType,
        label: { type: "plain_text", text: "What kind of outcome is this?" },
        hint: {
          type: "plain_text",
          text: "Choose the type that determines the evidence Knot will require before closure.",
        },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: {
            text: { type: "plain_text", text: typeLabels[selectedType] },
            value: selectedType,
          },
          options: [
            { text: { type: "plain_text", text: "Request" }, value: "request" },
            { text: { type: "plain_text", text: "Decision" }, value: "decision" },
            { text: { type: "plain_text", text: "Commitment" }, value: "commitment" },
            { text: { type: "plain_text", text: "Handoff" }, value: "handoff" },
            { text: { type: "plain_text", text: "Other" }, value: "other" },
          ],
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.goal,
        label: { type: "plain_text", text: "What are we trying to achieve?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          initial_value: boundedPlainText(defaults.goal, 2_000),
          min_length: 1,
          max_length: 2000,
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.owner,
        label: { type: "plain_text", text: "Who needs to accept ownership?" },
        element: {
          type: "users_select",
          action_id: "value",
          initial_user: defaults.ownerSlackUserId ?? defaults.creatorSlackUserId,
          placeholder: { type: "plain_text", text: "Choose one accountable owner" },
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.reviewer,
        optional: true,
        label: { type: "plain_text", text: "Who can independently approve a shared update?" },
        hint: {
          type: "plain_text",
          text: "Required for shared outcomes; this person cannot be the requester, owner, or next-move owner.",
        },
        element: {
          type: "users_select",
          action_id: "value",
          ...(defaults.reviewerSlackUserId ? { initial_user: defaults.reviewerSlackUserId } : {}),
          placeholder: { type: "plain_text", text: "Choose an independent reviewer" },
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.definition,
        label: { type: "plain_text", text: "What counts as done?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          multiline: true,
          ...(defaults.definitionOfDone
            ? { initial_value: boundedPlainText(defaults.definitionOfDone, 2_000) }
            : {}),
          min_length: 1,
          max_length: 2000,
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.nextMove,
        label: { type: "plain_text", text: "What should happen next?" },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(defaults.nextMove
            ? { initial_value: boundedPlainText(defaults.nextMove, 1_000) }
            : {}),
          min_length: 1,
          max_length: 1000,
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.nextMoveActor,
        label: { type: "plain_text", text: "Who will take the next move?" },
        hint: {
          type: "plain_text",
          text: "Only this person receives the Prepare progress update control. Choose yourself for a personal outcome.",
        },
        element: {
          type: "users_select",
          action_id: "value",
          initial_user: defaults.nextMoveActorSlackUserId ?? defaults.creatorSlackUserId,
          placeholder: { type: "plain_text", text: "Choose the next-move owner" },
        },
      },
      {
        type: "input",
        block_id: contractInputBlockIds.participantsConfirmation,
        label: { type: "plain_text", text: "Confirm participant roles" },
        hint: {
          type: "plain_text",
          text: "You are the requester. The selections above define the owner, next-move owner, and optional reviewer. Participants do not automatically receive access.",
        },
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [
            {
              text: { type: "plain_text", text: "I reviewed these participant roles" },
              value: "confirmed",
            },
          ],
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.reviewPoint,
        label: { type: "plain_text", text: "What triggers the next review?" },
        hint: {
          type: "plain_text",
          text: "Knot records this review point; no automatic reminder is scheduled.",
        },
        element: {
          type: "static_select",
          action_id: "value",
          ...(reviewPoint
            ? {
                initial_option: reviewPointOptions.find(
                  (option) => option.value === reviewPoint.kind,
                ),
              }
            : {}),
          options: reviewPointOptions,
        },
      },
      {
        type: "input",
        block_id: contractInputBlockIds.reviewPointAt,
        optional: true,
        label: { type: "plain_text", text: "Review date and time" },
        hint: {
          type: "plain_text",
          text: "Required only when you chose a specific date and time.",
        },
        element: {
          type: "datetimepicker",
          action_id: "value",
          ...(reviewPoint?.kind === "at" ? { initial_date_time: reviewPoint.initialDateTime } : {}),
        },
      },
      {
        type: "input",
        block_id: contractInputBlockIds.reviewPointEvent,
        optional: true,
        label: { type: "plain_text", text: "Review event" },
        hint: {
          type: "plain_text",
          text: "Required only when you chose an event, such as: When the customer replies.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          ...(reviewPoint?.kind === "on_event" && reviewPoint.event
            ? { initial_value: reviewPoint.event }
            : {}),
          min_length: 1,
          max_length: 500,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Source evidence*\n${sourceEvidenceLink(defaults.sourceEvidencePermalink)}\nThis source establishes why the outcome exists; it is not completion evidence.`,
          ),
        },
      },
      {
        type: "input",
        block_id: contractInputBlockIds.evidenceConfirmation,
        label: { type: "plain_text", text: "Confirm source evidence" },
        hint: {
          type: "plain_text",
          text: "Open the selected message before confirming. Knot stores its reference, not a claim that the outcome is complete.",
        },
        element: {
          type: "checkboxes",
          action_id: "value",
          options: [
            {
              text: { type: "plain_text", text: "I reviewed this source evidence" },
              value: "confirmed",
            },
          ],
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.visibility,
        label: { type: "plain_text", text: "Who can see this outcome?" },
        hint: {
          type: "plain_text",
          text: "Only me is the least-privilege default. Selected people includes only the requester, owner, next-move owner, and reviewer.",
        },
        element: {
          type: "static_select",
          action_id: "value",
          initial_option: {
            text: {
              type: "plain_text",
              text: defaults.privacyScope === "selected_people" ? "Selected people" : "Only me",
            },
            value: defaults.privacyScope ?? "private",
          },
          options: [
            {
              text: { type: "plain_text", text: "Only me" },
              value: "private",
            },
            {
              text: { type: "plain_text", text: "Selected people" },
              value: "selected_people",
            },
          ],
        },
      },
      ...(workflow === "create"
        ? []
        : [
            {
              type: "input",
              block_id: slackIds.blocks.changeReason,
              label: { type: "plain_text", text: "Why is this change needed?" },
              element: {
                type: "plain_text_input",
                action_id: "value",
                min_length: 3,
                max_length: 500,
              },
            },
          ]),
    ],
  };
}

export function buildActionPreviewModal(input: {
  opaqueReference: string;
  outcomeTitle: string;
  target: { channelId: string; messageTs: string };
  beforeText: string;
  afterText: string;
  beforeBlocksHash: string;
  afterBlocksHash: string;
  planHash: string;
  outcomeVersion: number;
  contractVersion: number;
  policyVersion: string;
  evidenceSnapshotIds: readonly string[];
  expiresAt: string;
  reversibility: "reversible" | "compensatable" | "irreversible";
}): SlackView {
  const reversibilityCopy =
    input.reversibility === "reversible"
      ? "This is reversible: Knot can restore the exact previous outcome card."
      : input.reversibility === "compensatable"
        ? "This has a compensating action, but recipients may still see the original change."
        : "This cannot be safely undone after it runs.";

  return {
    type: "modal",
    callback_id: slackIds.views.actionPreview,
    submit: { type: "plain_text", text: "Approve exact update" },
    close: { type: "plain_text", text: "Cancel" },
    title: { type: "plain_text", text: "Review exact update" },
    private_metadata: JSON.stringify({ ref: input.opaqueReference }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Outcome*\n${escapeMrkdwn(input.outcomeTitle)}`),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Exact target*\nChannel \`${escapeMrkdwn(input.target.channelId)}\`, message \`${escapeMrkdwn(input.target.messageTs)}\``,
          ),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Before*\n${escapeMrkdwn(input.beforeText)}`),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(`*After*\n${escapeMrkdwn(input.afterText)}`),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Approval binding*\nPlan hash: \`${escapeMrkdwn(input.planHash)}\`\nOutcome version: ${input.outcomeVersion}; contract version: ${input.contractVersion}\nPolicy version: \`${escapeMrkdwn(input.policyVersion)}\`\nEvidence snapshot: ${
              input.evidenceSnapshotIds.length > 0
                ? input.evidenceSnapshotIds
                    .map((evidenceId) => `\`${escapeMrkdwn(evidenceId)}\``)
                    .join(", ")
                : "No evidence references"
            }\nExpires at: ${escapeMrkdwn(input.expiresAt)}`,
          ),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Exact Block Kit payload hashes*\nBefore: \`${escapeMrkdwn(input.beforeBlocksHash)}\`\nAfter: \`${escapeMrkdwn(input.afterBlocksHash)}\``,
          ),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: boundedMrkdwn(
              `${reversibilityCopy} Close this review to leave the plan unapproved; it expires automatically.`,
              slackTextLimits.context,
            ),
          },
        ],
      },
    ],
  };
}

function closureRequirement(type: OutcomeType): string {
  switch (type) {
    case "request":
      return "A delivery, answer, or explicit-decline record that resolves the request.";
    case "decision":
      return "The final decision record acknowledged by the accountable decider.";
    case "commitment":
      return "A completion record, or an authorized renegotiation or decline record.";
    case "handoff":
      return "An accessible handoff confirmation showing that the receiving owner accepted the handoff.";
    case "other":
      return "A completion record supporting the observable definition of done.";
  }
}

export function buildClosureProofModal(input: {
  outcomeId: string;
  outcomeTitle: string;
  outcomeType: OutcomeType;
  definitionOfDone: string;
}): SlackView {
  return {
    type: "modal",
    callback_id: slackIds.views.closureProof,
    submit: { type: "plain_text", text: "Confirm and close" },
    close: { type: "plain_text", text: "Cancel" },
    title: { type: "plain_text", text: "Confirm closure" },
    private_metadata: JSON.stringify({ ref: input.outcomeId }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Outcome*\n${escapeMrkdwn(input.outcomeTitle)}`),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Definition of done*\n${escapeMrkdwn(input.definitionOfDone)}`),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Required ${escapeMrkdwn(input.outcomeType)} evidence*\n${escapeMrkdwn(closureRequirement(input.outcomeType))}`,
          ),
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "By submitting, you attest that this specific HTTPS reference supports the definition of done and the requirement above. Knot validates your authority, evidence type, freshness, and reference format; it does not independently inspect the external page contents.",
        },
      },
      {
        type: "input",
        block_id: slackIds.blocks.closureEvidence,
        label: { type: "plain_text", text: "Completion evidence reference" },
        hint: {
          type: "plain_text",
          text: "An HTTPS Slack permalink or another durable HTTPS reference.",
        },
        element: {
          type: "plain_text_input",
          action_id: "value",
          min_length: 1,
          max_length: 2000,
        },
      },
    ],
  };
}
