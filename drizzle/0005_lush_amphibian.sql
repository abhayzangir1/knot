ALTER TABLE "outbox_jobs" ADD COLUMN "payload_hash" text;--> statement-breakpoint
UPDATE "outbox_jobs"
SET "payload_hash" = 'legacy:' || md5("payload"::text)
WHERE "payload_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ALTER COLUMN "payload_hash" SET NOT NULL;
