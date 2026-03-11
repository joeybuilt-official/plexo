ALTER TYPE "public"."task_type" ADD VALUE 'writing';--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'general';--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'data';--> statement-breakpoint
ALTER TYPE "public"."task_type" ADD VALUE 'marketing';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;