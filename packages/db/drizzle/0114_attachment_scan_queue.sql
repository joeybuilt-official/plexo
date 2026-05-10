CREATE TABLE "attachment_scan_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"conversation_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"storage_url" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"enqueued_at" timestamptz NOT NULL DEFAULT now(),
	"started_at" timestamptz,
	"completed_at" timestamptz,
	"consecutive_failures" integer NOT NULL DEFAULT 0,
	"last_error" text,
	"result" text,
	CONSTRAINT "attachment_scan_queue_content_hash_unique" UNIQUE ("content_hash")
);
--> statement-breakpoint
CREATE INDEX "idx_attachment_scan_queue_pending"
	ON "attachment_scan_queue" ("enqueued_at")
	WHERE "completed_at" IS NULL;
