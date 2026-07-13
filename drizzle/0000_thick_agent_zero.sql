CREATE TABLE "action_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"executor_principal_id" uuid NOT NULL,
	"outcome_version" integer NOT NULL,
	"contract_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'planned' NOT NULL,
	"reversibility" text NOT NULL,
	"before_state" jsonb NOT NULL,
	"proposed_actions" jsonb NOT NULL,
	"evidence_snapshot" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"plan_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"domain_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_plan_id" uuid NOT NULL,
	"approver_principal_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"decision_reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_principal_id" uuid,
	"outcome_id" uuid,
	"type" text NOT NULL,
	"causation_id" text NOT NULL,
	"correlation_id" text NOT NULL,
	"policy_version" text,
	"before_value" jsonb,
	"after_value" jsonb,
	"evidence_reference_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redacted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"connector" text NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"external_version" text,
	"health" text DEFAULT 'unknown' NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"source_system" text NOT NULL,
	"source_identifier" text NOT NULL,
	"source_permalink" text,
	"source_timestamp" timestamp with time zone,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"classification" text NOT NULL,
	"confidence" text NOT NULL,
	"freshness" text NOT NULL,
	"visibility_context" jsonb NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action_plan_id" uuid NOT NULL,
	"state" text NOT NULL,
	"external_receipt" jsonb,
	"error_category" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_key" text NOT NULL,
	"source" text NOT NULL,
	"workspace_slack_team_id" text,
	"payload_hash" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_enterprise_id" text,
	"encrypted_bot_token" jsonb,
	"encrypted_refresh_token" jsonb,
	"token_expires_at" timestamp with time zone,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_audience_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outcome_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"permission" text NOT NULL,
	"granted_by_principal_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outcome_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"goal" text,
	"definition_of_done" jsonb,
	"next_move" jsonb,
	"review_point" jsonb,
	"privacy_scope" text NOT NULL,
	"candidate_fields" jsonb,
	"confirmed_by_principal_id" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outcome_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"delegated_by_participant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"privacy_scope" text NOT NULL,
	"title" text NOT NULL,
	"requester_principal_id" uuid,
	"accountable_owner_principal_id" uuid,
	"contract_version" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution_type" text,
	"resolution_summary" text,
	"domain_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_user_id" text NOT NULL,
	"display_name" text,
	"email" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_interaction_contexts" (
	"reference" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"creator_principal_id" uuid NOT NULL,
	"source_channel_id" text NOT NULL,
	"source_message_ts" text NOT NULL,
	"source_text" text NOT NULL,
	"source_permalink" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_outcome_cards" (
	"outcome_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"audience_kind" text NOT NULL,
	"audience_principal_ids" jsonb NOT NULL,
	"blocks" jsonb NOT NULL,
	"fallback_text" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slack_team_id" text NOT NULL,
	"name" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_plans" ADD CONSTRAINT "action_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plans" ADD CONSTRAINT "action_plans_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plans" ADD CONSTRAINT "action_plans_created_by_principal_id_principals_id_fk" FOREIGN KEY ("created_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_plans" ADD CONSTRAINT "action_plans_executor_principal_id_principals_id_fk" FOREIGN KEY ("executor_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_plan_id_action_plans_id_fk" FOREIGN KEY ("action_plan_id") REFERENCES "public"."action_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_principal_id_principals_id_fk" FOREIGN KEY ("approver_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_principal_id_principals_id_fk" FOREIGN KEY ("actor_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_records" ADD CONSTRAINT "connected_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connected_records" ADD CONSTRAINT "connected_records_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_references" ADD CONSTRAINT "evidence_references_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_references" ADD CONSTRAINT "evidence_references_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_action_plan_id_action_plans_id_fk" FOREIGN KEY ("action_plan_id") REFERENCES "public"."action_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installations" ADD CONSTRAINT "installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_audience_grants" ADD CONSTRAINT "outcome_audience_grants_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_audience_grants" ADD CONSTRAINT "outcome_audience_grants_granted_by_principal_id_principals_id_fk" FOREIGN KEY ("granted_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_contracts" ADD CONSTRAINT "outcome_contracts_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_contracts" ADD CONSTRAINT "outcome_contracts_confirmed_by_principal_id_principals_id_fk" FOREIGN KEY ("confirmed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_participants" ADD CONSTRAINT "outcome_participants_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_participants" ADD CONSTRAINT "outcome_participants_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_requester_principal_id_principals_id_fk" FOREIGN KEY ("requester_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_accountable_owner_principal_id_principals_id_fk" FOREIGN KEY ("accountable_owner_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_interaction_contexts" ADD CONSTRAINT "slack_interaction_contexts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_interaction_contexts" ADD CONSTRAINT "slack_interaction_contexts_creator_principal_id_principals_id_fk" FOREIGN KEY ("creator_principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outcome_cards" ADD CONSTRAINT "slack_outcome_cards_outcome_id_outcomes_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "public"."outcomes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slack_outcome_cards" ADD CONSTRAINT "slack_outcome_cards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "action_plans_idempotency_unique" ON "action_plans" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "action_plans_hash_unique" ON "action_plans" USING btree ("workspace_id","plan_hash");--> statement-breakpoint
CREATE INDEX "action_plans_outcome_state_index" ON "action_plans" USING btree ("outcome_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_plan_approver_unique" ON "approvals" USING btree ("action_plan_id","approver_principal_id");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_index" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_outcome_index" ON "audit_events" USING btree ("outcome_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connected_records_connector_external_unique" ON "connected_records" USING btree ("connector","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_references_outcome_key_unique" ON "evidence_references" USING btree ("outcome_id","evidence_key");--> statement-breakpoint
CREATE INDEX "evidence_outcome_index" ON "evidence_references" USING btree ("outcome_id");--> statement-breakpoint
CREATE INDEX "executions_plan_state_index" ON "executions" USING btree ("action_plan_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_deliveries_source_key_unique" ON "inbound_deliveries" USING btree ("source","delivery_key");--> statement-breakpoint
CREATE UNIQUE INDEX "installations_workspace_unique" ON "installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "outbox_jobs_state_available_index" ON "outbox_jobs" USING btree ("state","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_audience_subject_permission_unique" ON "outcome_audience_grants" USING btree ("outcome_id","subject_type","subject_id","permission");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_contracts_outcome_version_unique" ON "outcome_contracts" USING btree ("outcome_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "outcome_participants_outcome_principal_role_unique" ON "outcome_participants" USING btree ("outcome_id","principal_id","role");--> statement-breakpoint
CREATE INDEX "outcome_participants_principal_index" ON "outcome_participants" USING btree ("principal_id");--> statement-breakpoint
CREATE INDEX "outcomes_workspace_state_index" ON "outcomes" USING btree ("workspace_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "outcomes_owner_index" ON "outcomes" USING btree ("workspace_id","accountable_owner_principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "principals_workspace_slack_user_unique" ON "principals" USING btree ("workspace_id","slack_user_id");--> statement-breakpoint
CREATE INDEX "principals_workspace_index" ON "principals" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "slack_interaction_contexts_workspace_expiry_index" ON "slack_interaction_contexts" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "slack_interaction_contexts_expiry_index" ON "slack_interaction_contexts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_outcome_cards_channel_message_unique" ON "slack_outcome_cards" USING btree ("channel_id","message_ts");--> statement-breakpoint
CREATE INDEX "slack_outcome_cards_workspace_index" ON "slack_outcome_cards" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slack_team_id_unique" ON "workspaces" USING btree ("slack_team_id");
