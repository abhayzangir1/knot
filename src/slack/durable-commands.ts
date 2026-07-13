import { z } from "zod";
import type { VerifiedSlackIdentity } from "../identity/resolver.js";
import {
  DelegationPermissionSchema,
  hashExternalState,
  OUTCOME_CONTRACT_FIELDS,
  OutcomeContractFieldSchema,
  OutcomeTypeSchema,
} from "../outcomes/index.js";
import type { RawContractSubmission } from "./contract-input.js";

const slackTeamIdentifier = z.string().regex(/^T[A-Z0-9]{2,79}$/u);
const slackUserIdentifier = z.string().regex(/^[UW][A-Z0-9]{2,79}$/u);
const slackConversationIdentifier = z.string().regex(/^[CDG][A-Z0-9]{2,79}$/u);
const slackMessageTimestamp = z.string().regex(/^\d{1,20}\.\d{1,20}$/u);
const opaqueUuid = z.uuid();

const durableSlackIdentitySchema = z.strictObject({
  slackTeamId: slackTeamIdentifier,
  slackUserId: slackUserIdentifier,
});

const interactionTargetSchema = z.strictObject({
  channelId: slackConversationIdentifier,
  messageTs: slackMessageTimestamp,
  slackUserId: slackUserIdentifier,
});

const rawContractSubmissionSchema = z.strictObject({
  type: OutcomeTypeSchema,
  goal: z.string().min(1).max(3_000),
  ownerSlackUserId: slackUserIdentifier,
  reviewerSlackUserId: slackUserIdentifier.optional(),
  definitionOfDone: z.string().min(1).max(3_000),
  nextMove: z.string().min(1).max(3_000),
  nextMoveActorSlackUserId: slackUserIdentifier,
  reviewPoint: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("at"), at: z.iso.datetime() }),
    z.strictObject({ kind: z.literal("on_event"), event: z.string().min(1).max(500) }),
  ]),
  privacyScope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("private") }),
    z.strictObject({ kind: z.literal("selected_people") }),
  ]),
  confirmedFields: z
    .array(OutcomeContractFieldSchema)
    .length(OUTCOME_CONTRACT_FIELDS.length)
    .refine(
      (fields) =>
        new Set(fields).size === OUTCOME_CONTRACT_FIELDS.length &&
        OUTCOME_CONTRACT_FIELDS.every((field) => fields.includes(field)),
      "Every Outcome Contract field must be confirmed exactly once",
    ),
  title: z.string().min(1).max(200),
});

export const SlackDurableCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("contract_create"),
    identity: durableSlackIdentitySchema,
    opaqueReference: opaqueUuid,
    intendedOutcomeId: opaqueUuid,
    submission: rawContractSubmissionSchema,
  }),
  z.strictObject({
    kind: z.literal("owner_accept"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    interaction: interactionTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("owner_decline"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    interaction: interactionTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("outcome_cancel"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    interaction: interactionTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("action_preview"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
  }),
  z.strictObject({
    kind: z.literal("action_approve"),
    identity: durableSlackIdentitySchema,
    actionPlanId: opaqueUuid,
  }),
  z.strictObject({
    kind: z.literal("action_execute"),
    identity: durableSlackIdentitySchema,
    actionPlanId: opaqueUuid,
    interaction: interactionTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("action_rollback"),
    identity: durableSlackIdentitySchema,
    actionPlanId: opaqueUuid,
    interaction: interactionTargetSchema,
  }),
  z.strictObject({
    kind: z.literal("closure_confirm"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    evidenceId: z.string().min(1).max(300),
    locator: z
      .url()
      .max(2_000)
      .refine((value) => value.startsWith("https://"), "HTTPS is required"),
  }),
  z.strictObject({
    kind: z.literal("outcome_correct"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    submission: rawContractSubmissionSchema,
    reason: z.string().trim().min(3).max(500),
  }),
  z.strictObject({
    kind: z.literal("owner_reassign"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    submission: rawContractSubmissionSchema,
    reason: z.string().trim().min(3).max(500),
  }),
  z.strictObject({
    kind: z.literal("outcome_delegate"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    delegateSlackUserId: slackUserIdentifier,
    permissions: z
      .array(DelegationPermissionSchema)
      .min(1)
      .max(4)
      .refine((permissions) => new Set(permissions).size === permissions.length),
    expiresAt: z.iso.datetime().optional(),
  }),
  z.strictObject({
    kind: z.literal("outcome_delete"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    interaction: interactionTargetSchema,
    reasonCode: z.enum(["user_request", "privacy_request"]),
  }),
  z.strictObject({
    kind: z.literal("outcome_reopen"),
    identity: durableSlackIdentitySchema,
    outcomeId: opaqueUuid,
    interaction: interactionTargetSchema,
    reason: z.string().trim().min(3).max(500),
  }),
]);

export type SlackDurableCommand = z.infer<typeof SlackDurableCommandSchema>;

export function parseSlackDurableCommand(value: unknown): SlackDurableCommand {
  return SlackDurableCommandSchema.parse(value);
}

export function serializeContractSubmission(
  submission: RawContractSubmission,
): Extract<SlackDurableCommand, { kind: "contract_create" }>["submission"] {
  const { evidence: _transientEvidence, ...durableSubmission } = submission;
  return rawContractSubmissionSchema.parse(durableSubmission);
}

export function durableSlackIdentity(
  identity: VerifiedSlackIdentity,
): SlackDurableCommand["identity"] {
  return {
    slackTeamId: identity.slackTeamId,
    slackUserId: identity.slackUserId,
  };
}

export function durableCommandDedupeKey(input: {
  label: string;
  identity: Pick<VerifiedSlackIdentity, "slackTeamId" | "slackUserId">;
  opaqueReference: string;
  nonce: string;
}): string {
  return `${input.label}:${input.identity.slackTeamId}:${input.identity.slackUserId}:${input.opaqueReference}:${input.nonce}`;
}

/** Produces an RFC-4122 UUID that is stable for one already-deduplicated command. */
export function deterministicCommandUuid(seed: unknown): string {
  const hash = hashExternalState(seed);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
