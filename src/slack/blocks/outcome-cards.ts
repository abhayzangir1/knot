import { brand } from "../../config/brand.js";
import { type Block, slackIds } from "../constants.js";
import { boundedMrkdwn, boundedPlainText, escapeMrkdwn, slackTextLimits } from "../text-limits.js";

export type OutcomeCardInput = {
  outcomeId: string;
  title: string;
  state: string;
  owner: string;
  ownerFallback?: string;
  reason: string;
  nextMove: string;
  canPrepareUpdate?: boolean;
  canDelete?: boolean;
  statusNote?: string;
  definitionOfDone?: string | undefined;
  recipientRole?: string;
  availableActions?: readonly string[];
};

function escapeSlackLinkTarget(value: string): string {
  return value.replaceAll("|", "%7C").replaceAll("<", "%3C").replaceAll(">", "%3E");
}

function stateLabel(state: string): string {
  return state.replaceAll("_", " ").toUpperCase();
}

export function outcomeCardFallbackText(input: OutcomeCardInput): string {
  const role = input.recipientRole ? ` Your role: ${input.recipientRole}.` : "";
  const definition = input.definitionOfDone
    ? ` Definition of done: ${input.definitionOfDone}.`
    : "";
  const actions = input.availableActions?.length
    ? ` Available actions: ${input.availableActions.join(", ")}.`
    : "";
  return boundedPlainText(
    `${stateLabel(input.state)}. ${input.title}. Owner: ${input.ownerFallback ?? "Accountable owner"}.${role} ${input.reason}. Next move: ${input.nextMove}.${definition}${actions}${input.statusNote ? ` Status update: ${input.statusNote}` : ""}`,
    slackTextLimits.fallback,
  );
}

function outcomeSummaryBlocks(input: OutcomeCardInput, recipientRole: string): Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: boundedPlainText(stateLabel(input.state), slackTextLimits.header),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(`*Outcome*\n${escapeMrkdwn(input.title)}`),
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Owner*\n${input.owner}`, slackTextLimits.field),
        },
        {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Your role*\n${escapeMrkdwn(recipientRole)}`, slackTextLimits.field),
        },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(`*What matters*\n${escapeMrkdwn(input.reason)}`),
      },
    },
    ...(input.definitionOfDone
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: boundedMrkdwn(`*Definition of done*\n${escapeMrkdwn(input.definitionOfDone)}`),
            },
          },
        ]
      : []),
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(`*Recommended next move*\n${escapeMrkdwn(input.nextMove)}`),
      },
    },
  ];
  if (input.statusNote) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(escapeMrkdwn(input.statusNote), slackTextLimits.context),
        },
      ],
    });
  }
  return blocks;
}

/** The canonical status card is delivered to the accountable owner. */
export function buildOwnerOutcomeCard(input: OutcomeCardInput): readonly Block[] {
  const elements: Block[] = [
    {
      type: "button",
      text: { type: "plain_text", text: brand.copy.check },
      action_id: slackIds.actions.outcomeCheck,
      value: input.outcomeId,
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Submit closure evidence" },
      action_id: slackIds.actions.outcomeClose,
      value: input.outcomeId,
    },
  ];

  if (input.canPrepareUpdate !== false) {
    elements.splice(1, 0, {
      type: "button",
      text: { type: "plain_text", text: brand.copy.move },
      action_id: slackIds.actions.outcomeMove,
      value: input.outcomeId,
      style: "primary",
    });
  }

  return [
    ...outcomeSummaryBlocks(input, "Accountable owner"),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            input.canPrepareUpdate === false
              ? "*Your actions:* check status or submit closure evidence when the result is done. The named next-move owner receives the update control separately."
              : "*Your actions:* check status, prepare the next update, or submit closure evidence when the result is done.",
        },
      ],
    },
    {
      type: "actions",
      elements,
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "*Manage outcome:* corrections are versioned, delegation never transfers accountability, and deletion removes private content while retaining a redacted audit tombstone.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Correct outcome" },
          action_id: slackIds.actions.outcomeCorrect,
          value: input.outcomeId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Delegate authority" },
          action_id: slackIds.actions.outcomeDelegate,
          value: input.outcomeId,
        },
        ...(input.canDelete
          ? [
              {
                type: "button",
                text: { type: "plain_text", text: "Delete private content" },
                action_id: slackIds.actions.outcomeDelete,
                value: input.outcomeId,
                style: "danger",
                confirm: {
                  title: { type: "plain_text", text: "Delete this outcome?" },
                  text: {
                    type: "mrkdwn",
                    text: "This permanently removes the Outcome Contract and private evidence references. Knot retains only a non-sensitive audit tombstone; this cannot be undone.",
                  },
                  confirm: { type: "plain_text", text: "Delete permanently" },
                  deny: { type: "plain_text", text: "Keep outcome" },
                },
              },
            ]
          : []),
      ],
    },
  ];
}

/** The creator manages corrections and deletion but cannot take owner-only actions. */
export function buildRequesterActiveCard(input: OutcomeCardInput): readonly Block[] {
  return [
    ...outcomeSummaryBlocks(input, "Requester"),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "*Your actions:* check status, submit a versioned correction, or permanently delete private outcome content. Ownership, execution, and closure stay with their named roles.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: brand.copy.check },
          action_id: slackIds.actions.outcomeCheck,
          value: input.outcomeId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Correct outcome" },
          action_id: slackIds.actions.outcomeCorrect,
          value: input.outcomeId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Delete private content" },
          action_id: slackIds.actions.outcomeDelete,
          value: input.outcomeId,
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Delete this outcome?" },
            text: {
              type: "mrkdwn",
              text: "This permanently removes the Outcome Contract and private evidence references. Knot retains only a non-sensitive audit tombstone; this cannot be undone.",
            },
            confirm: { type: "plain_text", text: "Delete permanently" },
            deny: { type: "plain_text", text: "Keep outcome" },
          },
        },
      ],
    },
  ];
}

/** A delegate sees only controls represented by the stored, active delegation. */
export function buildDelegateOutcomeCard(
  input: OutcomeCardInput & {
    permissions: readonly ("edit" | "execute" | "close" | "act_as_owner")[];
  },
): readonly Block[] {
  const elements: Block[] = [
    {
      type: "button",
      text: { type: "plain_text", text: brand.copy.check },
      action_id: slackIds.actions.outcomeCheck,
      value: input.outcomeId,
    },
  ];
  if (input.permissions.includes("edit")) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Correct outcome" },
      action_id: slackIds.actions.outcomeCorrect,
      value: input.outcomeId,
    });
  }
  if (input.permissions.includes("execute") || input.permissions.includes("act_as_owner")) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: brand.copy.move },
      action_id: slackIds.actions.outcomeMove,
      value: input.outcomeId,
      style: "primary",
    });
  }
  if (input.permissions.includes("close") || input.permissions.includes("act_as_owner")) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Submit closure evidence" },
      action_id: slackIds.actions.outcomeClose,
      value: input.outcomeId,
    });
  }
  return [
    ...outcomeSummaryBlocks(input, "Owner delegate"),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Accountability remains with the owner. Your active permissions: ${input.permissions.join(", ")}. Every action is rechecked when used.`,
        },
      ],
    },
    { type: "actions", elements },
  ];
}

/** A non-owner next-move actor receives exactly one role-bound control. */
export function buildNextMoveCard(input: OutcomeCardInput): readonly Block[] {
  const elements: Block[] = [
    {
      type: "button",
      text: { type: "plain_text", text: brand.copy.move },
      action_id: slackIds.actions.outcomeMove,
      value: input.outcomeId,
      style: "primary",
    },
  ];
  if (input.canDelete) {
    elements.push(
      {
        type: "button",
        text: { type: "plain_text", text: "Correct outcome" },
        action_id: slackIds.actions.outcomeCorrect,
        value: input.outcomeId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Delete private content" },
        action_id: slackIds.actions.outcomeDelete,
        value: input.outcomeId,
        style: "danger",
        confirm: {
          title: { type: "plain_text", text: "Delete this outcome?" },
          text: {
            type: "mrkdwn",
            text: "This permanently removes the Outcome Contract and private evidence references. Knot retains only a non-sensitive audit tombstone; this cannot be undone.",
          },
          confirm: { type: "plain_text", text: "Delete permanently" },
          deny: { type: "plain_text", text: "Keep outcome" },
        },
      },
    );
  }
  return [
    ...outcomeSummaryBlocks(input, "Next-move owner"),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "*Your action:* prepare the immutable update. Knot will route approval and execution to the authorized people.",
        },
      ],
    },
    {
      type: "actions",
      elements,
    },
  ];
}

/** View-only updates never expose controls the recipient cannot exercise. */
export function buildReadOnlyOutcomeCard(
  input: OutcomeCardInput & {
    recipientRole: string;
  },
): readonly Block[] {
  return [
    ...outcomeSummaryBlocks(input, input.recipientRole),
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "This status card cannot change the outcome. You can retrieve the current evidence-based assessment; Knot will send a separate request if your authorization is needed.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: brand.copy.check },
          action_id: slackIds.actions.outcomeCheck,
          value: input.outcomeId,
        },
      ],
    },
  ];
}

/** Detailed closure is delivered only to principals explicitly allowed to view evidence. */
export function buildClosureSummaryCard(input: {
  outcomeId?: string;
  title: string;
  owner: string;
  recipientRole: string;
  definitionOfDone: string;
  evidenceLabel: string;
  evidenceLocator: string;
  verificationNote: string;
  canReopen?: boolean;
}): readonly Block[] {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "CLOSED" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(`*Outcome*\n${escapeMrkdwn(input.title)}`),
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Owner*\n${input.owner}`, slackTextLimits.field),
        },
        {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Your role*\n${escapeMrkdwn(input.recipientRole)}`,
            slackTextLimits.field,
          ),
        },
      ],
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
          `*Closure evidence reference*\n${escapeMrkdwn(input.evidenceLabel)} — <${escapeSlackLinkTarget(input.evidenceLocator)}|Open submitted closure evidence>`,
        ),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(escapeMrkdwn(input.verificationNote), slackTextLimits.context),
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Knot retained the outcome and its audit record; it did not create or delete a Slack channel.",
        },
      ],
    },
  ];
  if (input.canReopen && input.outcomeId) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Reopen outcome" },
          action_id: slackIds.actions.outcomeReopen,
          value: input.outcomeId,
          confirm: {
            title: { type: "plain_text", text: "Reopen this outcome?" },
            text: {
              type: "mrkdwn",
              text: "Knot will return the outcome to Active and mark the former closure evidence stale. It will not erase the closure audit trail.",
            },
            confirm: { type: "plain_text", text: "Reopen outcome" },
            deny: { type: "plain_text", text: "Keep closed" },
          },
        },
      ],
    });
  }
  return blocks;
}

export function buildOwnerInvitationCard(input: {
  outcomeId: string;
  title: string;
  outcomeType: string;
  definitionOfDone: string;
  nextMove: string;
  nextMoveActor: string;
  reviewPoint: string;
  evidenceLabel: string;
  evidenceLocator: string;
  participantsSummary: string;
  privacyScope: string;
  canCancel?: boolean;
}): readonly Block[] {
  const elements: Block[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Accept ownership" },
      action_id: slackIds.actions.ownerAccept,
      value: input.outcomeId,
      style: "primary",
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Decline ownership" },
      action_id: slackIds.actions.ownerDecline,
      value: input.outcomeId,
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Decline ownership?" },
        text: {
          type: "mrkdwn",
          text: "Knot will keep the outcome inactive and return it to the requester for clarification or reassignment.",
        },
        confirm: { type: "plain_text", text: "Decline ownership" },
        deny: { type: "plain_text", text: "Keep request" },
      },
    },
  ];
  if (input.canCancel) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Cancel outcome" },
      action_id: slackIds.actions.actionCancel,
      value: input.outcomeId,
      style: "danger",
      confirm: {
        title: { type: "plain_text", text: "Cancel this outcome?" },
        text: {
          type: "mrkdwn",
          text: "Knot will stop coordination without claiming completion and retain a minimal audit record.",
        },
        confirm: { type: "plain_text", text: "Cancel outcome" },
        deny: { type: "plain_text", text: "Keep outcome" },
      },
    });
  }
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Outcome*\n${escapeMrkdwn(input.title)}\n\nKnot is asking whether you will accept accountability for this complete Outcome Contract. Review every field before accepting.`,
        ),
      },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(`*Type*\n${escapeMrkdwn(input.outcomeType)}`, slackTextLimits.field),
        },
        {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Privacy scope*\n${escapeMrkdwn(input.privacyScope)}`,
            slackTextLimits.field,
          ),
        },
      ],
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
          `*Next move*\n${escapeMrkdwn(input.nextMove)}\n*Next-move owner*\n${input.nextMoveActor}`,
        ),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Review point*\n${escapeMrkdwn(input.reviewPoint)}\n*Participants*\n${escapeMrkdwn(input.participantsSummary)}`,
        ),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Source evidence*\n${escapeMrkdwn(input.evidenceLabel)} — <${escapeSlackLinkTarget(input.evidenceLocator)}|Open source evidence>`,
        ),
      },
    },
    {
      type: "actions",
      elements,
    },
  ];
}

export function buildRequesterOutcomeCard(input: {
  outcomeId: string;
  title: string;
  sourcePermalink: string;
}): readonly Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Outcome created:* ${escapeMrkdwn(input.title)}\nKnot sent the ownership request. The outcome remains private to its selected audience and is not active until the owner accepts.`,
        ),
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `<${escapeSlackLinkTarget(input.sourcePermalink)}|Open the selected source message>`,
        ),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel outcome" },
          action_id: slackIds.actions.actionCancel,
          value: input.outcomeId,
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Cancel this outcome?" },
            text: {
              type: "mrkdwn",
              text: "Knot will stop coordination without claiming completion and retain a minimal audit record.",
            },
            confirm: { type: "plain_text", text: "Cancel outcome" },
            deny: { type: "plain_text", text: "Keep outcome" },
          },
        },
      ],
    },
  ];
}

export function buildOutcomeCancelledCard(input: { title: string }): readonly Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "CANCELLED" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Outcome*\n${escapeMrkdwn(input.title)}\nCoordination stopped without claiming completion. No further action is scheduled.`,
        ),
      },
    },
  ];
}

export function buildOutcomeDeletedCard(): readonly Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "DELETED" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          "The Outcome Contract and private evidence references were permanently removed. Knot retained only a non-sensitive audit tombstone; this action cannot be undone.",
        ),
      },
    },
  ];
}

export function buildOwnerDeclinedCard(input: { title: string }): readonly Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Ownership declined*\n${escapeMrkdwn(input.title)}\nKnot kept the outcome private and returned it to the requester for clarification or reassignment.`,
        ),
      },
    },
  ];
}

export function buildRequesterDeclinedRecoveryCard(input: {
  outcomeId: string;
  title: string;
  declineReason: string;
}): readonly Block[] {
  return [
    {
      type: "header",
      text: { type: "plain_text", text: "OWNER DECLINED" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Outcome*\n${escapeMrkdwn(input.title)}\n\nThe proposed owner declined: ${escapeMrkdwn(input.declineReason)}. The outcome remains private and inactive.`,
        ),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Choose a different proposed owner and reconfirm every Outcome Contract field, or cancel coordination without claiming completion.",
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Reassign owner" },
          action_id: slackIds.actions.ownerReassign,
          value: input.outcomeId,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel outcome" },
          action_id: slackIds.actions.actionCancel,
          value: input.outcomeId,
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Cancel this outcome?" },
            text: {
              type: "mrkdwn",
              text: "Knot will stop coordination without claiming completion and retain a minimal audit record.",
            },
            confirm: { type: "plain_text", text: "Cancel outcome" },
            deny: { type: "plain_text", text: "Keep outcome" },
          },
        },
      ],
    },
  ];
}

export function buildRollbackCard(input: {
  actionPlanId: string;
  title: string;
}): readonly Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `The approved update for *${escapeMrkdwn(input.title)}* was applied and its Slack receipt was recorded. You can restore the exact previous card if the update is no longer wanted.`,
        ),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Restore previous card" },
          action_id: slackIds.actions.actionRollback,
          value: input.actionPlanId,
          confirm: {
            title: { type: "plain_text", text: "Restore the previous card?" },
            text: {
              type: "mrkdwn",
              text: "Knot will first verify that the card still matches the applied version. It will stop if newer work exists.",
            },
            confirm: { type: "plain_text", text: "Restore card" },
            deny: { type: "plain_text", text: "Keep current card" },
          },
        },
      ],
    },
  ];
}

export function buildRollbackCompleteCard(input: { title: string }): readonly Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `*Previous card restored*\n${escapeMrkdwn(input.title)}\nKnot recorded the compensation receipt and marked the execution evidence stale.`,
        ),
      },
    },
  ];
}

export function buildActionReviewCard(input: {
  actionPlanId: string;
  title: string;
  target: string;
  planHash: string;
  expiresAt: string;
}): readonly Block[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(
          `An executor prepared an immutable update preview for *${escapeMrkdwn(input.title)}*. Review the exact before-and-after plan before approving it. Nothing has run.`,
        ),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Target:* ${escapeMrkdwn(input.target)}\n*Plan hash:* \`${escapeMrkdwn(input.planHash)}\`\n*Expires:* ${escapeMrkdwn(input.expiresAt)}`,
            slackTextLimits.context,
          ),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Review exact update" },
          action_id: slackIds.actions.actionReview,
          value: input.actionPlanId,
          style: "primary",
        },
      ],
    },
  ];
}

export function buildExecutionCard(input: {
  actionPlanId: string;
  title: string;
  approvalKind: "independent" | "personal";
  target: string;
  beforeText: string;
  afterText: string;
  planHash: string;
  expiresAt: string;
}): readonly Block[] {
  const approvalCopy = boundedMrkdwn(
    input.approvalKind === "personal"
      ? `You explicitly confirmed the exact reversible update for *${escapeMrkdwn(input.title)}*. As the named executor, you can now run it.`
      : `An independent reviewer approved the exact reversible update for *${escapeMrkdwn(input.title)}*. As the named executor, you can now run it.`,
  );

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: approvalCopy,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: boundedMrkdwn(`*Exact target*\n${escapeMrkdwn(input.target)}`),
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
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: boundedMrkdwn(
            `*Approved plan hash:* \`${escapeMrkdwn(input.planHash)}\`\n*Expires:* ${escapeMrkdwn(input.expiresAt)}`,
            slackTextLimits.context,
          ),
        },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Execute approved update" },
          action_id: slackIds.actions.actionExecute,
          value: input.actionPlanId,
          style: "primary",
          confirm: {
            title: { type: "plain_text", text: "Execute this approved update?" },
            text: {
              type: "mrkdwn",
              text: "Knot will verify the exact plan and current card version, apply the update, and record Slack's receipt.",
            },
            confirm: { type: "plain_text", text: "Execute update" },
            deny: { type: "plain_text", text: "Not yet" },
          },
        },
      ],
    },
  ];
}
