import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slackTeamId: text("slack_team_id").notNull(),
    name: text("name"),
    timezone: text("timezone").notNull().default("UTC"),
    retentionDays: integer("retention_days").notNull().default(90),
    ...timestamps,
  },
  (table) => [uniqueIndex("workspaces_slack_team_id_unique").on(table.slackTeamId)],
);

export const principals = pgTable(
  "principals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackUserId: text("slack_user_id").notNull(),
    displayName: text("display_name"),
    email: text("email"),
    isAdmin: boolean("is_admin").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("principals_workspace_slack_user_unique").on(table.workspaceId, table.slackUserId),
    index("principals_workspace_index").on(table.workspaceId),
  ],
);

export const installations = pgTable(
  "installations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slackEnterpriseId: text("slack_enterprise_id"),
    encryptedBotToken: jsonb("encrypted_bot_token").$type<Record<string, unknown>>(),
    encryptedRefreshToken: jsonb("encrypted_refresh_token").$type<Record<string, unknown>>(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    grantedScopes: jsonb("granted_scopes").$type<string[]>().notNull().default([]),
    ...timestamps,
  },
  (table) => [uniqueIndex("installations_workspace_unique").on(table.workspaceId)],
);

export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    lifecycleState: text("lifecycle_state").notNull(),
    privacyScope: text("privacy_scope").notNull(),
    title: text("title").notNull(),
    requesterPrincipalId: uuid("requester_principal_id").references(() => principals.id),
    accountableOwnerPrincipalId: uuid("accountable_owner_principal_id").references(
      () => principals.id,
    ),
    contractVersion: integer("contract_version").notNull().default(0),
    version: integer("version").notNull().default(1),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionType: text("resolution_type"),
    resolutionSummary: text("resolution_summary"),
    domainPayload: jsonb("domain_payload").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    index("outcomes_workspace_state_index").on(table.workspaceId, table.lifecycleState),
    index("outcomes_owner_index").on(table.workspaceId, table.accountableOwnerPrincipalId),
  ],
);

export const outcomeContracts = pgTable(
  "outcome_contracts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    goal: text("goal"),
    definitionOfDone: text("definition_of_done"),
    nextMove: jsonb("next_move").$type<Record<string, unknown>>(),
    reviewPoint: jsonb("review_point").$type<Record<string, unknown>>(),
    privacyScope: text("privacy_scope").notNull(),
    candidateFields: jsonb("candidate_fields").$type<Record<string, unknown>>(),
    confirmedByPrincipalId: uuid("confirmed_by_principal_id").references(() => principals.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("outcome_contracts_outcome_version_unique").on(table.outcomeId, table.version),
  ],
);

export const outcomeParticipants = pgTable(
  "outcome_participants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    principalId: uuid("principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    status: text("status").notNull().default("suggested"),
    delegatedByParticipantId: uuid("delegated_by_participant_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("outcome_participants_outcome_principal_role_unique").on(
      table.outcomeId,
      table.principalId,
      table.role,
    ),
    index("outcome_participants_principal_index").on(table.principalId),
  ],
);

export const outcomeAudienceGrants = pgTable(
  "outcome_audience_grants",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    permission: text("permission").notNull(),
    grantedByPrincipalId: uuid("granted_by_principal_id").references(() => principals.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("outcome_audience_subject_permission_unique").on(
      table.outcomeId,
      table.subjectType,
      table.subjectId,
      table.permission,
    ),
  ],
);

export const evidenceReferences = pgTable(
  "evidence_references",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    evidenceKey: text("evidence_key").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceIdentifier: text("source_identifier").notNull(),
    sourcePermalink: text("source_permalink"),
    sourceTimestamp: timestamp("source_timestamp", { withTimezone: true }),
    extractedAt: timestamp("extracted_at", { withTimezone: true }).defaultNow().notNull(),
    classification: text("classification").notNull(),
    confidence: text("confidence").notNull(),
    freshness: text("freshness").notNull(),
    visibilityContext: jsonb("visibility_context").$type<Record<string, unknown>>().notNull(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("evidence_references_outcome_key_unique").on(table.outcomeId, table.evidenceKey),
    index("evidence_outcome_index").on(table.outcomeId),
  ],
);

export const connectedRecords = pgTable(
  "connected_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    connector: text("connector").notNull(),
    externalId: text("external_id").notNull(),
    externalUrl: text("external_url"),
    externalVersion: text("external_version"),
    health: text("health").notNull().default("unknown"),
    permissions: jsonb("permissions").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("connected_records_connector_external_unique").on(
      table.connector,
      table.externalId,
    ),
  ],
);

export const actionPlans = pgTable(
  "action_plans",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    createdByPrincipalId: uuid("created_by_principal_id")
      .notNull()
      .references(() => principals.id),
    executorPrincipalId: uuid("executor_principal_id")
      .notNull()
      .references(() => principals.id),
    outcomeVersion: integer("outcome_version").notNull(),
    contractVersion: integer("contract_version").notNull(),
    version: integer("version").notNull().default(1),
    state: text("state").notNull().default("planned"),
    reversibility: text("reversibility").notNull(),
    beforeState: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
    proposedActions: jsonb("proposed_actions").$type<unknown[]>().notNull(),
    evidenceSnapshot: jsonb("evidence_snapshot").$type<unknown[]>().notNull(),
    policyVersion: text("policy_version").notNull(),
    planHash: text("plan_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    domainPayload: jsonb("domain_payload").$type<Record<string, unknown>>().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_plans_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
    uniqueIndex("action_plans_hash_unique").on(table.workspaceId, table.planHash),
    index("action_plans_outcome_state_index").on(table.outcomeId, table.state),
  ],
);

/** App-owned Slack cards only. Their exact previous Block Kit payload is the reversible-action before state. */
export const slackOutcomeCards = pgTable(
  "slack_outcome_cards",
  {
    outcomeId: uuid("outcome_id")
      .primaryKey()
      .references(() => outcomes.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    messageTs: text("message_ts").notNull(),
    audienceKind: text("audience_kind").notNull(),
    audiencePrincipalIds: jsonb("audience_principal_ids").$type<string[]>().notNull(),
    blocks: jsonb("blocks").$type<Record<string, unknown>[]>().notNull(),
    fallbackText: text("fallback_text").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("slack_outcome_cards_channel_message_unique").on(table.channelId, table.messageTs),
    index("slack_outcome_cards_workspace_index").on(table.workspaceId),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actionPlanId: uuid("action_plan_id")
      .notNull()
      .references(() => actionPlans.id, { onDelete: "cascade" }),
    approverPrincipalId: uuid("approver_principal_id")
      .notNull()
      .references(() => principals.id),
    decision: text("decision").notNull(),
    decisionReason: text("decision_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).defaultNow().notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("approvals_plan_approver_unique").on(table.actionPlanId, table.approverPrincipalId),
  ],
);

export const executions = pgTable(
  "executions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actionPlanId: uuid("action_plan_id")
      .notNull()
      .references(() => actionPlans.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    externalReceipt: jsonb("external_receipt").$type<Record<string, unknown>>(),
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("executions_plan_state_index").on(table.actionPlanId, table.state)],
);

export const inboundDeliveries = pgTable(
  "inbound_deliveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deliveryKey: text("delivery_key").notNull(),
    source: text("source").notNull(),
    workspaceSlackTeamId: text("workspace_slack_team_id"),
    payloadHash: text("payload_hash").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inbound_deliveries_source_key_unique").on(table.source, table.deliveryKey),
  ],
);

/**
 * Short-lived, server-side state for a Slack message shortcut. The opaque modal
 * value is only a lookup key; it has no authority by itself.
 */
export const slackInteractionContexts = pgTable(
  "slack_interaction_contexts",
  {
    reference: uuid("reference").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    creatorPrincipalId: uuid("creator_principal_id")
      .notNull()
      .references(() => principals.id, { onDelete: "cascade" }),
    sourceChannelId: text("source_channel_id").notNull(),
    sourceMessageTs: text("source_message_ts").notNull(),
    sourceText: text("source_text").notNull(),
    sourcePermalink: text("source_permalink").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("slack_interaction_contexts_workspace_expiry_index").on(
      table.workspaceId,
      table.expiresAt,
    ),
    index("slack_interaction_contexts_expiry_index").on(table.expiresAt),
  ],
);

export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("outbox_jobs_workspace_dedupe_unique").on(table.workspaceId, table.dedupeKey),
    index("outbox_jobs_workspace_state_available_index").on(
      table.workspaceId,
      table.state,
      table.availableAt,
    ),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorPrincipalId: uuid("actor_principal_id").references(() => principals.id),
    outcomeId: uuid("outcome_id").references(() => outcomes.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    causationId: text("causation_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    policyVersion: text("policy_version"),
    beforeValue: jsonb("before_value").$type<Record<string, unknown>>(),
    afterValue: jsonb("after_value").$type<Record<string, unknown>>(),
    evidenceReferenceIds: jsonb("evidence_reference_ids").$type<string[]>().notNull().default([]),
    redactedAt: timestamp("redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_workspace_created_index").on(table.workspaceId, table.createdAt),
    index("audit_events_outcome_index").on(table.outcomeId),
  ],
);
