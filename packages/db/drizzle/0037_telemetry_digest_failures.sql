-- Telemetry: dead letter table for failed weekly error digests
-- Written by the digest worker when GitHub API is unavailable after retries.
CREATE TABLE "telemetry_digest_failures" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "week_of" date NOT NULL,
    "attempt" integer NOT NULL,
    "error" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "idx_digest_failures_week" ON "telemetry_digest_failures" ("week_of");
