CREATE TABLE IF NOT EXISTS "message_deliveries" (
    "id" text PRIMARY KEY NOT NULL,
    "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
    "channel" text NOT NULL,
    "chat_id" text NOT NULL,
    "status" text NOT NULL,
    "error_message" text,
    "message_length" integer NOT NULL,
    "latency_ms" integer,
    "conversation_id" text,
    "markdown_retry" boolean NOT NULL DEFAULT false,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "message_deliveries_workspace_idx" ON "message_deliveries" ("workspace_id");
CREATE INDEX IF NOT EXISTS "message_deliveries_workspace_created_idx" ON "message_deliveries" ("workspace_id", "created_at");
CREATE INDEX IF NOT EXISTS "message_deliveries_status_idx" ON "message_deliveries" ("status");
CREATE INDEX IF NOT EXISTS "message_deliveries_channel_idx" ON "message_deliveries" ("channel");
