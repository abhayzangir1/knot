import { randomUUID } from "node:crypto";

import { App, ExpressReceiver } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import type { KnotEnvironment } from "../config/env.js";
import type { ActorIdentityResolver, VerifiedSlackIdentity } from "../identity/resolver.js";
import {
  DEFAULT_DURABLE_JOB_MAX_ATTEMPTS,
  type DurableJob,
  type DurableJobQueue,
  type JsonObject,
  PermanentJobError,
} from "../jobs/durable-job-queue.js";
import type { KnotLogger } from "../observability/logger.js";
import {
  type ActionPlan,
  type ActorContext,
  type AudiencePermission,
  type DelegationPermission,
  type EvidenceReference,
  hashExternalState,
  type Outcome,
  OutcomeDomainError,
  type OutcomeType,
} from "../outcomes/index.js";
import type {
  ActionExecutor,
  OutcomeService,
  SlackCardUpdateAction,
} from "../services/outcome-service.js";
import {
  buildActionReviewCard,
  buildClosureSummaryCard,
  buildDelegateOutcomeCard,
  buildExecutionCard,
  buildNextMoveCard,
  buildOutcomeCancelledCard,
  buildOutcomeDeletedCard,
  buildOwnerDeclinedCard,
  buildOwnerInvitationCard,
  buildOwnerOutcomeCard,
  buildReadOnlyOutcomeCard,
  buildRequesterActiveCard,
  buildRequesterDeclinedRecoveryCard,
  buildRequesterOutcomeCard,
  buildRollbackCard,
  buildRollbackCompleteCard,
  outcomeCardFallbackText,
} from "./blocks/outcome-cards.js";
import { slackIds } from "./constants.js";
import {
  bindContractSubmission,
  parseContractSubmission,
  type RawContractSubmission,
  submissionErrors,
} from "./contract-input.js";
import {
  contractSubmissionBinding,
  deterministicCommandUuid,
  durableCommandDedupeKey,
  durableSlackIdentity,
  parseSlackDurableCommand,
  type SlackDurableCommand,
  serializeContractSubmission,
} from "./durable-commands.js";
import type { SlackIngressReceiptStore } from "./ingress-receipts.js";
import type { InteractionContextStore } from "./interaction-context.js";
import { parseOpaqueReference } from "./interaction-context.js";
import {
  formatSlackInstant,
  isActiveHumanSlackMember,
  type SlackMemberPresentation,
  slackMemberPresentation,
} from "./member-validation.js";
import {
  buildActionPreviewModal,
  buildActionQueuedModal,
  buildClosureProofModal,
  buildContractPreviewModal,
  buildDelegationModal,
  buildOperationFailedModal,
  buildPreparingActionModal,
  buildPreparingChangeModal,
  buildPreparingClosureModal,
  buildPreparingOutcomeModal,
} from "./views/outcome-views.js";

type SlackPayload = Record<string, unknown>;
type SlackViewStateValue = {
  value?: string | null;
  selected_user?: string | null;
  selected_date_time?: string | number | null;
  selected_options?: readonly { value?: string | null }[] | null;
};
type SlackViewState = Record<string, Record<string, SlackViewStateValue>>;

type SlackRuntime = {
  environment: KnotEnvironment;
  expectedSlackTeamId: string;
  logger: KnotLogger;
  identities: ActorIdentityResolver;
  outcomeService: OutcomeService;
  interactions: InteractionContextStore;
  ingress: SlackIngressReceiptStore;
  jobs: DurableJobQueue<JsonObject>;
  healthCheck(): Promise<void>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readTeamId(payload: SlackPayload): string {
  const team = record(payload.team);
  const id = readString(team.id) ?? readString(payload.team_id);
  if (!id) {
    throw new Error("Slack payload did not include a team ID.");
  }
  return id;
}

function readUserId(payload: SlackPayload): string {
  const user = record(payload.user);
  const id = readString(user.id) ?? readString(payload.user_id);
  if (!id) {
    throw new Error("Slack payload did not include a user ID.");
  }
  return id;
}

export function verifiedIdentityFromPayload(
  payload: SlackPayload,
  label: string,
  expectedSlackTeamId: string,
): VerifiedSlackIdentity {
  const slackTeamId = readTeamId(payload);
  const slackUserId = readUserId(payload);
  if (slackTeamId !== expectedSlackTeamId) {
    throw new Error(
      "The signed Slack payload does not belong to the workspace authenticated by this Knot installation.",
    );
  }
  if (!/^T[A-Z0-9]{2,79}$/u.test(slackTeamId) || !/^[UW][A-Z0-9]{2,79}$/u.test(slackUserId)) {
    throw new Error("Slack identity values are outside the accepted boundary.");
  }
  return {
    slackTeamId,
    slackUserId,
    correlationId: `${label}:${randomUUID()}`,
    authenticatedAt: new Date().toISOString(),
  };
}

export async function verifiedIdentityOrAcknowledge(input: {
  payload: SlackPayload;
  label: string;
  expectedSlackTeamId: string;
  acknowledge(): Promise<void>;
  logger: KnotLogger;
}): Promise<VerifiedSlackIdentity | undefined> {
  try {
    return verifiedIdentityFromPayload(input.payload, input.label, input.expectedSlackTeamId);
  } catch (error) {
    await input.acknowledge();
    input.logger.warn(
      { err: error, interaction: input.label },
      "Rejected a Slack interaction with invalid installation identity",
    );
    return undefined;
  }
}

function isOpaqueUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function actionValue(action: unknown): string {
  const value = readString(record(action).value);
  if (!value || !isOpaqueUuid(value)) {
    throw new Error("Slack action is missing a valid opaque reference.");
  }
  return value;
}

function actionTriggerId(payload: SlackPayload): string {
  const triggerId = readString(payload.trigger_id);
  if (!triggerId) {
    throw new Error("Slack action is missing a trigger ID.");
  }
  return triggerId;
}

export function normalizeSlackMessageText(value: string): string {
  return value
    .replaceAll(/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/gu, "@workspace member")
    .replaceAll(/<#[CDG][A-Z0-9]+\|([^>]+)>/gu, "#$1")
    .replaceAll(/<(https?:\/\/[^>|]+)\|([^>]+)>/gu, "$2 ($1)")
    .replaceAll(/<(https?:\/\/[^>]+)>/gu, "$1")
    .replaceAll(/<!subteam\^[^|>]+\|([^>]+)>/gu, "@$1")
    .replaceAll(/<!(here|channel|everyone)>/gu, "@$1")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

export function shortcutSource(shortcut: SlackPayload): {
  channelId: string;
  messageTs: string;
  text: string;
} {
  const channel = record(shortcut.channel);
  const message = record(shortcut.message);
  const channelId = readString(channel.id);
  const messageTs = readString(message.ts);
  if (!channelId || !messageTs) {
    throw new Error("The Tie it up shortcut requires a selected message.");
  }
  const authorId = readString(message.user);
  const subtype = readString(message.subtype);
  const allowedHumanSubtypes = new Set(["file_share", "me_message", "thread_broadcast"]);
  if (
    !authorId ||
    !/^[UW][A-Z0-9]{2,79}$/u.test(authorId) ||
    readString(message.bot_id) ||
    readString(message.app_id) ||
    (subtype !== undefined && !allowedHumanSubtypes.has(subtype))
  ) {
    throw new Error(
      "Tie it up supports human-authored Slack messages, not app, bot, join, or other system messages.",
    );
  }
  const text = normalizeSlackMessageText(readString(message.text) ?? "");
  if (!text) {
    throw new Error(
      "Select a human-authored message with text so the Outcome Contract has a source.",
    );
  }
  return {
    channelId,
    messageTs,
    text,
  };
}

function sourceGroundedDraft(text: string): {
  goal: string;
  definitionOfDone: string;
  nextMove: string;
  reviewPoint: string;
} {
  const clipped = text.trim().replaceAll(/\s+/g, " ").slice(0, 180);
  return {
    goal: clipped,
    definitionOfDone: "",
    nextMove: "",
    reviewPoint: "",
  };
}

class BackgroundTaskTracker {
  private readonly tasks = new Set<Promise<void>>();

  public run(logger: KnotLogger, label: string, work: () => Promise<void>): void {
    const task = work()
      .catch((error: unknown) => {
        logger.error({ err: error, label }, "Slack background operation failed");
      })
      .finally(() => this.tasks.delete(task));
    this.tasks.add(task);
  }

  public async drain(): Promise<void> {
    await Promise.allSettled([...this.tasks]);
  }
}

function userFacingError(error: unknown, fallback: string): string {
  if (error instanceof OutcomeDomainError) {
    return error.message;
  }
  return fallback;
}

export function duplicateIngressFeedback(surface: "shortcut" | "status" | "exact_review"): string {
  switch (surface) {
    case "shortcut":
      return "Slack retried this shortcut. Knot did not create a duplicate outcome; continue in the original preview or start again from the message.";
    case "status":
      return "Slack retried this status request. Knot did not run a duplicate check; the original request is already processing or complete.";
    case "exact_review":
      return "Slack retried this exact-review request. Knot did not create a duplicate approval; continue in the original preview or reopen it from the current card.";
  }
}

function asSlackBlocks(blocks: readonly Record<string, unknown>[]): never {
  return blocks as never;
}

function slackMessageVersion(message: Record<string, unknown>): string | undefined {
  const text = readString(message.text);
  if (!text && !Array.isArray(message.blocks)) {
    return undefined;
  }
  return hashExternalState({
    text: text ?? "",
    blocks: Array.isArray(message.blocks) ? message.blocks : [],
  });
}

function closureEvidenceKind(type: OutcomeType): EvidenceReference["kind"] {
  switch (type) {
    case "decision":
      return "decision_record";
    case "handoff":
      return "handoff_confirmation";
    case "request":
    case "commitment":
    case "other":
      return "completion_record";
  }
}

function closureEvidenceValue(view: { state: { values: unknown } }): string | undefined {
  const state = view.state.values as SlackViewState;
  const value = state[slackIds.blocks.closureEvidence]?.value?.value;
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function viewStateField(
  view: { state: { values: unknown } },
  blockId: string,
): SlackViewStateValue | undefined {
  const state = view.state.values as SlackViewState;
  return state[blockId]?.value;
}

function viewTextValue(view: { state: { values: unknown } }, blockId: string): string | undefined {
  const value = viewStateField(view, blockId)?.value;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function delegationValues(view: { state: { values: unknown } }): {
  delegateSlackUserId?: string;
  permissions: DelegationPermission[];
  expiresAt?: string;
} {
  const delegateSlackUserId = viewStateField(view, slackIds.blocks.delegateUser)?.selected_user;
  const permissions = (
    viewStateField(view, slackIds.blocks.delegatePermissions)?.selected_options ?? []
  )
    .map((option) => option.value)
    .filter(
      (value): value is DelegationPermission =>
        value === "edit" || value === "execute" || value === "close" || value === "act_as_owner",
    );
  const selectedExpiry = viewStateField(view, slackIds.blocks.delegateExpiry)?.selected_date_time;
  const expirySeconds =
    typeof selectedExpiry === "number"
      ? selectedExpiry
      : typeof selectedExpiry === "string" && /^\d{1,12}$/u.test(selectedExpiry)
        ? Number(selectedExpiry)
        : undefined;
  const expiresAt =
    expirySeconds !== undefined && Number.isSafeInteger(expirySeconds)
      ? new Date(expirySeconds * 1_000).toISOString()
      : undefined;
  return {
    ...(typeof delegateSlackUserId === "string" ? { delegateSlackUserId } : {}),
    permissions: [...new Set(permissions)],
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function displaySlackUser(slackUserId: string): string {
  return `<@${slackUserId}>`;
}

async function presentSlackUser(
  client: WebClient,
  slackUserId: string,
): Promise<SlackMemberPresentation> {
  const response = record(await client.users.info({ user: slackUserId }));
  return slackMemberPresentation(response.user, slackUserId);
}

function escapeSlackFallbackText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function assertActiveHumanAssignees(
  client: WebClient,
  slackUserIds: readonly string[],
): Promise<void> {
  const users = await Promise.all(
    [...new Set(slackUserIds)].map(async (slackUserId) => {
      const response = record(await client.users.info({ user: slackUserId }));
      return { slackUserId, user: record(response.user) };
    }),
  );
  const invalid = users.find(
    ({ slackUserId, user }) => !isActiveHumanSlackMember(user, slackUserId),
  );
  if (invalid) {
    throw new OutcomeDomainError(
      "invalid_slack_assignee",
      "Choose active human workspace members for owner, reviewer, and next-move owner; Slackbot and app users cannot accept or approve an outcome.",
    );
  }
}

async function claimSlackIngress(
  runtime: SlackRuntime,
  label: string,
  identity: VerifiedSlackIdentity,
  opaqueReference: string,
  payload: SlackPayload,
): Promise<boolean> {
  const nonce = slackInteractionNonce(payload);
  return runtime.ingress.claim({
    deliveryKey: `${label}:${identity.slackTeamId}:${identity.slackUserId}:${opaqueReference}:${nonce}`,
    workspaceSlackTeamId: identity.slackTeamId,
    payload,
  });
}

function slackInteractionNonce(payload: SlackPayload): string {
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const action = record(actions[0]);
  const view = record(payload.view);
  return (
    readString(action.action_ts) ??
    readString(payload.trigger_id) ??
    ([readString(view.id), readString(view.hash)].filter(Boolean).join(":") ||
      hashExternalState(payload))
  );
}

function durableInteractionTarget(payload: SlackPayload): {
  channelId: string;
  messageTs: string;
  slackUserId: string;
} {
  const location = interactionMessageLocation(payload);
  if (!location) {
    throw new Error("Slack interaction did not include its source message location.");
  }
  return { ...location, slackUserId: readUserId(payload) };
}

function durableCommandStableUuid(
  label: string,
  identity: VerifiedSlackIdentity,
  opaqueReference: string,
  payload: SlackPayload,
): string {
  return deterministicCommandUuid(
    durableCommandDedupeKey({
      label,
      identity,
      opaqueReference,
      nonce: slackInteractionNonce(payload),
    }),
  );
}

async function enqueueDurableSlackCommand(
  runtime: SlackRuntime,
  identity: VerifiedSlackIdentity,
  label: string,
  opaqueReference: string,
  slackPayload: SlackPayload,
  payload: SlackDurableCommand,
  options?: { dedupeNonce?: string },
): Promise<boolean> {
  const stablePayload = {
    ...payload,
    identity: durableSlackIdentity(identity),
  } as JsonObject;
  const result = await runtime.jobs.enqueueForSlackWorkspace({
    slackTeamId: identity.slackTeamId,
    dedupeKey: durableCommandDedupeKey({
      label,
      identity,
      opaqueReference,
      nonce: options?.dedupeNonce ?? slackInteractionNonce(slackPayload),
    }),
    type: payload.kind,
    payload: stablePayload,
  });
  return result.inserted;
}

function slackInteractionWindow(payload: SlackPayload, windowSeconds = 60): string {
  const action = record(Array.isArray(payload.actions) ? payload.actions[0] : undefined);
  const actionTimestamp = readString(action.action_ts);
  const seconds = actionTimestamp ? Number(actionTimestamp.split(".")[0]) : Number.NaN;
  return Number.isFinite(seconds)
    ? `window:${Math.floor(seconds / windowSeconds)}`
    : `window:${hashExternalState(payload)}`;
}

class BoltSlackActionExecutor implements ActionExecutor {
  public constructor(private readonly client: WebClient) {}

  public async getSlackCardVersion(action: SlackCardUpdateAction): Promise<string | undefined> {
    const response = record(
      await this.client.conversations.replies({
        channel: action.channelId,
        ts: action.messageTs,
        oldest: action.messageTs,
        latest: action.messageTs,
        inclusive: true,
        limit: 1,
      }),
    );
    const messages = Array.isArray(response.messages) ? response.messages : [];
    const message = messages
      .map(record)
      .find((candidate) => readString(candidate.ts) === action.messageTs);
    return message ? slackMessageVersion(message) : undefined;
  }

  public async executeSlackCardUpdate(action: SlackCardUpdateAction): Promise<{
    receipt: Record<string, unknown>;
    externalVersion?: string;
  }> {
    const result = await this.client.chat.update({
      channel: action.channelId,
      ts: action.messageTs,
      text: action.afterFallbackText,
      blocks: asSlackBlocks(action.afterBlocks),
    });
    const response = record(result);
    const message = record(response.message);
    const externalVersion = slackMessageVersion(message);
    return {
      receipt: {
        ok: response.ok === true,
        method: "chat.update",
        channelId: action.channelId,
        messageTs: readString(response.ts) ?? readString(message.ts) ?? action.messageTs,
      },
      ...(externalVersion ? { externalVersion } : {}),
    };
  }

  public async rollbackSlackCardUpdate(action: SlackCardUpdateAction): Promise<{
    receipt: Record<string, unknown>;
    externalVersion?: string;
  }> {
    const result = await this.client.chat.update({
      channel: action.channelId,
      ts: action.messageTs,
      text: action.beforeFallbackText,
      blocks: asSlackBlocks(action.beforeBlocks),
    });
    const response = record(result);
    const message = record(response.message);
    const externalVersion = slackMessageVersion(message);
    return {
      receipt: {
        ok: response.ok === true,
        method: "chat.update",
        channelId: action.channelId,
        messageTs: readString(response.ts) ?? readString(message.ts) ?? action.messageTs,
      },
      ...(externalVersion ? { externalVersion } : {}),
    };
  }
}

async function openPrivateConversation(client: WebClient, slackUserId: string): Promise<string> {
  const result = record(await client.conversations.open({ users: slackUserId }));
  const channel = record(result.channel);
  const channelId = readString(channel.id);
  if (!channelId) {
    throw new Error("Slack did not return a direct-message channel.");
  }
  return channelId;
}

async function notifyUser(client: WebClient, slackUserId: string, text: string): Promise<void> {
  const channelId = await openPrivateConversation(client, slackUserId);
  await client.chat.postMessage({ channel: channelId, text, mrkdwn: false });
}

type PrivateMessageInput = {
  text: string;
  blocks?: readonly Record<string, unknown>[];
  reconcileExisting?: boolean;
};

function messageDeliveryId(message: Record<string, unknown>): string | undefined {
  const metadata = record(message.metadata);
  if (readString(metadata.event_type) !== "knot_delivery") {
    return undefined;
  }
  return readString(record(metadata.event_payload).delivery_id);
}

/**
 * Posts one recoverable Knot DM. A non-sensitive delivery ID in Slack message
 * metadata lets a retried durable job reconcile an ambiguous chat.postMessage
 * response instead of duplicating the user-visible effect.
 */
export async function postPrivateMessageOnce(
  client: WebClient,
  slackUserId: string,
  deliveryId: string,
  input: PrivateMessageInput,
): Promise<{ channelId: string; messageTs: string }> {
  const channelId = await openPrivateConversation(client, slackUserId);
  if (input.reconcileExisting) {
    const history = record(
      await client.conversations.history({
        channel: channelId,
        include_all_metadata: true,
        limit: 15,
      }),
    );
    const existing = (Array.isArray(history.messages) ? history.messages : [])
      .map(record)
      .find((message) => messageDeliveryId(message) === deliveryId);
    const existingTs = existing ? readString(existing.ts) : undefined;
    if (existingTs) {
      return { channelId, messageTs: existingTs };
    }
  }

  const response = record(
    await client.chat.postMessage({
      channel: channelId,
      text: input.text,
      mrkdwn: false,
      ...(input.blocks ? { blocks: asSlackBlocks(input.blocks) } : {}),
      metadata: {
        event_type: "knot_delivery",
        event_payload: { delivery_id: deliveryId },
      },
    }),
  );
  const messageTs = readString(response.ts);
  if (!messageTs) {
    throw new Error("Slack did not return a message timestamp for a durable delivery.");
  }
  return { channelId, messageTs };
}

function audiencePrincipalIds(
  outcome: Outcome,
  requiredPermissions: readonly AudiencePermission[],
): readonly string[] {
  return [
    ...new Set(
      outcome.audience.grants.flatMap((grant) =>
        grant.subject.kind === "principal" &&
        requiredPermissions.every((permission) => grant.permissions.includes(permission))
          ? [grant.subject.principalId]
          : [],
      ),
    ),
  ];
}

function recipientRole(outcome: Outcome, principalId: string): string {
  if (principalId === outcome.contract.accountableOwnerPrincipalId) {
    return "Accountable owner";
  }
  const grant = outcome.audience.grants.find(
    (candidate) =>
      candidate.subject.kind === "principal" && candidate.subject.principalId === principalId,
  );
  if (grant?.permissions.includes("approve")) {
    return "Independent reviewer";
  }
  const roles = outcome.contract.participants?.find(
    (participant) => participant.principalId === principalId,
  )?.roles;
  if (roles?.includes("requester")) {
    return "Requester";
  }
  return "Authorized viewer";
}

function reviewPointLabel(
  outcome: Outcome,
  member: SlackMemberPresentation = { plainName: "Slack member", locale: "en-US", timeZone: "UTC" },
): string {
  const reviewPoint = outcome.contract.reviewPoint;
  if (!reviewPoint) return "Not recorded";
  return reviewPoint.kind === "at"
    ? `At ${formatSlackInstant(reviewPoint.at, member)}`
    : `When ${reviewPoint.event}`;
}

function privacyScopeLabel(outcome: Outcome): string {
  switch (outcome.contract.privacyScope?.kind) {
    case "private":
      return "Private";
    case "selected_people":
      return "Selected people";
    case "channel":
      return "Channel";
    case "workspace":
      return "Workspace";
    default:
      return "Not recorded";
  }
}

async function participantSummary(runtime: SlackRuntime, outcome: Outcome): Promise<string> {
  const participants = outcome.contract.participants ?? [];
  const summaries = await Promise.all(
    participants.map(async (participant) => {
      const slackUserId = await runtime.identities.slackUserIdForPrincipal(
        outcome.workspaceId,
        participant.principalId,
      );
      return `${displaySlackUser(slackUserId)} — ${participant.roles.join(", ")}`;
    }),
  );
  return summaries.join("\n");
}

async function participantFallbackSummary(
  client: WebClient,
  runtime: SlackRuntime,
  outcome: Outcome,
): Promise<string> {
  const participants = outcome.contract.participants ?? [];
  const summaries = await Promise.all(
    participants.map(async (participant) => {
      const slackUserId = await runtime.identities.slackUserIdForPrincipal(
        outcome.workspaceId,
        participant.principalId,
      );
      const member = await presentSlackUser(client, slackUserId);
      return `${member.plainName} (${participant.roles.join(", ")})`;
    }),
  );
  return summaries.join("; ");
}

function currentSourceEvidence(outcome: Outcome): EvidenceReference {
  const evidence = outcome.contract.evidence?.find(
    (candidate) => candidate.kind === "slack_message" && candidate.locator.startsWith("https://"),
  );
  if (!evidence) {
    throw new OutcomeDomainError(
      "source_evidence_missing",
      "The current Outcome Contract has no accessible Slack source reference.",
    );
  }
  return evidence;
}

async function contractChangeDefaults(
  runtime: SlackRuntime,
  outcome: Outcome,
  workflow: "correct" | "reassign",
): Promise<Parameters<typeof buildContractPreviewModal>[0]> {
  const ownerPrincipalId = outcome.contract.accountableOwnerPrincipalId;
  const nextMovePrincipalId = outcome.contract.nextMove?.actorPrincipalId;
  if (!ownerPrincipalId || !nextMovePrincipalId) {
    throw new OutcomeDomainError(
      "outcome_contract_incomplete",
      "The current Outcome Contract is missing its owner or next-move owner.",
    );
  }
  if (
    outcome.contract.privacyScope?.kind !== "private" &&
    outcome.contract.privacyScope?.kind !== "selected_people"
  ) {
    throw new OutcomeDomainError(
      "privacy_scope_not_editable_in_slack",
      "This privacy scope cannot be edited through the current Slack release.",
    );
  }
  const reviewerPrincipalId = outcome.audience.grants.find(
    (grant) => grant.subject.kind === "principal" && grant.permissions.includes("approve"),
  )?.subject;
  const creatorSlackUserId = await runtime.identities.slackUserIdForPrincipal(
    outcome.workspaceId,
    outcome.createdByPrincipalId,
  );
  const source = currentSourceEvidence(outcome);
  return {
    opaqueReference: outcome.id,
    creatorSlackUserId,
    workflow,
    outcomeType: outcome.type,
    ownerSlackUserId: await runtime.identities.slackUserIdForPrincipal(
      outcome.workspaceId,
      ownerPrincipalId,
    ),
    ...(reviewerPrincipalId?.kind === "principal"
      ? {
          reviewerSlackUserId: await runtime.identities.slackUserIdForPrincipal(
            outcome.workspaceId,
            reviewerPrincipalId.principalId,
          ),
        }
      : {}),
    nextMoveActorSlackUserId: await runtime.identities.slackUserIdForPrincipal(
      outcome.workspaceId,
      nextMovePrincipalId,
    ),
    goal: outcome.contract.goal ?? "Outcome",
    definitionOfDone: outcome.contract.definitionOfDone ?? "",
    nextMove: outcome.contract.nextMove?.description ?? "",
    reviewPoint:
      outcome.contract.reviewPoint?.kind === "at"
        ? outcome.contract.reviewPoint.at
        : (outcome.contract.reviewPoint?.event ?? "When the expected result is available"),
    sourceEvidencePermalink: source.locator,
    privacyScope: outcome.contract.privacyScope.kind,
  };
}

async function bindExistingContractChange(
  client: WebClient,
  runtime: SlackRuntime,
  actor: ActorContext,
  outcome: Outcome,
  slackTeamId: string,
  durableSubmission: Extract<
    SlackDurableCommand,
    { kind: "outcome_correct" | "owner_reassign" }
  >["submission"],
): Promise<ReturnType<typeof bindContractSubmission>> {
  if (durableSubmission.type !== outcome.type) {
    throw new OutcomeDomainError(
      "outcome_type_change_forbidden",
      "Changing the outcome type requires a new outcome so its closure rules remain auditable.",
    );
  }
  const source = currentSourceEvidence(outcome);
  const { reviewerSlackUserId, ...requiredSubmission } = durableSubmission;
  const raw: RawContractSubmission = {
    ...requiredSubmission,
    ...(reviewerSlackUserId ? { reviewerSlackUserId } : {}),
    evidence: {
      id: source.id,
      permalink: source.locator,
      observedAt: source.observedAt,
    },
  };
  await assertActiveHumanAssignees(client, [
    raw.ownerSlackUserId,
    raw.nextMoveActorSlackUserId,
    ...(raw.reviewerSlackUserId ? [raw.reviewerSlackUserId] : []),
  ]);
  const ownerPrincipalId = await runtime.identities.resolvePrincipalId(
    slackTeamId,
    raw.ownerSlackUserId,
  );
  const nextMoveActorPrincipalId = await runtime.identities.resolvePrincipalId(
    slackTeamId,
    raw.nextMoveActorSlackUserId,
  );
  const reviewerPrincipalId = raw.reviewerSlackUserId
    ? await runtime.identities.resolvePrincipalId(slackTeamId, raw.reviewerSlackUserId)
    : undefined;
  const bound = bindContractSubmission({
    raw,
    creatorPrincipalId: outcome.createdByPrincipalId,
    ownerPrincipalId,
    nextMoveActorPrincipalId,
    ...(reviewerPrincipalId ? { reviewerPrincipalId } : {}),
    at: actor.authenticatedAt,
  });
  return {
    ...bound,
    provenance: bound.provenance.map((entry) => ({
      ...entry,
      confirmedByPrincipalId: actor.principalId,
      confirmedAt: actor.authenticatedAt,
    })),
  };
}

function sameContractProjection(
  outcome: Outcome,
  target: Pick<ReturnType<typeof bindContractSubmission>, "contract" | "audience">,
): boolean {
  return (
    hashExternalState({ contract: outcome.contract, audience: outcome.audience }) ===
    hashExternalState({ contract: target.contract, audience: target.audience })
  );
}

async function sendReadOnlyActiveUpdates(
  client: WebClient,
  runtime: SlackRuntime,
  outcome: Outcome,
  input: {
    outcomeId: string;
    title: string;
    state: string;
    owner: string;
    ownerFallback?: string;
    reason: string;
    nextMove: string;
  },
  excludedPrincipalIds: readonly string[] = [],
  deliveryPrefix?: string,
  reconcileExisting = false,
): Promise<void> {
  const ownerId = outcome.contract.accountableOwnerPrincipalId;
  const excluded = new Set([ownerId, ...excludedPrincipalIds]);
  const recipients = audiencePrincipalIds(outcome, ["view"]).filter(
    (principalId) => !excluded.has(principalId),
  );
  await Promise.all(
    recipients.map(async (principalId) => {
      const slackUserId = await runtime.identities.slackUserIdForPrincipal(
        outcome.workspaceId,
        principalId,
      );
      const role = recipientRole(outcome, principalId);
      const message = {
        text: outcomeCardFallbackText({
          ...input,
          definitionOfDone: outcome.contract.definitionOfDone,
          recipientRole: role,
          availableActions:
            role === "Requester"
              ? ["Check status", "Correct outcome", "Delete private content"]
              : ["Check status"],
        }),
        blocks:
          role === "Requester"
            ? buildRequesterActiveCard(input)
            : buildReadOnlyOutcomeCard({
                ...input,
                recipientRole: role,
              }),
        reconcileExisting,
      };
      if (deliveryPrefix) {
        await postPrivateMessageOnce(
          client,
          slackUserId,
          `${deliveryPrefix}:viewer:${principalId}`,
          message,
        );
      } else {
        const channelId = await openPrivateConversation(client, slackUserId);
        await client.chat.postMessage({
          channel: channelId,
          text: message.text,
          mrkdwn: false,
          blocks: asSlackBlocks(message.blocks),
        });
      }
    }),
  );
}

async function projectActiveOutcomeCards(
  client: WebClient,
  runtime: SlackRuntime,
  outcome: Outcome,
  actor: ActorContext,
  deliveryPrefix: string,
  reconcileExisting: boolean,
): Promise<void> {
  const assessment = await runtime.outcomeService.getAssessment(outcome.id, actor);
  const ownerPrincipalId = outcome.contract.accountableOwnerPrincipalId;
  const nextMovePrincipalId = outcome.contract.nextMove?.actorPrincipalId;
  if (!ownerPrincipalId || !nextMovePrincipalId) {
    throw new OutcomeDomainError(
      "outcome_contract_incomplete",
      "The active Outcome Contract is missing its owner or next-move owner.",
    );
  }
  const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
    outcome.workspaceId,
    ownerPrincipalId,
  );
  const ownerMember = await presentSlackUser(client, ownerSlackUserId);
  const ownerPreparesUpdate = nextMovePrincipalId === ownerPrincipalId;
  const cardInput = {
    outcomeId: outcome.id,
    title: outcome.contract.goal ?? "Outcome",
    state: outcome.state,
    owner: displaySlackUser(ownerSlackUserId),
    ownerFallback: ownerMember.plainName,
    reason: assessment.reason,
    nextMove: assessment.nextMove,
    definitionOfDone: outcome.contract.definitionOfDone,
    canPrepareUpdate: ownerPreparesUpdate,
    canDelete: ownerPrincipalId === outcome.createdByPrincipalId,
  };
  const blocks = buildOwnerOutcomeCard(cardInput);
  const fallbackText = outcomeCardFallbackText({
    ...cardInput,
    recipientRole: "Accountable owner",
    availableActions: [
      "Check status",
      ...(ownerPreparesUpdate ? ["Prepare progress update"] : []),
      "Submit closure evidence",
      "Correct outcome",
      "Delegate authority",
      ...(ownerPrincipalId === outcome.createdByPrincipalId ? ["Delete private content"] : []),
    ],
  });
  let card = await runtime.outcomeService
    .getSlackCardReference(outcome.id, actor)
    .catch(() => undefined);
  if (card) {
    await client.chat.update({
      channel: card.channelId,
      ts: card.messageTs,
      text: fallbackText,
      blocks: asSlackBlocks(blocks),
    });
    card = { ...card, blocks, fallbackText };
  } else {
    const delivery = await postPrivateMessageOnce(
      client,
      ownerSlackUserId,
      `${deliveryPrefix}:owner-active`,
      { text: fallbackText, blocks, reconcileExisting },
    );
    card = {
      channelId: delivery.channelId,
      messageTs: delivery.messageTs,
      audience: { kind: "personal", principalIds: [ownerPrincipalId] },
      blocks,
      fallbackText,
    };
  }
  await runtime.outcomeService.setSlackCardReference(outcome.id, actor, card);

  if (!ownerPreparesUpdate) {
    const nextMoveSlackUserId = await runtime.identities.slackUserIdForPrincipal(
      outcome.workspaceId,
      nextMovePrincipalId,
    );
    await postPrivateMessageOnce(
      client,
      nextMoveSlackUserId,
      `${deliveryPrefix}:next-move:${nextMovePrincipalId}`,
      {
        text: outcomeCardFallbackText({
          ...cardInput,
          canDelete: nextMovePrincipalId === outcome.createdByPrincipalId,
          recipientRole: "Next-move owner",
          availableActions: [
            "Prepare progress update",
            ...(nextMovePrincipalId === outcome.createdByPrincipalId
              ? ["Correct outcome", "Delete private content"]
              : []),
          ],
        }),
        blocks: buildNextMoveCard({
          ...cardInput,
          canDelete: nextMovePrincipalId === outcome.createdByPrincipalId,
        }),
        reconcileExisting,
      },
    );
  }
  await sendReadOnlyActiveUpdates(
    client,
    runtime,
    outcome,
    cardInput,
    [nextMovePrincipalId],
    deliveryPrefix,
    reconcileExisting,
  );
}

function closureFallbackText(input: {
  title: string;
  ownerFallback: string;
  recipientRole: string;
  definitionOfDone: string;
  evidenceLabel: string;
  evidenceLocator: string;
}): string {
  return `CLOSED. ${input.title}. Owner: ${input.ownerFallback}. Your role: ${input.recipientRole}. Definition of done: ${input.definitionOfDone}. Owner-attested closure evidence reference: ${input.evidenceLabel}, ${input.evidenceLocator}. Knot validated authorization and evidence metadata, not the external contents.`;
}

async function sendClosureSummaries(
  client: WebClient,
  runtime: SlackRuntime,
  outcome: Outcome,
  evidence: EvidenceReference,
  ownerSlackUserId: string,
  excludedPrincipalIds: readonly string[],
  deliveryPrefix?: string,
  reconcileExisting = false,
): Promise<void> {
  const excluded = new Set(excludedPrincipalIds);
  const ownerMember = await presentSlackUser(client, ownerSlackUserId);
  const recipients = audiencePrincipalIds(outcome, ["view", "evidence_access"]).filter(
    (principalId) => !excluded.has(principalId),
  );
  await Promise.all(
    recipients.map(async (principalId) => {
      const slackUserId = await runtime.identities.slackUserIdForPrincipal(
        outcome.workspaceId,
        principalId,
      );
      const cardInput = {
        title: outcome.contract.goal ?? "Outcome",
        owner: displaySlackUser(ownerSlackUserId),
        ownerFallback: ownerMember.plainName,
        recipientRole: recipientRole(outcome, principalId),
        definitionOfDone:
          outcome.contract.definitionOfDone ?? "Recorded completion criteria were supplied.",
        evidenceLabel: evidence.label,
        evidenceLocator: evidence.locator,
        verificationNote:
          "Knot validated the actor's authority, evidence type, freshness, and HTTPS reference format. It did not independently validate the external page contents.",
      };
      const message = {
        text: closureFallbackText(cardInput),
        blocks: buildClosureSummaryCard(cardInput),
        reconcileExisting,
      };
      if (deliveryPrefix) {
        await postPrivateMessageOnce(
          client,
          slackUserId,
          `${deliveryPrefix}:closure:${principalId}`,
          message,
        );
      } else {
        const channelId = await openPrivateConversation(client, slackUserId);
        await client.chat.postMessage({
          channel: channelId,
          text: message.text,
          mrkdwn: false,
          blocks: asSlackBlocks(message.blocks),
        });
      }
    }),
  );
}

function independentReviewerPrincipalId(outcome: Outcome, executorPrincipalId: string): string {
  const excluded = new Set([
    outcome.createdByPrincipalId,
    executorPrincipalId,
    outcome.contract.accountableOwnerPrincipalId,
  ]);
  const reviewer = outcome.audience.grants.find(
    (grant) =>
      grant.subject.kind === "principal" &&
      grant.permissions.includes("approve") &&
      !excluded.has(grant.subject.principalId),
  );
  if (reviewer?.subject.kind !== "principal") {
    throw new Error("This outcome has no independent reviewer authorized to approve the update.");
  }
  return reviewer.subject.principalId;
}

function actionPreviewDetails(plan: ActionPlan): {
  beforeText: string;
  afterText: string;
  target: { channelId: string; messageTs: string };
  targetLabel: string;
  beforeBlocksHash: string;
  afterBlocksHash: string;
  planHash: string;
  outcomeVersion: number;
  contractVersion: number;
  policyVersion: string;
  evidenceSnapshotIds: readonly string[];
  expiresAt: string;
} {
  const action = record(plan.proposedActions[0]);
  if (action.kind !== "slack.card.update") {
    throw new Error("The planned action is not a Slack outcome-card update.");
  }
  const beforeText = readString(action.beforeFallbackText);
  const afterText = readString(action.afterFallbackText);
  if (!beforeText || !afterText) {
    throw new Error("The planned action is missing its exact before-and-after preview.");
  }
  const channelId = readString(action.channelId);
  const messageTs = readString(action.messageTs);
  const beforeBlocks = Array.isArray(action.beforeBlocks) ? action.beforeBlocks : undefined;
  const afterBlocks = Array.isArray(action.afterBlocks) ? action.afterBlocks : undefined;
  if (!channelId || !messageTs || !beforeBlocks || !afterBlocks) {
    throw new Error("The planned action is missing its exact target or Block Kit binding.");
  }
  return {
    beforeText,
    afterText,
    target: { channelId, messageTs },
    targetLabel: `Slack app-owned card ${channelId} at ${messageTs}`,
    beforeBlocksHash: hashExternalState(beforeBlocks),
    afterBlocksHash: hashExternalState(afterBlocks),
    planHash: plan.planHash,
    outcomeVersion: plan.outcomeVersion,
    contractVersion: plan.contractVersion,
    policyVersion: plan.policyVersion,
    evidenceSnapshotIds: plan.evidenceSnapshotIds,
    expiresAt: plan.expiresAt,
  };
}

function interactionMessageLocation(
  payload: SlackPayload,
): { channelId: string; messageTs: string } | undefined {
  const container = record(payload.container);
  const channelId = readString(container.channel_id);
  const messageTs = readString(container.message_ts);
  return channelId && messageTs ? { channelId, messageTs } : undefined;
}

async function postInteractionEphemeral(
  client: WebClient,
  payload: SlackPayload,
  text: string,
  blocks?: readonly Record<string, unknown>[],
): Promise<void> {
  const location = interactionMessageLocation(payload);
  if (!location) {
    throw new Error("Slack interaction did not include the source conversation.");
  }
  await client.chat.postEphemeral({
    channel: location.channelId,
    user: readUserId(payload),
    text: escapeSlackFallbackText(text),
    parse: "none",
    link_names: false,
    ...(blocks ? { blocks: asSlackBlocks(blocks) } : {}),
  });
}

async function postInteractionFailure(
  runtime: SlackRuntime,
  client: WebClient,
  payload: SlackPayload,
  error: unknown,
  fallback: string,
): Promise<void> {
  try {
    await postInteractionEphemeral(client, payload, userFacingError(error, fallback));
  } catch (notificationError) {
    runtime.logger.warn(
      { err: notificationError, originalError: error },
      "Knot could not send the interaction failure message",
    );
  }
}

async function updateFailedModal(
  client: WebClient,
  viewId: string | undefined,
  hash: string | undefined,
  message: string,
): Promise<void> {
  if (!viewId) {
    return;
  }
  await client.views.update({
    view_id: viewId,
    ...(hash ? { hash } : {}),
    view: buildOperationFailedModal(message) as never,
  });
}

async function optionalOutcome(
  runtime: SlackRuntime,
  outcomeId: string,
  actor: ActorContext,
): Promise<Outcome | undefined> {
  try {
    return await runtime.outcomeService.getOutcome(outcomeId, actor);
  } catch (error) {
    if (error instanceof OutcomeDomainError && error.code === "outcome_not_found") {
      return undefined;
    }
    throw error;
  }
}

function commandUserId(command: SlackDurableCommand): string {
  return command.identity.slackUserId;
}

function terminalCommandFailure(command: SlackDurableCommand, error: OutcomeDomainError): string {
  switch (command.kind) {
    case "contract_create":
      return `Knot did not create the outcome: ${error.message}`;
    case "owner_accept":
      return `Knot could not accept ownership: ${error.message}`;
    case "owner_decline":
      return `Knot could not decline ownership: ${error.message}`;
    case "outcome_cancel":
      return `Knot could not cancel the outcome: ${error.message}`;
    case "outcome_correct":
      return `Knot could not apply the outcome correction: ${error.message}`;
    case "owner_reassign":
      return `Knot could not reassign the proposed owner: ${error.message}`;
    case "outcome_delegate":
      return `Knot could not grant the delegation: ${error.message}`;
    case "outcome_delete":
      return `Knot could not delete the private outcome content: ${error.message}`;
    case "outcome_reopen":
      return `Knot could not reopen the outcome: ${error.message}`;
    case "action_preview":
      return `Knot could not prepare the exact update preview: ${error.message}`;
    case "action_approve":
      return `Knot did not approve the update: ${error.message}`;
    case "action_execute":
      return error.code === "action_state_unknown"
        ? `Knot cannot yet confirm whether Slack applied the update. It will not claim failure or ask you to execute again until reconciliation completes: ${error.message}`
        : `Knot could not execute the update: ${error.message}`;
    case "action_rollback":
      return `Knot did not restore the previous card: ${error.message}`;
    case "closure_confirm":
      return `Knot did not close the outcome: ${error.message}`;
  }
}

const RETRYABLE_DURABLE_DOMAIN_ERRORS = new Set([
  "action_reconciliation_pending",
  "action_applied_persistence_incomplete",
  "compensation_applied_persistence_incomplete",
]);

async function processDurableSlackCommand(
  runtime: SlackRuntime,
  client: WebClient,
  job: DurableJob<JsonObject>,
): Promise<void> {
  let command: SlackDurableCommand;
  try {
    command = parseSlackDurableCommand(job.payload);
  } catch (error) {
    throw new PermanentJobError(
      "invalid_durable_slack_command",
      error instanceof Error ? error.message : "The durable command payload is invalid.",
    );
  }

  const actor = await runtime.identities.resolve({
    ...command.identity,
    correlationId: `slack-job:${job.id}`,
    authenticatedAt: job.createdAt,
  });
  if (actor.workspaceId !== job.workspaceId) {
    throw new PermanentJobError(
      "durable_job_tenant_mismatch",
      "The durable Slack command resolved to a different workspace.",
    );
  }

  try {
    switch (command.kind) {
      case "contract_create": {
        let outcome = await optionalOutcome(runtime, command.intendedOutcomeId, actor);
        const context = await runtime.interactions.get(command.opaqueReference, actor);
        if (!outcome && !context) {
          throw new OutcomeDomainError(
            "shortcut_context_expired",
            "The outcome preview expired before it could be committed. Start again from the message shortcut.",
          );
        }

        if (!outcome) {
          if (!context) {
            throw new OutcomeDomainError(
              "shortcut_context_expired",
              "The selected-message context expired before the outcome could be created.",
            );
          }
          const submissionInput: RawContractSubmission = {
            type: command.submission.type,
            goal: command.submission.goal,
            ownerSlackUserId: command.submission.ownerSlackUserId,
            ...(command.submission.reviewerSlackUserId
              ? { reviewerSlackUserId: command.submission.reviewerSlackUserId }
              : {}),
            definitionOfDone: command.submission.definitionOfDone,
            nextMove: command.submission.nextMove,
            nextMoveActorSlackUserId: command.submission.nextMoveActorSlackUserId,
            reviewPoint: command.submission.reviewPoint,
            privacyScope: command.submission.privacyScope,
            evidence: {
              id: `slack:${context.source.channelId}:${context.source.messageTs}`,
              permalink: context.source.permalink,
              observedAt: context.source.observedAt,
            },
            confirmedFields: command.submission.confirmedFields,
            title: command.submission.title,
          };
          await assertActiveHumanAssignees(client, [
            submissionInput.ownerSlackUserId,
            submissionInput.nextMoveActorSlackUserId,
            ...(submissionInput.reviewerSlackUserId ? [submissionInput.reviewerSlackUserId] : []),
          ]);
          const ownerPrincipalId = await runtime.identities.resolvePrincipalId(
            command.identity.slackTeamId,
            submissionInput.ownerSlackUserId,
          );
          const reviewerPrincipalId = submissionInput.reviewerSlackUserId
            ? await runtime.identities.resolvePrincipalId(
                command.identity.slackTeamId,
                submissionInput.reviewerSlackUserId,
              )
            : undefined;
          const nextMoveActorPrincipalId = await runtime.identities.resolvePrincipalId(
            command.identity.slackTeamId,
            submissionInput.nextMoveActorSlackUserId,
          );
          const submission = bindContractSubmission({
            raw: submissionInput,
            creatorPrincipalId: actor.principalId,
            ownerPrincipalId,
            nextMoveActorPrincipalId,
            ...(reviewerPrincipalId ? { reviewerPrincipalId } : {}),
            at: actor.authenticatedAt,
          });
          outcome = await runtime.outcomeService.createConfirmedOutcome({
            id: command.intendedOutcomeId,
            actor,
            type: submission.type,
            contract: submission.contract,
            provenance: submission.provenance,
            audience: submission.audience,
            at: actor.authenticatedAt,
          });
        }

        await runtime.interactions
          .consume(command.opaqueReference, actor)
          .catch((error) =>
            runtime.logger.warn(
              { err: error, outcomeId: outcome?.id },
              "Could not remove a committed shortcut context",
            ),
          );

        const ownerPrincipalId = outcome.contract.accountableOwnerPrincipalId;
        if (!ownerPrincipalId) {
          throw new OutcomeDomainError(
            "owner_missing",
            "The committed Outcome Contract has no proposed accountable owner.",
          );
        }
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          outcome.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        let card = await runtime.outcomeService
          .getSlackCardReference(outcome.id, actor)
          .catch(() => undefined);
        if (!card) {
          const sourceEvidence = outcome.contract.evidence?.[0];
          if (!sourceEvidence) {
            throw new OutcomeDomainError(
              "source_evidence_missing",
              "The complete Outcome Contract is missing its source evidence.",
            );
          }
          const nextMoveActorSlackUserId = await runtime.identities.slackUserIdForPrincipal(
            outcome.workspaceId,
            outcome.contract.nextMove?.actorPrincipalId ?? ownerPrincipalId,
          );
          const nextMoveMember = await presentSlackUser(client, nextMoveActorSlackUserId);
          const participantFallback = await participantFallbackSummary(client, runtime, outcome);
          const reviewPoint = reviewPointLabel(outcome, ownerMember);
          const blocks = buildOwnerInvitationCard({
            outcomeId: outcome.id,
            title: outcome.contract.goal ?? command.submission.title,
            outcomeType: outcome.type[0]?.toUpperCase() + outcome.type.slice(1),
            definitionOfDone:
              outcome.contract.definitionOfDone ?? "Completion criteria were not recorded.",
            nextMove: outcome.contract.nextMove?.description ?? "No next move was recorded.",
            nextMoveActor: displaySlackUser(nextMoveActorSlackUserId),
            reviewPoint,
            evidenceLabel: sourceEvidence.label,
            evidenceLocator: sourceEvidence.locator,
            participantsSummary: await participantSummary(runtime, outcome),
            privacyScope: privacyScopeLabel(outcome),
            canCancel: ownerSlackUserId === actor.slackUserId,
          });
          const availableActions = [
            "Accept ownership",
            "Decline ownership",
            ...(ownerSlackUserId === actor.slackUserId ? ["Cancel outcome"] : []),
          ];
          const text = `Ownership request for ${outcome.contract.goal ?? command.submission.title}. Type: ${outcome.type}. Definition of done: ${outcome.contract.definitionOfDone}. Next move: ${outcome.contract.nextMove?.description}, assigned to ${nextMoveMember.plainName}. Review point: ${reviewPoint}. Participants: ${participantFallback}. Privacy: ${privacyScopeLabel(outcome)}. Source evidence: ${sourceEvidence.label}, ${sourceEvidence.locator}. Available actions: ${availableActions.join(", ")}. Review every field before accepting.`;
          const delivery = await postPrivateMessageOnce(
            client,
            ownerSlackUserId,
            `${job.id}:owner-invitation`,
            { text, blocks, reconcileExisting: job.attempts > 1 },
          );
          card = {
            channelId: delivery.channelId,
            messageTs: delivery.messageTs,
            audience: { kind: "personal", principalIds: [ownerPrincipalId] },
            blocks,
            fallbackText: text,
          };
          await runtime.outcomeService.setSlackCardReference(outcome.id, actor, card);
        }
        if (ownerSlackUserId !== actor.slackUserId) {
          const sourcePermalink = context
            ? context.source.permalink
            : outcome.contract.evidence?.[0]?.locator;
          await postPrivateMessageOnce(client, actor.slackUserId, `${job.id}:requester-created`, {
            text: `Knot created the outcome privately and sent its ownership request: ${command.submission.title}. Source: ${sourcePermalink ?? "unavailable"}. Available action: Cancel outcome.`,
            blocks: buildRequesterOutcomeCard({
              outcomeId: outcome.id,
              title: command.submission.title,
              sourcePermalink: sourcePermalink ?? "https://slack.com/",
            }),
            reconcileExisting: job.attempts > 1,
          });
        }
        return;
      }

      case "owner_accept": {
        let active = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        if (
          active.state === "awaiting_owner_acceptance" &&
          active.ownerAcceptance.status === "pending"
        ) {
          active = await runtime.outcomeService.acceptOwnership(
            command.outcomeId,
            actor,
            actor.authenticatedAt,
          );
        } else if (
          active.ownerAcceptance.status !== "accepted" ||
          active.ownerAcceptance.respondedByPrincipalId !== actor.principalId
        ) {
          throw new OutcomeDomainError(
            "ownership_request_not_pending",
            "This ownership request was already resolved by another transition.",
          );
        }

        const assessment = await runtime.outcomeService.getAssessment(active.id, actor);
        const ownerPrincipalId = active.contract.accountableOwnerPrincipalId ?? actor.principalId;
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          active.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        const nextMoveActorPrincipalId =
          active.contract.nextMove?.actorPrincipalId ?? actor.principalId;
        const ownerPreparesUpdate = nextMoveActorPrincipalId === ownerPrincipalId;
        const cardInput = {
          outcomeId: active.id,
          title: active.contract.goal ?? "Outcome",
          state: active.state,
          owner: displaySlackUser(ownerSlackUserId),
          ownerFallback: ownerMember.plainName,
          reason: assessment.reason,
          nextMove: assessment.nextMove,
          statusNote: "Ownership accepted. You are now the accountable owner.",
          canPrepareUpdate: ownerPreparesUpdate,
          canDelete: ownerPrincipalId === active.createdByPrincipalId,
          definitionOfDone: active.contract.definitionOfDone,
        };
        const blocks = buildOwnerOutcomeCard(cardInput);
        const fallbackText = outcomeCardFallbackText({
          ...cardInput,
          recipientRole: "Accountable owner",
          availableActions: [
            "Check status",
            ...(ownerPreparesUpdate ? ["Prepare progress update"] : []),
            "Submit closure evidence",
            "Correct outcome",
            "Delegate authority",
            ...(ownerPrincipalId === active.createdByPrincipalId ? ["Delete private content"] : []),
          ],
        });
        let card = await runtime.outcomeService
          .getSlackCardReference(active.id, actor)
          .catch(() => undefined);
        if (card) {
          await client.chat.update({
            channel: card.channelId,
            ts: card.messageTs,
            text: fallbackText,
            blocks: asSlackBlocks(blocks),
          });
          card = { ...card, blocks, fallbackText };
        } else {
          const delivery = await postPrivateMessageOnce(
            client,
            ownerSlackUserId,
            `${job.id}:owner-active-card`,
            { text: fallbackText, blocks, reconcileExisting: job.attempts > 1 },
          );
          card = {
            channelId: delivery.channelId,
            messageTs: delivery.messageTs,
            audience: { kind: "personal", principalIds: [ownerPrincipalId] },
            blocks,
            fallbackText,
          };
        }
        await runtime.outcomeService.setSlackCardReference(active.id, actor, card);

        if (!ownerPreparesUpdate) {
          const nextMoveSlackUserId = await runtime.identities.slackUserIdForPrincipal(
            active.workspaceId,
            nextMoveActorPrincipalId,
          );
          await postPrivateMessageOnce(
            client,
            nextMoveSlackUserId,
            `${job.id}:next-move:${nextMoveActorPrincipalId}`,
            {
              text: outcomeCardFallbackText({
                ...cardInput,
                canDelete: nextMoveActorPrincipalId === active.createdByPrincipalId,
                recipientRole: "Next-move owner",
                availableActions: [
                  "Prepare progress update",
                  ...(nextMoveActorPrincipalId === active.createdByPrincipalId
                    ? ["Correct outcome", "Delete private content"]
                    : []),
                ],
              }),
              blocks: buildNextMoveCard({
                ...cardInput,
                canDelete: nextMoveActorPrincipalId === active.createdByPrincipalId,
              }),
              reconcileExisting: job.attempts > 1,
            },
          );
        }
        await sendReadOnlyActiveUpdates(
          client,
          runtime,
          active,
          cardInput,
          [nextMoveActorPrincipalId],
          job.id,
          job.attempts > 1,
        );
        return;
      }

      case "owner_decline": {
        let declined = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        if (
          declined.state === "awaiting_owner_acceptance" &&
          declined.ownerAcceptance.status === "pending"
        ) {
          declined = await runtime.outcomeService.declineOwnership(
            command.outcomeId,
            actor,
            actor.authenticatedAt,
            "Declined in Slack",
          );
        } else if (
          declined.ownerAcceptance.status !== "declined" ||
          declined.ownerAcceptance.respondedByPrincipalId !== actor.principalId
        ) {
          throw new OutcomeDomainError(
            "ownership_request_not_pending",
            "This ownership request was already resolved by another transition.",
          );
        }
        const creatorSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          declined.workspaceId,
          declined.createdByPrincipalId,
        );
        const declineReason = declined.ownerAcceptance.declineReason ?? "Declined in Slack";
        await postPrivateMessageOnce(client, creatorSlackUserId, `${job.id}:requester-declined`, {
          text: `OWNER DECLINED. ${declined.contract.goal ?? "Outcome"}. The outcome remains private and inactive. Available actions: Reassign owner, Cancel outcome.`,
          blocks: buildRequesterDeclinedRecoveryCard({
            outcomeId: declined.id,
            title: declined.contract.goal ?? "Outcome",
            declineReason,
          }),
          reconcileExisting: job.attempts > 1,
        });
        await client.chat.update({
          channel: command.interaction.channelId,
          ts: command.interaction.messageTs,
          text: "Ownership declined. Knot returned this outcome to the requester for clarification or reassignment.",
          blocks: asSlackBlocks(
            buildOwnerDeclinedCard({ title: declined.contract.goal ?? "Outcome" }),
          ),
        });
        return;
      }

      case "outcome_cancel": {
        const before = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        const card = await runtime.outcomeService
          .getSlackCardReference(command.outcomeId, actor)
          .catch(() => undefined);
        const cancelled =
          before.state === "cancelled"
            ? before
            : await runtime.outcomeService.cancelOutcome(
                command.outcomeId,
                actor,
                actor.authenticatedAt,
                "Cancelled through the requester or owner Slack control.",
              );
        const blocks = buildOutcomeCancelledCard({
          title: cancelled.contract.goal ?? "Outcome",
        });
        const fallbackText = `CANCELLED. ${escapeSlackFallbackText(cancelled.contract.goal ?? "Outcome")}. Coordination stopped without claiming completion.`;
        if (card) {
          await client.chat.update({
            channel: card.channelId,
            ts: card.messageTs,
            text: fallbackText,
            blocks: asSlackBlocks(blocks),
          });
          await runtime.outcomeService.setSlackCardReference(cancelled.id, actor, {
            ...card,
            blocks,
            fallbackText,
          });
        }
        if (
          !card ||
          card.channelId !== command.interaction.channelId ||
          card.messageTs !== command.interaction.messageTs
        ) {
          await client.chat.update({
            channel: command.interaction.channelId,
            ts: command.interaction.messageTs,
            text: fallbackText,
            blocks: asSlackBlocks(blocks),
          });
        }
        const ownerPrincipalId =
          cancelled.contract.accountableOwnerPrincipalId ?? before.createdByPrincipalId;
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          cancelled.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        await sendReadOnlyActiveUpdates(
          client,
          runtime,
          cancelled,
          {
            outcomeId: cancelled.id,
            title: cancelled.contract.goal ?? "Outcome",
            state: cancelled.state,
            owner: displaySlackUser(ownerSlackUserId),
            ownerFallback: ownerMember.plainName,
            reason: "Coordination was cancelled without claiming completion.",
            nextMove: "No further action is scheduled for this outcome.",
          },
          [actor.principalId],
          job.id,
          job.attempts > 1,
        );
        return;
      }

      case "outcome_correct": {
        let corrected = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        const target = await bindExistingContractChange(
          client,
          runtime,
          actor,
          corrected,
          command.identity.slackTeamId,
          command.submission,
        );
        if (!sameContractProjection(corrected, target)) {
          corrected = await runtime.outcomeService.correctOutcome(
            command.outcomeId,
            actor,
            actor.authenticatedAt,
            {
              contract: target.contract,
              provenance: target.provenance,
              audience: target.audience,
              reason: command.reason,
            },
          );
        }
        await projectActiveOutcomeCards(
          client,
          runtime,
          corrected,
          actor,
          job.id,
          job.attempts > 1,
        );
        await postPrivateMessageOnce(client, actor.slackUserId, `${job.id}:correction-receipt`, {
          text: `Knot saved the versioned correction for ${corrected.contract.goal ?? "the outcome"}. Every field was reconfirmed, the audience was recalculated, and existing approvals tied to older versions are no longer valid.`,
          reconcileExisting: job.attempts > 1,
        });
        return;
      }

      case "owner_reassign": {
        let reassigned = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        const target = await bindExistingContractChange(
          client,
          runtime,
          actor,
          reassigned,
          command.identity.slackTeamId,
          command.submission,
        );
        const alreadyApplied =
          reassigned.state === "awaiting_owner_acceptance" &&
          reassigned.ownerAcceptance.status === "pending" &&
          reassigned.ownerAcceptance.requestedOwnerPrincipalId ===
            target.contract.accountableOwnerPrincipalId &&
          sameContractProjection(reassigned, target);
        if (!alreadyApplied) {
          reassigned = await runtime.outcomeService.reassignDeclinedOwnership(
            command.outcomeId,
            actor,
            actor.authenticatedAt,
            {
              contract: target.contract,
              provenance: target.provenance,
              audience: target.audience,
              reason: command.reason,
            },
          );
        }
        const ownerPrincipalId = reassigned.contract.accountableOwnerPrincipalId;
        const nextMovePrincipalId = reassigned.contract.nextMove?.actorPrincipalId;
        if (!ownerPrincipalId || !nextMovePrincipalId) {
          throw new OutcomeDomainError(
            "outcome_contract_incomplete",
            "The reassigned Outcome Contract is missing its owner or next-move owner.",
          );
        }
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          reassigned.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        const nextMoveSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          reassigned.workspaceId,
          nextMovePrincipalId,
        );
        const nextMoveMember = await presentSlackUser(client, nextMoveSlackUserId);
        const source = currentSourceEvidence(reassigned);
        const reviewPoint = reviewPointLabel(reassigned, ownerMember);
        const blocks = buildOwnerInvitationCard({
          outcomeId: reassigned.id,
          title: reassigned.contract.goal ?? command.submission.title,
          outcomeType: reassigned.type[0]?.toUpperCase() + reassigned.type.slice(1),
          definitionOfDone: reassigned.contract.definitionOfDone ?? "Not recorded",
          nextMove: reassigned.contract.nextMove?.description ?? "Not recorded",
          nextMoveActor: displaySlackUser(nextMoveSlackUserId),
          reviewPoint,
          evidenceLabel: source.label,
          evidenceLocator: source.locator,
          participantsSummary: await participantSummary(runtime, reassigned),
          privacyScope: privacyScopeLabel(reassigned),
          canCancel: ownerPrincipalId === reassigned.createdByPrincipalId,
        });
        const fallbackText = `Ownership request for ${reassigned.contract.goal ?? command.submission.title}. Definition of done: ${reassigned.contract.definitionOfDone}. Next move: ${reassigned.contract.nextMove?.description}, assigned to ${nextMoveMember.plainName}. Review point: ${reviewPoint}. Source: ${source.label}, ${source.locator}. Available actions: Accept ownership, Decline ownership.`;
        const delivery = await postPrivateMessageOnce(
          client,
          ownerSlackUserId,
          `${job.id}:reassigned-owner-invitation`,
          { text: fallbackText, blocks, reconcileExisting: job.attempts > 1 },
        );
        await runtime.outcomeService.setSlackCardReference(reassigned.id, actor, {
          channelId: delivery.channelId,
          messageTs: delivery.messageTs,
          audience: { kind: "personal", principalIds: [ownerPrincipalId] },
          blocks,
          fallbackText,
        });
        await postPrivateMessageOnce(client, actor.slackUserId, `${job.id}:reassignment-receipt`, {
          text: `Knot sent the reconfirmed Outcome Contract to ${ownerMember.plainName}. The outcome remains private and inactive until that person accepts accountability. Available action: Cancel outcome.`,
          blocks: buildRequesterOutcomeCard({
            outcomeId: reassigned.id,
            title: reassigned.contract.goal ?? "Outcome",
            sourcePermalink: source.locator,
          }),
          reconcileExisting: job.attempts > 1,
        });
        return;
      }

      case "outcome_delegate": {
        await assertActiveHumanAssignees(client, [command.delegateSlackUserId]);
        const delegatePrincipalId = await runtime.identities.resolvePrincipalId(
          command.identity.slackTeamId,
          command.delegateSlackUserId,
        );
        const delegated = await runtime.outcomeService.delegateOwnerAuthority(
          command.outcomeId,
          actor,
          delegatePrincipalId,
          command.permissions,
          actor.authenticatedAt,
          command.expiresAt,
        );
        const assessment = await runtime.outcomeService.getAssessment(delegated.id, actor);
        const ownerPrincipalId =
          delegated.contract.accountableOwnerPrincipalId ?? actor.principalId;
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          delegated.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        const delegateMember = await presentSlackUser(client, command.delegateSlackUserId);
        const cardInput = {
          outcomeId: delegated.id,
          title: delegated.contract.goal ?? "Outcome",
          state: delegated.state,
          owner: displaySlackUser(ownerSlackUserId),
          ownerFallback: ownerMember.plainName,
          reason: assessment.reason,
          nextMove: assessment.nextMove,
          definitionOfDone: delegated.contract.definitionOfDone,
          permissions: command.permissions,
        };
        await postPrivateMessageOnce(
          client,
          command.delegateSlackUserId,
          `${job.id}:delegate-card:${delegatePrincipalId}`,
          {
            text: outcomeCardFallbackText({
              ...cardInput,
              recipientRole: "Owner delegate",
              availableActions: [
                "Check status",
                ...(command.permissions.includes("edit") ? ["Correct outcome"] : []),
                ...(command.permissions.includes("execute") ||
                command.permissions.includes("act_as_owner")
                  ? ["Prepare progress update when policy permits"]
                  : []),
                ...(command.permissions.includes("close") ||
                command.permissions.includes("act_as_owner")
                  ? ["Submit closure evidence"]
                  : []),
              ],
            }),
            blocks: buildDelegateOutcomeCard(cardInput),
            reconcileExisting: job.attempts > 1,
          },
        );
        await postPrivateMessageOnce(client, actor.slackUserId, `${job.id}:delegation-receipt`, {
          text: `Knot granted ${delegateMember.plainName} only these permissions: ${command.permissions.join(", ")}.${command.expiresAt ? ` The delegation expires ${formatSlackInstant(command.expiresAt, ownerMember)}.` : ""} Accountability remains with you.`,
          reconcileExisting: job.attempts > 1,
        });
        return;
      }

      case "outcome_delete": {
        const before = await optionalOutcome(runtime, command.outcomeId, actor);
        const recipientPrincipalIds = before ? audiencePrincipalIds(before, ["view"]) : [];
        if (before) {
          await runtime.outcomeService.deleteOutcome(
            command.outcomeId,
            actor,
            actor.authenticatedAt,
            command.reasonCode,
          );
        }
        const blocks = buildOutcomeDeletedCard();
        const text =
          "DELETED. The Outcome Contract and private evidence references were permanently removed. Knot retained only a non-sensitive audit tombstone; this cannot be undone.";
        await client.chat.update({
          channel: command.interaction.channelId,
          ts: command.interaction.messageTs,
          text,
          blocks: asSlackBlocks(blocks),
        });
        if (before) {
          await Promise.all(
            recipientPrincipalIds
              .filter((principalId) => principalId !== actor.principalId)
              .map(async (principalId) => {
                const slackUserId = await runtime.identities.slackUserIdForPrincipal(
                  before.workspaceId,
                  principalId,
                );
                await postPrivateMessageOnce(
                  client,
                  slackUserId,
                  `${job.id}:deleted:${principalId}`,
                  { text, blocks, reconcileExisting: job.attempts > 1 },
                );
              }),
          );
        }
        return;
      }

      case "outcome_reopen": {
        const reopened = await runtime.outcomeService.reopenOutcome(
          command.outcomeId,
          actor,
          actor.authenticatedAt,
          command.reason,
        );
        await projectActiveOutcomeCards(client, runtime, reopened, actor, job.id, job.attempts > 1);
        await postPrivateMessageOnce(client, actor.slackUserId, `${job.id}:reopen-receipt`, {
          text: `Knot reopened ${reopened.contract.goal ?? "the outcome"}. It is Active again, and the former closure evidence is stale until new completion evidence is submitted.`,
          reconcileExisting: job.attempts > 1,
        });
        return;
      }

      case "action_preview": {
        const outcome = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        const assessment = await runtime.outcomeService.getAssessment(outcome.id, actor);
        const ownerPrincipalId = outcome.contract.accountableOwnerPrincipalId ?? actor.principalId;
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          outcome.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        const afterInput = {
          outcomeId: outcome.id,
          title: outcome.contract.goal ?? "Outcome",
          state: outcome.state,
          owner: displaySlackUser(ownerSlackUserId),
          ownerFallback: ownerMember.plainName,
          reason: assessment.reason,
          nextMove: assessment.nextMove,
          definitionOfDone: outcome.contract.definitionOfDone,
          statusNote:
            "The named next-move owner marked the current next move as in progress. The Outcome Contract and next move are unchanged.",
          canPrepareUpdate:
            outcome.contract.nextMove?.actorPrincipalId ===
            outcome.contract.accountableOwnerPrincipalId,
        };
        const afterBlocks = buildOwnerOutcomeCard(afterInput);
        const afterText = outcomeCardFallbackText({
          ...afterInput,
          recipientRole: "Accountable owner",
          availableActions: ["Check status", "Submit closure evidence"],
        });
        const plan = await runtime.outcomeService.previewSlackCardUpdate(
          outcome.id,
          actor,
          actor.authenticatedAt,
          afterBlocks,
          afterText,
          {
            actionPlanId: deterministicCommandUuid({ kind: "action-preview-plan", jobId: job.id }),
            idempotencyKey: `slack-job:${job.id}:action-preview`,
          },
        );
        const preview = actionPreviewDetails(plan);
        const reviewerPrincipalId =
          outcome.contract.privacyScope?.kind === "private"
            ? actor.principalId
            : independentReviewerPrincipalId(outcome, actor.principalId);
        const reviewerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          outcome.workspaceId,
          reviewerPrincipalId,
        );
        const reviewerMember = await presentSlackUser(client, reviewerSlackUserId);
        const reviewerExpiry = formatSlackInstant(preview.expiresAt, reviewerMember);
        const reviewFallback = `Review exact update for ${outcome.contract.goal ?? "Outcome"}. Target: ${preview.targetLabel}. Plan hash: ${preview.planHash}. Expires: ${reviewerExpiry}. Nothing is approved or executed yet.`;
        await postPrivateMessageOnce(
          client,
          reviewerSlackUserId,
          `${job.id}:action-review:${reviewerPrincipalId}`,
          {
            text: reviewFallback,
            blocks: buildActionReviewCard({
              actionPlanId: plan.id,
              title: outcome.contract.goal ?? "Outcome",
              target: preview.targetLabel,
              planHash: preview.planHash,
              expiresAt: reviewerExpiry,
            }),
            reconcileExisting: job.attempts > 1,
          },
        );
        if (reviewerPrincipalId !== actor.principalId) {
          const actorMember = await presentSlackUser(client, actor.slackUserId);
          await postPrivateMessageOnce(
            client,
            actor.slackUserId,
            `${job.id}:action-preview-confirmed`,
            {
              text: `Knot prepared immutable plan ${preview.planHash} for ${outcome.contract.goal ?? "Outcome"} and sent it to the independent reviewer. It expires at ${formatSlackInstant(preview.expiresAt, actorMember)}; nothing has run.`,
              reconcileExisting: job.attempts > 1,
            },
          );
        }
        return;
      }

      case "action_approve": {
        let approved = await runtime.outcomeService.getActionPlan(command.actionPlanId, actor);
        if (approved.state === "planned") {
          approved = await runtime.outcomeService.approveAction(
            command.actionPlanId,
            actor,
            actor.authenticatedAt,
          );
        } else if (approved.approval?.approverPrincipalId !== actor.principalId) {
          throw new OutcomeDomainError(
            "action_plan_not_planned",
            "This exact action preview was already resolved by another transition.",
          );
        }
        const outcome = await runtime.outcomeService.getOutcome(approved.outcomeId, actor);
        const preview = actionPreviewDetails(approved);
        const executorSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          outcome.workspaceId,
          approved.executorPrincipalId,
        );
        const executorMember = await presentSlackUser(client, executorSlackUserId);
        const executorExpiry = formatSlackInstant(preview.expiresAt, executorMember);
        await postPrivateMessageOnce(client, executorSlackUserId, `${job.id}:execution-request`, {
          text: `Approved exact update for ${outcome.contract.goal ?? "Outcome"}. Target: ${preview.targetLabel}. Before: ${preview.beforeText}. After: ${preview.afterText}. Plan hash: ${preview.planHash}. Expires: ${executorExpiry}. Only the named executor can run it.`,
          blocks: buildExecutionCard({
            actionPlanId: approved.id,
            title: outcome.contract.goal ?? "Outcome",
            approvalKind:
              outcome.contract.privacyScope?.kind === "private" ? "personal" : "independent",
            target: preview.targetLabel,
            beforeText: preview.beforeText,
            afterText: preview.afterText,
            planHash: preview.planHash,
            expiresAt: executorExpiry,
          }),
          reconcileExisting: job.attempts > 1,
        });
        await postPrivateMessageOnce(client, actor.slackUserId, `${job.id}:approval-confirmed`, {
          text: `Knot recorded your approval for: ${outcome.contract.goal ?? "Outcome"}. The named executor now has the execution request.`,
          reconcileExisting: job.attempts > 1,
        });
        return;
      }

      case "action_execute": {
        const plan = await runtime.outcomeService.getActionPlan(command.actionPlanId, actor);
        const outcome = await runtime.outcomeService.getOutcome(plan.outcomeId, actor);
        const applied = await runtime.outcomeService.executeApprovedAction(
          plan.id,
          actor,
          actor.authenticatedAt,
          plan.planHash,
          new BoltSlackActionExecutor(client),
        );
        await client.chat.update({
          channel: command.interaction.channelId,
          ts: command.interaction.messageTs,
          text: `Knot applied the approved reversible Slack update for ${outcome.contract.goal ?? "Outcome"}, recorded its receipt, and can restore the exact previous card after a version check.`,
          blocks: asSlackBlocks(
            buildRollbackCard({
              actionPlanId: applied.id,
              title: outcome.contract.goal ?? "Outcome",
            }),
          ),
        });
        return;
      }

      case "action_rollback": {
        const plan = await runtime.outcomeService.getActionPlan(command.actionPlanId, actor);
        const outcome = await runtime.outcomeService.getOutcome(plan.outcomeId, actor);
        const compensated = await runtime.outcomeService.rollbackAction(
          command.actionPlanId,
          actor,
          undefined,
          new BoltSlackActionExecutor(client),
        );
        await client.chat.update({
          channel: command.interaction.channelId,
          ts: command.interaction.messageTs,
          text: `Knot restored the exact previous card for ${outcome.contract.goal ?? "Outcome"}, recorded the compensation receipt, and marked execution evidence stale (${compensated.state}).`,
          blocks: asSlackBlocks(
            buildRollbackCompleteCard({ title: outcome.contract.goal ?? "Outcome" }),
          ),
        });
        return;
      }

      case "closure_confirm": {
        let current = await runtime.outcomeService.getOutcome(command.outcomeId, actor);
        const evidence: EvidenceReference = {
          id: command.evidenceId,
          kind: closureEvidenceKind(current.type),
          label: "Owner-confirmed closure evidence reference",
          locator: command.locator,
          observedAt: actor.authenticatedAt,
          freshness: "fresh",
          verification: {
            method: "authorized_user_attestation",
            verifiedAt: actor.authenticatedAt,
            verifiedByPrincipalId: actor.principalId,
          },
        };
        if (current.state !== "closed") {
          if (current.state !== "closure_requested") {
            current = await runtime.outcomeService.requestClosure(
              command.outcomeId,
              actor,
              actor.authenticatedAt,
            );
          }
          if (!current.contract.evidence?.some((candidate) => candidate.id === evidence.id)) {
            current = await runtime.outcomeService.recordEvidence(
              command.outcomeId,
              actor,
              evidence,
              actor.authenticatedAt,
            );
          }
          current = await runtime.outcomeService.verifyAndClose(
            command.outcomeId,
            actor,
            actor.authenticatedAt,
            [evidence.id],
          );
        } else if (!current.closureEvidenceIds?.includes(evidence.id)) {
          throw new OutcomeDomainError(
            "closure_already_resolved",
            "This outcome was already closed with a different evidence decision.",
          );
        }

        const ownerPrincipalId = current.contract.accountableOwnerPrincipalId ?? actor.principalId;
        const ownerSlackUserId = await runtime.identities.slackUserIdForPrincipal(
          current.workspaceId,
          ownerPrincipalId,
        );
        const ownerMember = await presentSlackUser(client, ownerSlackUserId);
        let projectedOwnerCard = false;
        const card = await runtime.outcomeService
          .getSlackCardReference(current.id, actor)
          .catch(() => undefined);
        if (card) {
          const cardInput = {
            outcomeId: current.id,
            title: current.contract.goal ?? "Outcome",
            owner: displaySlackUser(ownerSlackUserId),
            ownerFallback: ownerMember.plainName,
            recipientRole: "Accountable owner",
            definitionOfDone:
              current.contract.definitionOfDone ??
              "Completion criteria and supporting evidence were recorded.",
            evidenceLabel: evidence.label,
            evidenceLocator: evidence.locator,
            verificationNote:
              "Knot validated the actor's authority, evidence type, freshness, and HTTPS reference format. It did not independently validate the external page contents.",
            canReopen: true,
          };
          const blocks = buildClosureSummaryCard(cardInput);
          const fallbackText = closureFallbackText(cardInput);
          await client.chat.update({
            channel: card.channelId,
            ts: card.messageTs,
            text: fallbackText,
            blocks: asSlackBlocks(blocks),
          });
          if (
            hashExternalState({ text: card.fallbackText, blocks: card.blocks }) !==
            hashExternalState({ text: fallbackText, blocks })
          ) {
            await runtime.outcomeService.projectClosedSlackCard(
              current.id,
              actor,
              actor.authenticatedAt,
              { ...card, blocks, fallbackText },
            );
          }
          projectedOwnerCard = true;
        }
        await sendClosureSummaries(
          client,
          runtime,
          current,
          evidence,
          ownerSlackUserId,
          projectedOwnerCard ? [ownerPrincipalId] : [],
          job.id,
          job.attempts > 1,
        );
        return;
      }
    }
  } catch (error) {
    if (error instanceof OutcomeDomainError) {
      if (RETRYABLE_DURABLE_DOMAIN_ERRORS.has(error.code)) {
        throw error;
      }
      if (command.kind === "closure_confirm") {
        const outcome = await optionalOutcome(runtime, command.outcomeId, actor).catch(
          () => undefined,
        );
        if (outcome?.state === "closure_requested") {
          await runtime.outcomeService
            .rejectClosure(command.outcomeId, actor, actor.authenticatedAt, error.code)
            .catch((rejectionError) =>
              runtime.logger.warn(
                { err: rejectionError, originalError: error, jobId: job.id },
                "Could not return a rejected closure request to its prior state",
              ),
            );
        }
      }
      await postPrivateMessageOnce(client, commandUserId(command), `${job.id}:terminal-failure`, {
        text: terminalCommandFailure(command, error),
        reconcileExisting: job.attempts > 1,
      }).catch((notificationError) =>
        runtime.logger.warn(
          { err: notificationError, originalError: error, jobId: job.id },
          "Could not deliver a terminal durable-command failure",
        ),
      );
      throw new PermanentJobError(error.code, error.message);
    }
    if (job.attempts >= DEFAULT_DURABLE_JOB_MAX_ATTEMPTS) {
      await postPrivateMessageOnce(
        client,
        commandUserId(command),
        `${job.id}:terminal-infrastructure-failure`,
        {
          text: "Knot could not finish this operation after safe retries. It did not infer success; an administrator must reconcile the durable job.",
          reconcileExisting: job.attempts > 1,
        },
      ).catch((notificationError) =>
        runtime.logger.warn(
          { err: notificationError, originalError: error, jobId: job.id },
          "Could not deliver a terminal infrastructure failure",
        ),
      );
    }
    throw error;
  }
}

export function createKnotSlackApp(runtime: SlackRuntime): {
  app: App;
  receiver: ExpressReceiver;
  drainBackgroundTasks(): Promise<void>;
  startDurableJobs(): void;
  stopDurableJobs(): Promise<void>;
} {
  const signingSecret = runtime.environment.SLACK_SIGNING_SECRET;
  const botToken = runtime.environment.SLACK_BOT_TOKEN;
  if (!signingSecret || !botToken) {
    throw new Error("SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN are required for Slack HTTP mode.");
  }

  const backgroundTasks = new BackgroundTaskTracker();
  const receiver = new ExpressReceiver({
    signingSecret,
    endpoints: "/slack/events",
    processBeforeResponse: false,
  });
  receiver.app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
  receiver.app.get("/readyz", async (_request, response) => {
    try {
      await runtime.healthCheck();
      response.status(200).json({ status: "ready" });
    } catch (error) {
      runtime.logger.warn({ err: error }, "Knot readiness check failed");
      response.status(503).json({ status: "not_ready" });
    }
  });

  const app = new App({ token: botToken, receiver, ignoreSelf: true });

  app.shortcut(slackIds.shortcutTieLooseEnd, async ({ shortcut, ack, client }) => {
    const rawShortcut = shortcut as unknown as SlackPayload;
    let identity: VerifiedSlackIdentity;
    try {
      identity = verifiedIdentityFromPayload(rawShortcut, "shortcut", runtime.expectedSlackTeamId);
    } catch (error) {
      await ack();
      runtime.logger.warn({ err: error }, "Rejected a shortcut with invalid workspace identity");
      return;
    }
    await ack();

    let source: ReturnType<typeof shortcutSource>;
    try {
      source = shortcutSource(rawShortcut);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Select a human-authored Slack message with text and try Tie it up again.";
      try {
        await client.views.open({
          trigger_id: actionTriggerId(rawShortcut),
          view: buildOperationFailedModal(message) as never,
        });
      } catch (modalError) {
        runtime.logger.warn({ err: modalError }, "Could not show the unsupported-message modal");
        await notifyUser(client, identity.slackUserId, message).catch((notificationError) =>
          runtime.logger.warn(
            { err: notificationError },
            "Could not send the unsupported-message recovery message",
          ),
        );
      }
      return;
    }
    const reference = randomUUID();

    let opening: Record<string, unknown>;
    try {
      opening = record(
        await client.views.open({
          trigger_id: actionTriggerId(rawShortcut),
          view: buildPreparingOutcomeModal(reference) as never,
        }),
      );
    } catch (error) {
      runtime.logger.error({ err: error }, "Could not open the Knot shortcut modal");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not open the outcome preview. No outcome was created; try Tie it up again from the selected message.",
      ).catch((notificationError) =>
        runtime.logger.warn(
          { err: notificationError },
          "Could not send the shortcut modal recovery message",
        ),
      );
      return;
    }
    const openedView = record(opening.view);
    const viewId = readString(openedView.id);
    const hash = readString(openedView.hash);
    if (!viewId) {
      runtime.logger.error("Slack did not return an outcome preview view ID");
      await notifyUser(
        client,
        identity.slackUserId,
        "Slack did not return an outcome-preview reference. No outcome was created; try Tie it up again.",
      );
      return;
    }

    backgroundTasks.run(runtime.logger, "prepare-outcome-preview", async () => {
      try {
        const claimed = await claimSlackIngress(
          runtime,
          "shortcut",
          identity,
          `${source.channelId}:${source.messageTs}`,
          rawShortcut,
        );
        if (!claimed) {
          await updateFailedModal(client, viewId, hash, duplicateIngressFeedback("shortcut"));
          return;
        }
        const actor = await runtime.identities.resolve(identity);
        const permalinkResponse = record(
          await client.chat.getPermalink({
            channel: source.channelId,
            message_ts: source.messageTs,
          }),
        );
        const sourcePermalink = readString(permalinkResponse.permalink);
        if (!sourcePermalink?.startsWith("https://")) {
          throw new Error(
            "Slack did not return an accessible HTTPS permalink for the source message.",
          );
        }
        const context = await runtime.interactions.create({
          reference,
          creator: { workspaceId: actor.workspaceId, principalId: actor.principalId },
          source: {
            ...source,
            permalink: sourcePermalink,
            observedAt: identity.authenticatedAt,
          },
        });
        await client.views.update({
          view_id: viewId,
          ...(hash ? { hash } : {}),
          view: buildContractPreviewModal({
            opaqueReference: context.reference,
            creatorSlackUserId: actor.slackUserId,
            sourceEvidencePermalink: context.source.permalink,
            ...sourceGroundedDraft(source.text),
          }) as never,
        });
      } catch (error) {
        await updateFailedModal(
          client,
          viewId,
          hash,
          "Start again from the selected message; no outcome was created.",
        );
        throw error;
      }
    });
  });

  app.view(slackIds.views.contractPreview, async ({ ack, body, view }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "contract",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const opaqueReference = parseOpaqueReference(view.private_metadata);
    let rawSubmission: RawContractSubmission;
    try {
      rawSubmission = parseContractSubmission({
        state: view.state.values as unknown as Record<
          string,
          Record<string, { value?: string | null }>
        >,
        creatorSlackUserId: identity.slackUserId,
        evidence: {
          id: "pending-selected-message",
          permalink: "https://slack.com/",
          observedAt: identity.authenticatedAt,
        },
      });
    } catch (error) {
      await ack({ response_action: "errors", errors: submissionErrors(error) });
      return;
    }
    if (!opaqueReference) {
      await ack({
        response_action: "errors",
        errors: submissionErrors(
          new Error("This preview reference is invalid. Start again from the selected message."),
        ),
      });
      return;
    }
    let durablyQueued = false;
    try {
      const binding = contractSubmissionBinding({ identity, opaqueReference });
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "contract",
        opaqueReference,
        rawBody,
        {
          kind: "contract_create",
          identity,
          opaqueReference,
          intendedOutcomeId: binding.intendedOutcomeId,
          submission: serializeContractSubmission(rawSubmission),
        },
        { dedupeNonce: binding.dedupeNonce },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Outcome creation was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      runtime.logger.error({ err: error }, "Could not durably queue outcome creation");
      await ack({
        response_action: "errors",
        errors: submissionErrors(
          new Error("Knot could not safely queue this outcome. Review the fields and try again."),
        ),
      });
    }
  });

  app.view(slackIds.views.contractCorrection, async ({ ack, body, view }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "outcome-correction",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = parseOpaqueReference(view.private_metadata);
    const reason = viewTextValue(view, slackIds.blocks.changeReason);
    let submission: RawContractSubmission;
    try {
      if (!outcomeId) {
        throw new Error("This outcome reference is invalid. Open Correct outcome again.");
      }
      if (!reason || reason.length < 3) {
        await ack({
          response_action: "errors",
          errors: {
            [slackIds.blocks.changeReason]: "Explain the correction in at least 3 characters.",
          },
        });
        return;
      }
      submission = parseContractSubmission({
        state: view.state.values as SlackViewState,
        creatorSlackUserId: identity.slackUserId,
        evidence: {
          id: "existing-source-reference",
          permalink: "https://slack.com/",
          observedAt: identity.authenticatedAt,
        },
      });
    } catch (error) {
      await ack({ response_action: "errors", errors: submissionErrors(error) });
      return;
    }
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(runtime, identity, "outcome-correct", outcomeId, rawBody, {
        kind: "outcome_correct",
        identity,
        outcomeId,
        submission: serializeContractSubmission(submission),
        reason,
      });
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        throw error;
      }
      await ack({
        response_action: "errors",
        errors: {
          [slackIds.blocks.changeReason]:
            "Knot could not safely queue the correction. Nothing changed; try again.",
        },
      });
    }
  });

  app.view(slackIds.views.ownerReassignment, async ({ ack, body, view }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "owner-reassignment",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = parseOpaqueReference(view.private_metadata);
    const reason = viewTextValue(view, slackIds.blocks.changeReason);
    let submission: RawContractSubmission;
    try {
      if (!outcomeId) {
        throw new Error("This outcome reference is invalid. Open Reassign owner again.");
      }
      if (!reason || reason.length < 3) {
        await ack({
          response_action: "errors",
          errors: {
            [slackIds.blocks.changeReason]: "Explain the reassignment in at least 3 characters.",
          },
        });
        return;
      }
      submission = parseContractSubmission({
        state: view.state.values as SlackViewState,
        creatorSlackUserId: identity.slackUserId,
        evidence: {
          id: "existing-source-reference",
          permalink: "https://slack.com/",
          observedAt: identity.authenticatedAt,
        },
      });
    } catch (error) {
      await ack({ response_action: "errors", errors: submissionErrors(error) });
      return;
    }
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(runtime, identity, "owner-reassign", outcomeId, rawBody, {
        kind: "owner_reassign",
        identity,
        outcomeId,
        submission: serializeContractSubmission(submission),
        reason,
      });
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        throw error;
      }
      await ack({
        response_action: "errors",
        errors: {
          [slackIds.blocks.changeReason]:
            "Knot could not safely queue the reassignment. Nothing changed; try again.",
        },
      });
    }
  });

  app.view(slackIds.views.delegation, async ({ ack, body, view }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "outcome-delegation",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = parseOpaqueReference(view.private_metadata);
    const values = delegationValues(view);
    if (!outcomeId || !values.delegateSlackUserId || values.permissions.length === 0) {
      await ack({
        response_action: "errors",
        errors: {
          ...(!values.delegateSlackUserId
            ? { [slackIds.blocks.delegateUser]: "Choose one active human delegate." }
            : {}),
          ...(values.permissions.length === 0
            ? { [slackIds.blocks.delegatePermissions]: "Choose at least one permission." }
            : {}),
        },
      });
      return;
    }
    if (values.expiresAt && values.expiresAt <= identity.authenticatedAt) {
      await ack({
        response_action: "errors",
        errors: { [slackIds.blocks.delegateExpiry]: "Choose a future expiry time." },
      });
      return;
    }
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(runtime, identity, "outcome-delegate", outcomeId, rawBody, {
        kind: "outcome_delegate",
        identity,
        outcomeId,
        delegateSlackUserId: values.delegateSlackUserId,
        permissions: values.permissions,
        ...(values.expiresAt ? { expiresAt: values.expiresAt } : {}),
      });
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        throw error;
      }
      await ack({
        response_action: "errors",
        errors: {
          [slackIds.blocks.delegatePermissions]:
            "Knot could not safely queue the delegation. Nothing changed; try again.",
        },
      });
    }
  });

  app.action(slackIds.actions.ownerAccept, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "owner-accept",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "owner-accept",
        outcomeId,
        rawBody,
        {
          kind: "owner_accept",
          identity,
          outcomeId,
          interaction: durableInteractionTarget(rawBody),
        },
        { dedupeNonce: slackInteractionWindow(rawBody) },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Ownership acceptance was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue the ownership decision. Try again.",
      );
    }
  });

  app.action(slackIds.actions.ownerDecline, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "owner-decline",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "owner-decline",
        outcomeId,
        rawBody,
        {
          kind: "owner_decline",
          identity,
          outcomeId,
          interaction: durableInteractionTarget(rawBody),
        },
        { dedupeNonce: slackInteractionWindow(rawBody) },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Ownership decline was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue the ownership decision. Try again.",
      );
    }
  });

  app.action(slackIds.actions.actionCancel, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "cancel-outcome",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "outcome-cancel",
        outcomeId,
        rawBody,
        {
          kind: "outcome_cancel",
          identity,
          outcomeId,
          interaction: durableInteractionTarget(rawBody),
        },
        { dedupeNonce: slackInteractionWindow(rawBody) },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Outcome cancellation was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue cancellation. Try again.",
      );
    }
  });

  app.action(slackIds.actions.outcomeCorrect, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "prepare-correction",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    await ack();
    let opening: Record<string, unknown>;
    try {
      opening = record(
        await client.views.open({
          trigger_id: actionTriggerId(rawBody),
          view: buildPreparingChangeModal(outcomeId) as never,
        }),
      );
    } catch (error) {
      runtime.logger.warn({ err: error }, "Could not open the outcome-correction modal");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not open the correction form. Nothing changed; use Correct outcome again.",
      );
      return;
    }
    const openedView = record(opening.view);
    const viewId = readString(openedView.id);
    const hash = readString(openedView.hash);
    if (!viewId) {
      await notifyUser(
        client,
        identity.slackUserId,
        "Slack did not return a correction-form reference. Nothing changed; use Correct outcome again.",
      );
      return;
    }
    backgroundTasks.run(runtime.logger, "prepare-outcome-correction", async () => {
      try {
        const actor = await runtime.identities.resolve(identity);
        const outcome = await runtime.outcomeService.getOutcomeForEdit(outcomeId, actor);
        await client.views.update({
          view_id: viewId,
          ...(hash ? { hash } : {}),
          view: buildContractPreviewModal(
            await contractChangeDefaults(runtime, outcome, "correct"),
          ) as never,
        });
      } catch (error) {
        await updateFailedModal(
          client,
          viewId,
          hash,
          userFacingError(error, "No correction was made."),
        );
      }
    });
  });

  app.action(slackIds.actions.ownerReassign, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "prepare-reassignment",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    await ack();
    let opening: Record<string, unknown>;
    try {
      opening = record(
        await client.views.open({
          trigger_id: actionTriggerId(rawBody),
          view: buildPreparingChangeModal(
            outcomeId,
            "Preparing the declined Outcome Contract for a new ownership request. Nothing has changed yet.",
          ) as never,
        }),
      );
    } catch (error) {
      runtime.logger.warn({ err: error }, "Could not open the owner-reassignment modal");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not open the owner-reassignment form. Nothing changed; use Reassign owner again.",
      );
      return;
    }
    const openedView = record(opening.view);
    const viewId = readString(openedView.id);
    const hash = readString(openedView.hash);
    if (!viewId) {
      await notifyUser(
        client,
        identity.slackUserId,
        "Slack did not return a reassignment-form reference. Nothing changed; use Reassign owner again.",
      );
      return;
    }
    backgroundTasks.run(runtime.logger, "prepare-owner-reassignment", async () => {
      try {
        const actor = await runtime.identities.resolve(identity);
        const outcome = await runtime.outcomeService.getOutcomeForEdit(outcomeId, actor);
        await client.views.update({
          view_id: viewId,
          ...(hash ? { hash } : {}),
          view: buildContractPreviewModal(
            await contractChangeDefaults(runtime, outcome, "reassign"),
          ) as never,
        });
      } catch (error) {
        await updateFailedModal(
          client,
          viewId,
          hash,
          userFacingError(error, "No owner was reassigned."),
        );
      }
    });
  });

  app.action(slackIds.actions.outcomeDelegate, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "prepare-delegation",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    await ack();
    let opening: Record<string, unknown>;
    try {
      opening = record(
        await client.views.open({
          trigger_id: actionTriggerId(rawBody),
          view: buildPreparingChangeModal(
            outcomeId,
            "Checking current owner authority before opening delegation. Nothing has changed yet.",
          ) as never,
        }),
      );
    } catch (error) {
      runtime.logger.warn({ err: error }, "Could not open the delegation modal");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not open the delegation form. Nothing changed; use Delegate authority again.",
      );
      return;
    }
    const openedView = record(opening.view);
    const viewId = readString(openedView.id);
    const hash = readString(openedView.hash);
    if (!viewId) {
      await notifyUser(
        client,
        identity.slackUserId,
        "Slack did not return a delegation-form reference. Nothing changed; use Delegate authority again.",
      );
      return;
    }
    backgroundTasks.run(runtime.logger, "prepare-outcome-delegation", async () => {
      try {
        const actor = await runtime.identities.resolve(identity);
        const outcome = await runtime.outcomeService.getOutcomeForDelegation(outcomeId, actor);
        await client.views.update({
          view_id: viewId,
          ...(hash ? { hash } : {}),
          view: buildDelegationModal({
            outcomeId: outcome.id,
            outcomeTitle: outcome.contract.goal ?? "Outcome",
          }) as never,
        });
      } catch (error) {
        await updateFailedModal(
          client,
          viewId,
          hash,
          userFacingError(error, "No authority was delegated."),
        );
      }
    });
  });

  app.action(slackIds.actions.outcomeDelete, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "delete-outcome",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(runtime, identity, "outcome-delete", outcomeId, rawBody, {
        kind: "outcome_delete",
        identity,
        outcomeId,
        interaction: durableInteractionTarget(rawBody),
        reasonCode: "user_request",
      });
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue deletion. No private content was removed.",
      );
    }
  });

  app.action(slackIds.actions.outcomeReopen, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "reopen-outcome",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(runtime, identity, "outcome-reopen", outcomeId, rawBody, {
        kind: "outcome_reopen",
        identity,
        outcomeId,
        interaction: durableInteractionTarget(rawBody),
        reason: "Reopened after explicit Slack confirmation.",
      });
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue reopening. The outcome remains closed.",
      );
    }
  });

  app.action(slackIds.actions.outcomeCheck, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "outcome-check",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    await ack();
    backgroundTasks.run(runtime.logger, "check-outcome", async () => {
      try {
        if (!(await claimSlackIngress(runtime, "outcome-check", identity, outcomeId, rawBody))) {
          await postInteractionEphemeral(client, rawBody, duplicateIngressFeedback("status"));
          return;
        }
        const actor = await runtime.identities.resolve(identity);
        const assessment = await runtime.outcomeService.getAssessment(outcomeId, actor);
        await postInteractionEphemeral(
          client,
          rawBody,
          `${assessment.state.toUpperCase()}\n${assessment.reason}\n\nRecommended next move: ${assessment.nextMove}`,
        );
      } catch (error) {
        await postInteractionFailure(
          runtime,
          client,
          rawBody,
          error,
          "Knot could not retrieve the current outcome status.",
        );
        throw error;
      }
    });
  });

  app.action(slackIds.actions.outcomeMove, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "outcome-move",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "action-preview",
        outcomeId,
        rawBody,
        { kind: "action_preview", identity, outcomeId },
        { dedupeNonce: slackInteractionWindow(rawBody) },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Action preview was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      runtime.logger.error({ err: error }, "Could not durably queue the action preview");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not safely queue that preview. No action was approved or run; try again from the current outcome card.",
      );
      return;
    }
    await client.views
      .open({
        trigger_id: actionTriggerId(rawBody),
        view: buildActionQueuedModal() as never,
      })
      .catch((error) =>
        runtime.logger.warn(
          { err: error },
          "Could not show the durable action-preview receipt modal; private delivery remains queued",
        ),
      );
  });

  app.action(slackIds.actions.actionReview, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "review-action",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const actionPlanId = actionValue(action);
    await ack();

    let opening: Record<string, unknown>;
    try {
      opening = record(
        await client.views.open({
          trigger_id: actionTriggerId(rawBody),
          view: buildPreparingActionModal(actionPlanId) as never,
        }),
      );
    } catch (error) {
      runtime.logger.error({ err: error }, "Could not open the action-review modal");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not open the exact update preview. Nothing was approved or run; use Review exact update again.",
      ).catch((notificationError) =>
        runtime.logger.warn(
          { err: notificationError },
          "Could not send the action-review recovery message",
        ),
      );
      return;
    }
    const openedView = record(opening.view);
    const viewId = readString(openedView.id);
    const hash = readString(openedView.hash);
    if (!viewId) {
      runtime.logger.error("Slack did not return an action-review view ID");
      await notifyUser(
        client,
        identity.slackUserId,
        "Slack did not return an exact-preview reference. Nothing was approved or run; use Review exact update again.",
      );
      return;
    }

    backgroundTasks.run(runtime.logger, "review-card-update", async () => {
      try {
        if (!(await claimSlackIngress(runtime, "review-action", identity, actionPlanId, rawBody))) {
          await updateFailedModal(client, viewId, hash, duplicateIngressFeedback("exact_review"));
          return;
        }
        const actor = await runtime.identities.resolve(identity);
        const plan = await runtime.outcomeService.getActionPlan(actionPlanId, actor);
        const outcome = await runtime.outcomeService.getOutcome(plan.outcomeId, actor);
        const preview = actionPreviewDetails(plan);
        const actorMember = await presentSlackUser(client, actor.slackUserId);
        await client.views.update({
          view_id: viewId,
          ...(hash ? { hash } : {}),
          view: buildActionPreviewModal({
            opaqueReference: plan.id,
            outcomeTitle: outcome.contract.goal ?? "Outcome",
            target: preview.target,
            beforeText: preview.beforeText,
            afterText: preview.afterText,
            beforeBlocksHash: preview.beforeBlocksHash,
            afterBlocksHash: preview.afterBlocksHash,
            planHash: preview.planHash,
            outcomeVersion: preview.outcomeVersion,
            contractVersion: preview.contractVersion,
            policyVersion: preview.policyVersion,
            evidenceSnapshotIds: preview.evidenceSnapshotIds,
            expiresAt: formatSlackInstant(preview.expiresAt, actorMember),
            reversibility: plan.reversibility,
          }) as never,
        });
      } catch (error) {
        await updateFailedModal(client, viewId, hash, "No action was approved or run.");
        throw error;
      }
    });
  });

  app.view(slackIds.views.actionPreview, async ({ ack, body, view, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "approve-action",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const actionPlanId = parseOpaqueReference(view.private_metadata);
    if (!actionPlanId) {
      await ack();
      await notifyUser(
        client,
        identity.slackUserId,
        "That action preview expired. Open a new preview from the outcome card.",
      );
      return;
    }
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "action-approve",
        actionPlanId,
        rawBody,
        {
          kind: "action_approve",
          identity,
          actionPlanId,
        },
        { dedupeNonce: "once" },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Action approval was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      runtime.logger.error({ err: error }, "Could not durably queue action approval");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not safely queue that approval. Reopen the exact preview and try again.",
      );
    }
  });

  app.action(slackIds.actions.actionExecute, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "execute-action",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const actionPlanId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "action-execute",
        actionPlanId,
        rawBody,
        {
          kind: "action_execute",
          identity,
          actionPlanId,
          interaction: durableInteractionTarget(rawBody),
        },
        { dedupeNonce: "once" },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Action execution was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue execution. The update was not dispatched by this request.",
      );
    }
  });

  app.action(slackIds.actions.actionRollback, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "rollback",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const actionPlanId = actionValue(action);
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(
        runtime,
        identity,
        "action-rollback",
        actionPlanId,
        rawBody,
        {
          kind: "action_rollback",
          identity,
          actionPlanId,
          interaction: durableInteractionTarget(rawBody),
        },
        { dedupeNonce: "once" },
      );
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Action rollback was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not safely queue rollback. It did not overwrite the Slack card.",
      );
    }
  });

  app.action(slackIds.actions.outcomeClose, async ({ ack, body, action, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "prepare-closure",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = actionValue(action);
    await ack();
    let opening: Record<string, unknown>;
    try {
      opening = record(
        await client.views.open({
          trigger_id: actionTriggerId(rawBody),
          view: buildPreparingClosureModal(outcomeId) as never,
        }),
      );
    } catch (error) {
      runtime.logger.error({ err: error }, "Could not open the closure evidence modal");
      await postInteractionFailure(
        runtime,
        client,
        rawBody,
        error,
        "Knot could not open the closure-evidence form. Nothing was closed.",
      );
      return;
    }
    const openedView = record(opening.view);
    const viewId = readString(openedView.id);
    const hash = readString(openedView.hash);
    if (!viewId) {
      runtime.logger.error("Slack did not return a closure-evidence view ID");
      await notifyUser(
        client,
        identity.slackUserId,
        "Slack did not return a closure-form reference. Nothing was closed; try Submit closure evidence again.",
      );
      return;
    }

    backgroundTasks.run(runtime.logger, "closure-form-update", async () => {
      try {
        const actor = await runtime.identities.resolve(identity);
        const outcome = await runtime.outcomeService.getOutcome(outcomeId, actor);
        if (!outcome.contract.definitionOfDone) {
          throw new OutcomeDomainError(
            "outcome_contract_incomplete",
            "This outcome has no definition of done and cannot be closed.",
          );
        }
        await client.views.update({
          view_id: viewId,
          ...(hash ? { hash } : {}),
          view: buildClosureProofModal({
            outcomeId,
            outcomeTitle: outcome.contract.goal ?? "Outcome",
            outcomeType: outcome.type,
            definitionOfDone: outcome.contract.definitionOfDone,
          }) as never,
        });
      } catch (error) {
        await updateFailedModal(client, viewId, hash, "Nothing was closed.");
        throw error;
      }
    });
  });

  app.view(slackIds.views.closureProof, async ({ ack, body, view, client }) => {
    const rawBody = body as unknown as SlackPayload;
    const identity = await verifiedIdentityOrAcknowledge({
      payload: rawBody,
      label: "confirm-closure",
      expectedSlackTeamId: runtime.expectedSlackTeamId,
      acknowledge: () => ack(),
      logger: runtime.logger,
    });
    if (!identity) return;
    const outcomeId = parseOpaqueReference(view.private_metadata);
    const locator = closureEvidenceValue(view);
    if (!locator) {
      await ack({
        response_action: "errors",
        errors: {
          [slackIds.blocks.closureEvidence]:
            "Enter an accessible HTTPS evidence reference before requesting closure.",
        },
      });
      return;
    }
    if (!outcomeId) {
      await ack();
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not confirm closure because the outcome reference was missing.",
      );
      return;
    }
    let durablyQueued = false;
    try {
      await enqueueDurableSlackCommand(runtime, identity, "closure", outcomeId, rawBody, {
        kind: "closure_confirm",
        identity,
        outcomeId,
        evidenceId: `closure:${durableCommandStableUuid("closure", identity, outcomeId, rawBody)}`,
        locator,
      });
      durablyQueued = true;
      await ack();
      runtime.jobs.wake();
    } catch (error) {
      if (durablyQueued) {
        runtime.jobs.wake();
        runtime.logger.error(
          { err: error },
          "Closure confirmation was durably queued but Slack acknowledgement failed",
        );
        throw error;
      }
      await ack();
      runtime.logger.error({ err: error }, "Could not durably queue closure confirmation");
      await notifyUser(
        client,
        identity.slackUserId,
        "Knot could not safely queue closure. The outcome was not closed by this request.",
      );
    }
  });

  return {
    app,
    receiver,
    drainBackgroundTasks: () => backgroundTasks.drain(),
    startDurableJobs: () =>
      runtime.jobs.start((job) => processDurableSlackCommand(runtime, app.client, job)),
    stopDurableJobs: () => runtime.jobs.stop(),
  };
}
