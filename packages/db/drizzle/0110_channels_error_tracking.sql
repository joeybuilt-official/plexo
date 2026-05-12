ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_error text;--> statement-breakpoint
ALTER TABLE channels ADD COLUMN IF NOT EXISTS last_error_at timestamp with time zone;
