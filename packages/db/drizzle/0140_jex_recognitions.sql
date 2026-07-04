CREATE TABLE IF NOT EXISTS "jex_recognitions" (
	"app_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"credential_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jex_recognitions_app_id_user_id_credential_id_pk" PRIMARY KEY("app_id","user_id","credential_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jex_recognitions_user_idx" ON "jex_recognitions" USING btree ("user_id");
