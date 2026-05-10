-- Plexo Fabric Migration
-- Renames Kapsel-era tables and columns to Plexo Fabric naming conventions.
-- Part of the Kapsel → Plexo Fabric absorption (v0.4.0).

-- ── Table renames ──────────────────────────────────────────────────────────

ALTER TABLE "plugins" RENAME TO "extensions";
ALTER TABLE "kapsel_registry" RENAME TO "extension_registry";
ALTER TABLE "kapsel_audit_log" RENAME TO "extension_audit_log";

-- ── Column renames (extensions table, formerly plugins) ────────────────────

ALTER TABLE "extensions" RENAME COLUMN "kapsel_version" TO "fabric_version";
ALTER TABLE "extensions" RENAME COLUMN "kapsel_manifest" TO "manifest";

-- ── Enum rename ────────────────────────────────────────────────────────────

ALTER TYPE "plugin_type" RENAME TO "extension_type";

-- Add 'connector' value to the extension_type enum (replaces 'mcp-server' conceptually,
-- but we keep 'mcp-server' for backward compat with existing rows and add 'connector')
ALTER TYPE "extension_type" ADD VALUE IF NOT EXISTS 'connector';

-- ── Index renames (for clarity — Postgres handles FK references automatically) ──

ALTER INDEX "plugins_workspace_idx" RENAME TO "extensions_workspace_idx";
ALTER INDEX "plugins_workspace_name_uq" RENAME TO "extensions_workspace_name_uq";
ALTER INDEX "kapsel_registry_name_idx" RENAME TO "extension_registry_name_idx";
ALTER INDEX "kapsel_registry_publisher_idx" RENAME TO "extension_registry_publisher_idx";
ALTER INDEX "kapsel_registry_deprecated_idx" RENAME TO "extension_registry_deprecated_idx";
ALTER INDEX "idx_kapsel_audit_workspace_time" RENAME TO "ext_audit_workspace_time_idx";
ALTER INDEX "idx_kapsel_audit_extension" RENAME TO "ext_audit_extension_idx";
