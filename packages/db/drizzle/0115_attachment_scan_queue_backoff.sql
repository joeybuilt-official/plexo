ALTER TABLE "attachment_scan_queue" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_attachment_scan_queue_next_attempt"
	ON "attachment_scan_queue" ("next_attempt_at")
	WHERE "completed_at" IS NULL;
