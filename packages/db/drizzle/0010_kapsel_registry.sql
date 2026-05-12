-- Phase 21: Kapsel Extension Registry (§12)
-- Creates the kapsel_registry table for extension discovery

CREATE TABLE IF NOT EXISTS "kapsel_registry" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "display_name" text NOT NULL,
    "description" text NOT NULL,
    "publisher" text NOT NULL,
    "latest_version" text NOT NULL,
    "versions" jsonb DEFAULT '[]' NOT NULL,
    "manifest" jsonb NOT NULL,
    "tags" text[] DEFAULT '{}' NOT NULL,
    "install_count" integer DEFAULT 0 NOT NULL,
    "deprecated" boolean DEFAULT false NOT NULL,
    "checksum" text,
    "repository_url" text,
    "published_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "kapsel_registry_name_unique" UNIQUE("name")
);

CREATE INDEX IF NOT EXISTS "kapsel_registry_name_idx" ON "kapsel_registry" ("name");
CREATE INDEX IF NOT EXISTS "kapsel_registry_publisher_idx" ON "kapsel_registry" ("publisher");
CREATE INDEX IF NOT EXISTS "kapsel_registry_deprecated_idx" ON "kapsel_registry" ("deprecated");
