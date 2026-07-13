DROP INDEX "outbox_jobs_state_available_index";--> statement-breakpoint
DELETE FROM "outbox_jobs" WHERE "workspace_id" IS NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ALTER COLUMN "workspace_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
UPDATE "outbox_jobs" SET "dedupe_key" = 'legacy:' || "id"::text WHERE "dedupe_key" IS NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ALTER COLUMN "dedupe_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD COLUMN "locked_by" text;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_jobs_workspace_dedupe_unique" ON "outbox_jobs" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_jobs_workspace_state_available_index" ON "outbox_jobs" USING btree ("workspace_id","state","available_at");--> statement-breakpoint
ALTER TABLE "outbox_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "outbox_jobs_workspace_isolation" ON "outbox_jobs"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
ALTER TABLE "outbox_jobs" FORCE ROW LEVEL SECURITY;
