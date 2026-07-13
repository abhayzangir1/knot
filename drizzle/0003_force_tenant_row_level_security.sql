-- Enforce the same tenant boundary for the table owner used by local and
-- managed deployments. workspaces and inbound receipts remain bootstrap-only
-- records and are separately constrained by the repository boundary.
ALTER TABLE "principals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "installations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outcomes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "connected_records" FORCE ROW LEVEL SECURITY;
ALTER TABLE "evidence_references" FORCE ROW LEVEL SECURITY;
ALTER TABLE "action_plans" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_outcome_cards" FORCE ROW LEVEL SECURITY;
ALTER TABLE "slack_interaction_contexts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outcome_contracts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outcome_participants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "outcome_audience_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;
ALTER TABLE "executions" FORCE ROW LEVEL SECURITY;
