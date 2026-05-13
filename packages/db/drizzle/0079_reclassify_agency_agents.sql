-- Reclassify imported agency-agents rows from (missing type → 'tool' fallback)
-- to the correct 'agent' type.
--
-- Root cause: scripts/build-agency-staging.mjs built manifests without a
-- top-level `type` field. apps/api/src/routes/hub.ts:deriveType() falls back
-- to 'tool' when the manifest has no explicit type, so every agency-agents
-- row rendered under the Tools tab with the wrench icon. These are role-
-- specialized prompts — they belong under Agents.
--
-- Scope is narrow: only rows whose upstream source is the agency-agents
-- repo. Other extension_registry rows are untouched.

UPDATE extension_registry
SET manifest = jsonb_set(manifest, '{type}', '"agent"'::jsonb, true),
    updated_at = now()
WHERE source_repo = 'https://github.com/msitarzewski/agency-agents'
  AND (manifest->>'type' IS NULL OR manifest->>'type' = 'tool');
