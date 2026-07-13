-- Tenant defense in depth. Repository transactions set app.workspace_id before
-- every scoped query; deployments must use a non-owner runtime role so RLS is
-- not bypassed by PostgreSQL's table-owner exception.
ALTER TABLE "principals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outcomes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connected_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "action_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_outcome_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_interaction_contexts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "principals_workspace_isolation" ON "principals"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "installations_workspace_isolation" ON "installations"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "outcomes_workspace_isolation" ON "outcomes"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "connected_records_workspace_isolation" ON "connected_records"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "evidence_references_workspace_isolation" ON "evidence_references"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "action_plans_workspace_isolation" ON "action_plans"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "audit_events_workspace_isolation" ON "audit_events"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "slack_outcome_cards_workspace_isolation" ON "slack_outcome_cards"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
CREATE POLICY "slack_interaction_contexts_workspace_isolation" ON "slack_interaction_contexts"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint
ALTER TABLE "outcome_contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outcome_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outcome_audience_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "executions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outcome_contracts_workspace_isolation" ON "outcome_contracts"
  USING (EXISTS (SELECT 1 FROM outcomes WHERE outcomes.id = outcome_contracts.outcome_id AND outcomes.workspace_id::text = current_setting('app.workspace_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM outcomes WHERE outcomes.id = outcome_contracts.outcome_id AND outcomes.workspace_id::text = current_setting('app.workspace_id', true)));
CREATE POLICY "outcome_participants_workspace_isolation" ON "outcome_participants"
  USING (EXISTS (SELECT 1 FROM outcomes WHERE outcomes.id = outcome_participants.outcome_id AND outcomes.workspace_id::text = current_setting('app.workspace_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM outcomes WHERE outcomes.id = outcome_participants.outcome_id AND outcomes.workspace_id::text = current_setting('app.workspace_id', true)));
CREATE POLICY "outcome_audience_grants_workspace_isolation" ON "outcome_audience_grants"
  USING (EXISTS (SELECT 1 FROM outcomes WHERE outcomes.id = outcome_audience_grants.outcome_id AND outcomes.workspace_id::text = current_setting('app.workspace_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM outcomes WHERE outcomes.id = outcome_audience_grants.outcome_id AND outcomes.workspace_id::text = current_setting('app.workspace_id', true)));
CREATE POLICY "approvals_workspace_isolation" ON "approvals"
  USING (EXISTS (SELECT 1 FROM action_plans WHERE action_plans.id = approvals.action_plan_id AND action_plans.workspace_id::text = current_setting('app.workspace_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM action_plans WHERE action_plans.id = approvals.action_plan_id AND action_plans.workspace_id::text = current_setting('app.workspace_id', true)));
CREATE POLICY "executions_workspace_isolation" ON "executions"
  USING (EXISTS (SELECT 1 FROM action_plans WHERE action_plans.id = executions.action_plan_id AND action_plans.workspace_id::text = current_setting('app.workspace_id', true)))
  WITH CHECK (EXISTS (SELECT 1 FROM action_plans WHERE action_plans.id = executions.action_plan_id AND action_plans.workspace_id::text = current_setting('app.workspace_id', true)));
