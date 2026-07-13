import {
  type AuthorizedAudience,
  type ContractFieldProvenance,
  OUTCOME_CONTRACT_FIELDS,
  type OutcomeContract,
  type OutcomeContractField,
  OutcomeContractSchema,
  type OutcomeType,
  OutcomeTypeSchema,
  type Participant,
  type ParticipantRole,
  type PrivacyScope,
} from "../outcomes/index.js";
import { slackIds } from "./constants.js";

type SlackStateValue = {
  value?: string | null;
  selected_user?: string | null;
  selected_date_time?: string | number | null;
  selected_option?: { value?: string | null } | null;
  selected_options?: readonly { value?: string | null }[] | null;
};

type SlackViewState = Record<string, Record<string, SlackStateValue>>;

export type SelectedMessageEvidence = {
  id: string;
  permalink: string;
  observedAt: string;
};

/** Parsed Slack values remain Slack values until the verified edge maps identities. */
export type RawContractSubmission = {
  type: OutcomeType;
  goal: string;
  ownerSlackUserId: string;
  reviewerSlackUserId?: string;
  definitionOfDone: string;
  nextMove: string;
  nextMoveActorSlackUserId: string;
  reviewPoint: OutcomeContract["reviewPoint"];
  privacyScope: PrivacyScope;
  evidence: SelectedMessageEvidence;
  confirmedFields: readonly OutcomeContractField[];
  title: string;
};

export const contractInputBlockIds = {
  reviewPointAt: "knot_review_point_at_v1",
  reviewPointEvent: "knot_review_point_event_v1",
  evidenceConfirmation: "knot_evidence_confirmation_v1",
  participantsConfirmation: "knot_participants_confirmation_v1",
} as const;

export type ParsedContractSubmission = {
  type: OutcomeType;
  contract: OutcomeContract;
  provenance: readonly ContractFieldProvenance[];
  audience: AuthorizedAudience;
  title: string;
};

export class ContractSubmissionValidationError extends Error {
  public constructor(public readonly errors: Record<string, string>) {
    super(Object.values(errors)[0] ?? "Review the Outcome Contract fields.");
    this.name = "ContractSubmissionValidationError";
  }
}

function invalid(blockIds: readonly string[], message: string): never {
  throw new ContractSubmissionValidationError(
    Object.fromEntries(blockIds.map((blockId) => [blockId, message])),
  );
}

function value(state: SlackViewState, blockId: string): string | undefined {
  const field = state[blockId]?.value;
  return typeof field?.value === "string" ? field.value.trim() : undefined;
}

function selectedUser(state: SlackViewState, blockId: string): string | undefined {
  const field = state[blockId]?.value;
  return typeof field?.selected_user === "string" ? field.selected_user : undefined;
}

function selectedOption(state: SlackViewState, blockId: string): string | undefined {
  const field = state[blockId]?.value;
  const option = field?.selected_option?.value;
  return typeof option === "string" ? option : undefined;
}

function selectedDateTime(state: SlackViewState, blockId: string): string | undefined {
  const field = state[blockId]?.value;
  const selected = field?.selected_date_time;
  if (typeof selected === "number" && Number.isSafeInteger(selected)) {
    return String(selected);
  }
  return typeof selected === "string" ? selected : undefined;
}

function isConfirmed(state: SlackViewState, blockId: string): boolean {
  const field = state[blockId]?.value;
  return field?.selected_options?.some((option) => option.value === "confirmed") === true;
}

function asTimestampReviewPoint(rawSeconds: string): OutcomeContract["reviewPoint"] | undefined {
  if (!/^\d{1,12}$/u.test(rawSeconds)) {
    return undefined;
  }
  const seconds = Number(rawSeconds);
  if (!Number.isSafeInteger(seconds)) {
    return undefined;
  }
  const at = new Date(seconds * 1_000);
  return Number.isNaN(at.valueOf()) ? undefined : { kind: "at", at: at.toISOString() };
}

export function parseContractSubmission(input: {
  state: SlackViewState;
  creatorSlackUserId: string;
  evidence: SelectedMessageEvidence;
}): RawContractSubmission {
  const type = selectedOption(input.state, slackIds.blocks.outcomeType);
  const goal = value(input.state, slackIds.blocks.goal);
  const ownerSlackUserId = selectedUser(input.state, slackIds.blocks.owner);
  const reviewerSlackUserId = selectedUser(input.state, slackIds.blocks.reviewer);
  const definitionOfDone = value(input.state, slackIds.blocks.definition);
  const nextMove = value(input.state, slackIds.blocks.nextMove);
  const nextMoveActorSlackUserId = selectedUser(input.state, slackIds.blocks.nextMoveActor);
  const reviewKind = selectedOption(input.state, slackIds.blocks.reviewPoint);
  const reviewAt = selectedDateTime(input.state, contractInputBlockIds.reviewPointAt);
  const reviewEvent = value(input.state, contractInputBlockIds.reviewPointEvent);
  const visibility = selectedOption(input.state, slackIds.blocks.visibility);
  const evidenceConfirmed = isConfirmed(input.state, contractInputBlockIds.evidenceConfirmation);
  const participantsConfirmed = isConfirmed(
    input.state,
    contractInputBlockIds.participantsConfirmation,
  );

  const requiredValues = [
    [slackIds.blocks.outcomeType, type],
    [slackIds.blocks.goal, goal],
    [slackIds.blocks.owner, ownerSlackUserId],
    [slackIds.blocks.definition, definitionOfDone],
    [slackIds.blocks.nextMove, nextMove],
    [slackIds.blocks.nextMoveActor, nextMoveActorSlackUserId],
    [slackIds.blocks.reviewPoint, reviewKind],
    [slackIds.blocks.visibility, visibility],
  ] as const;
  const missingBlockIds = requiredValues.flatMap(([blockId, fieldValue]) =>
    fieldValue ? [] : [blockId],
  );
  if (missingBlockIds.length > 0) {
    invalid(missingBlockIds, "Confirm this required Outcome Contract field.");
  }
  if (
    !type ||
    !goal ||
    !ownerSlackUserId ||
    !definitionOfDone ||
    !nextMove ||
    !nextMoveActorSlackUserId ||
    !reviewKind ||
    !visibility
  ) {
    throw new Error("Outcome Contract validation did not narrow all required fields.");
  }

  const parsedType = OutcomeTypeSchema.safeParse(type);
  if (!parsedType.success) {
    invalid([slackIds.blocks.outcomeType], "Choose a supported outcome type.");
  }

  let reviewPoint: OutcomeContract["reviewPoint"];
  if (reviewKind === "at") {
    const parsedReviewPoint = reviewAt ? asTimestampReviewPoint(reviewAt) : undefined;
    if (!parsedReviewPoint) {
      invalid(
        [contractInputBlockIds.reviewPointAt],
        "Choose a valid date and time for the review point.",
      );
    }
    reviewPoint = parsedReviewPoint;
  } else if (reviewKind === "on_event") {
    if (!reviewEvent) {
      invalid(
        [contractInputBlockIds.reviewPointEvent],
        "Describe the event that should trigger this review.",
      );
    }
    if (reviewEvent.length > 500) {
      invalid(
        [contractInputBlockIds.reviewPointEvent],
        "Keep the review event to 500 characters or fewer.",
      );
    }
    reviewPoint = { kind: "on_event", event: reviewEvent };
  } else {
    invalid([slackIds.blocks.reviewPoint], "Choose a supported review-point type.");
  }

  if (!evidenceConfirmed) {
    invalid(
      [contractInputBlockIds.evidenceConfirmation],
      "Open and confirm the selected message as this outcome's source evidence.",
    );
  }
  if (!participantsConfirmed) {
    invalid(
      [contractInputBlockIds.participantsConfirmation],
      "Review and confirm the participant roles. Participants do not automatically gain access.",
    );
  }

  if (visibility !== "private" && visibility !== "selected_people") {
    invalid([slackIds.blocks.visibility], "Choose a supported privacy scope.");
  }
  if (visibility === "private" && ownerSlackUserId !== input.creatorSlackUserId) {
    invalid(
      [slackIds.blocks.owner],
      "A private outcome must be owned by you. Choose yourself or use selected people.",
    );
  }
  if (visibility === "private" && reviewerSlackUserId) {
    invalid(
      [slackIds.blocks.reviewer],
      "Remove the reviewer for a private outcome, or use selected people.",
    );
  }
  if (visibility === "private" && nextMoveActorSlackUserId !== input.creatorSlackUserId) {
    invalid(
      [slackIds.blocks.nextMoveActor],
      "A private outcome can assign the next move only to you.",
    );
  }
  if (parsedType.data === "handoff" && ownerSlackUserId === input.creatorSlackUserId) {
    invalid([slackIds.blocks.owner], "A handoff needs a different receiving accountable owner.");
  }
  if (visibility === "selected_people") {
    if (!reviewerSlackUserId) {
      invalid(
        [slackIds.blocks.reviewer],
        "A shared outcome needs an independent reviewer before it can safely approve updates.",
      );
    }
    if (
      reviewerSlackUserId === input.creatorSlackUserId ||
      reviewerSlackUserId === ownerSlackUserId ||
      reviewerSlackUserId === nextMoveActorSlackUserId
    ) {
      invalid(
        [slackIds.blocks.reviewer],
        "The reviewer must be independent of the requester, accountable owner, and next-move owner.",
      );
    }
  }

  return {
    type: parsedType.data,
    goal,
    ownerSlackUserId,
    ...(reviewerSlackUserId ? { reviewerSlackUserId } : {}),
    definitionOfDone,
    nextMove,
    nextMoveActorSlackUserId,
    reviewPoint,
    privacyScope: visibility === "private" ? { kind: "private" } : { kind: "selected_people" },
    evidence: input.evidence,
    confirmedFields: [...OUTCOME_CONTRACT_FIELDS],
    title: goal.length > 120 ? `${goal.slice(0, 117)}...` : goal,
  };
}

/** Build domain IDs only after the signed Slack identity has been mapped by the edge. */
export function bindContractSubmission(input: {
  raw: RawContractSubmission;
  creatorPrincipalId: string;
  ownerPrincipalId: string;
  nextMoveActorPrincipalId: string;
  reviewerPrincipalId?: string;
  at: string;
}): ParsedContractSubmission {
  const submittedConfirmations = input.raw.confirmedFields ?? [];
  const confirmedFields = new Set(submittedConfirmations);
  const missingConfirmations = OUTCOME_CONTRACT_FIELDS.filter(
    (field) => !confirmedFields.has(field),
  );
  if (
    missingConfirmations.length > 0 ||
    submittedConfirmations.length !== OUTCOME_CONTRACT_FIELDS.length ||
    confirmedFields.size !== OUTCOME_CONTRACT_FIELDS.length
  ) {
    throw new Error(
      `Creator confirmation is missing for: ${missingConfirmations.join(", ") || "an unknown field"}.`,
    );
  }
  if (
    input.raw.privacyScope.kind === "selected_people" &&
    (!input.reviewerPrincipalId ||
      input.reviewerPrincipalId === input.creatorPrincipalId ||
      input.reviewerPrincipalId === input.ownerPrincipalId ||
      input.reviewerPrincipalId === input.nextMoveActorPrincipalId)
  ) {
    throw new Error("A shared outcome needs an independent reviewer principal.");
  }
  if (input.raw.privacyScope.kind === "private") {
    if (input.ownerPrincipalId !== input.creatorPrincipalId) {
      throw new Error("A private outcome must remain owned by its creator principal.");
    }
    if (input.nextMoveActorPrincipalId !== input.creatorPrincipalId) {
      throw new Error("A private outcome can assign its next move only to its creator principal.");
    }
    if (input.reviewerPrincipalId) {
      throw new Error("A private outcome cannot bind an independent reviewer principal.");
    }
  }
  if (input.raw.type === "handoff" && input.ownerPrincipalId === input.creatorPrincipalId) {
    throw new Error("A handoff must bind a different receiving accountable owner principal.");
  }
  const participants: Participant[] = [];
  const addParticipantRoles = (principalId: string, roles: readonly ParticipantRole[]): void => {
    const existing = participants.find((participant) => participant.principalId === principalId);
    if (!existing) {
      participants.push({ principalId, roles: [...roles] });
      return;
    }
    existing.roles = [...new Set([...existing.roles, ...roles])];
  };
  addParticipantRoles(input.ownerPrincipalId, [
    "owner",
    ...(input.raw.type === "decision" ? (["decider"] as const) : []),
    ...(input.raw.type === "handoff" ? (["handoff_recipient"] as const) : []),
  ]);
  addParticipantRoles(input.creatorPrincipalId, [
    "requester",
    ...(input.raw.type === "handoff" ? (["handoff_sender"] as const) : []),
  ]);
  if (input.reviewerPrincipalId) {
    addParticipantRoles(input.reviewerPrincipalId, ["contributor"]);
  }
  addParticipantRoles(input.nextMoveActorPrincipalId, ["contributor"]);
  const contract: OutcomeContract = {
    goal: input.raw.goal,
    accountableOwnerPrincipalId: input.ownerPrincipalId,
    definitionOfDone: input.raw.definitionOfDone,
    nextMove: {
      description: input.raw.nextMove,
      actorPrincipalId: input.nextMoveActorPrincipalId,
    },
    reviewPoint: input.raw.reviewPoint,
    evidence: [
      {
        id: input.raw.evidence.id,
        kind: "slack_message",
        label: "Selected Slack message",
        locator: input.raw.evidence.permalink,
        observedAt: input.raw.evidence.observedAt,
        freshness: "fresh",
      },
    ],
    participants,
    privacyScope: input.raw.privacyScope,
  };
  const parsedContract = OutcomeContractSchema.parse(contract);
  const provenance: readonly ContractFieldProvenance[] = OUTCOME_CONTRACT_FIELDS.map((field) => ({
    field,
    source: "user",
    evidenceIds: [input.raw.evidence.id],
    freshness: "fresh",
    confirmedByPrincipalId: input.creatorPrincipalId,
    confirmedAt: input.at,
  }));
  const permissionsByPrincipal = new Map<
    string,
    Set<AuthorizedAudience["grants"][number]["permissions"][number]>
  >();
  const grant = (
    principalId: string,
    permissions: readonly AuthorizedAudience["grants"][number]["permissions"][number][],
  ): void => {
    const current = permissionsByPrincipal.get(principalId) ?? new Set();
    for (const permission of permissions) {
      current.add(permission);
    }
    permissionsByPrincipal.set(principalId, current);
  };
  if (input.raw.privacyScope.kind === "private") {
    grant(input.creatorPrincipalId, ["view", "edit", "approve", "execute", "evidence_access"]);
  } else {
    grant(input.creatorPrincipalId, ["view", "edit", "evidence_access"]);
    grant(input.ownerPrincipalId, ["view", "edit", "evidence_access"]);
    grant(input.nextMoveActorPrincipalId, ["view", "execute", "evidence_access"]);
    if (input.reviewerPrincipalId) {
      grant(input.reviewerPrincipalId, ["view", "approve", "evidence_access"]);
    }
  }
  const audience: AuthorizedAudience = {
    grants: [...permissionsByPrincipal].map(([principalId, permissions]) => ({
      id: `audience:${principalId}`,
      subject: { kind: "principal", principalId },
      permissions: [...permissions],
    })),
  };

  return {
    type: input.raw.type,
    contract: parsedContract,
    provenance,
    audience,
    title: input.raw.title,
  };
}

export function submissionErrors(error: unknown): Record<string, string> {
  if (error instanceof ContractSubmissionValidationError) {
    return error.errors;
  }
  const message = error instanceof Error ? error.message : "Review every required field.";
  return {
    [slackIds.blocks.outcomeType]: message,
    [slackIds.blocks.goal]: message,
    [slackIds.blocks.owner]: message,
    [slackIds.blocks.definition]: message,
    [slackIds.blocks.nextMove]: message,
    [slackIds.blocks.nextMoveActor]: message,
    [slackIds.blocks.reviewPoint]: message,
    [contractInputBlockIds.reviewPointAt]: message,
    [contractInputBlockIds.reviewPointEvent]: message,
    [contractInputBlockIds.evidenceConfirmation]: message,
    [contractInputBlockIds.participantsConfirmation]: message,
    [slackIds.blocks.visibility]: message,
  };
}
