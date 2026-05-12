-- Phase I Stage 2 (post-audit): pre-flight model-compatibility validation.
-- The PATCH /api/v1/workspaces/:id/providers/:instanceId handler runs a
-- synthetic generateObject call after a model is selected/changed and
-- records the outcome on the provider_instance row so the frontend can
-- surface a "model is incompatible with structured output — using repair
-- wrapper" warning BEFORE the user hits a real failure mid-task.
--
-- Status values:
--   'native'  — direct generateObject succeeded (no repair needed)
--   'repair'  — repair path produced the structured output (generateText
--               + JSON-extract + zod-validate, or fenced-JSON rescue)
--   'failed'  — both native + repair failed
--   NULL      — never validated (legacy rows + just-created instances)
--
-- IF NOT EXISTS guards make this idempotent across envs that may have
-- added the columns ad-hoc.
ALTER TABLE provider_instances ADD COLUMN IF NOT EXISTS model_compat_status text;
ALTER TABLE provider_instances ADD COLUMN IF NOT EXISTS model_compat_validated_at timestamptz;
