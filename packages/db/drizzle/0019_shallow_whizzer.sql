CREATE TABLE "session_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid,
	"persona_id" varchar(64),
	"event_type" varchar(64) NOT NULL,
	"route" varchar(512),
	"action" varchar(256),
	"payload" jsonb,
	"response_code" integer,
	"response_body" jsonb,
	"error_message" text,
	"error_stack" text,
	"duration_ms" integer,
	"llm_model" varchar(128),
	"llm_prompt_tokens" integer,
	"llm_completion_tokens" integer,
	"output_type" varchar(64),
	"output_summary" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_logs" ADD CONSTRAINT "session_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;