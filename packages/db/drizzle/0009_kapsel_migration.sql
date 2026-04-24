-- Migration 0009: Kapsel standard adoption
--
-- 1. Replace plugin_type enum: drop 'card', add 'agent' → matches §2 types
-- 2. Rename plugins.manifest → plugins.kapsel_manifest (enforces Kapsel schema)
-- 3. Add plugins.entry column (§3.1 required field)
-- 4. Add plugins.kapsel_version column (which spec version manifest targets)
--
-- No existing plugin rows — zero data migration risk.

-- Step 1: Create the new enum with Kapsel-correct values
CREATE TYPE plugin_type_new AS ENUM ('agent', 'skill', 'channel', 'tool', 'mcp-server');

-- Step 2: Swap the column type (table is empty so no row conversion needed)
ALTER TABLE plugins
    ALTER COLUMN type TYPE plugin_type_new USING type::text::plugin_type_new;

-- Step 3: Drop old enum, rename new one
DROP TYPE plugin_type;
ALTER TYPE plugin_type_new RENAME TO plugin_type;

-- Step 4: Rename manifest → kapsel_manifest
ALTER TABLE plugins RENAME COLUMN manifest TO kapsel_manifest;

-- Step 5: Add entry column (required by §3.1)
ALTER TABLE plugins
    ADD COLUMN IF NOT EXISTS entry TEXT NOT NULL DEFAULT './dist/index.js';

-- Step 6: Add kapsel_version column (spec version the manifest targets)
ALTER TABLE plugins
    ADD COLUMN IF NOT EXISTS kapsel_version TEXT NOT NULL DEFAULT '0.2.0';

-- Step 7: Drop the default on entry (it should be explicit going forward)
ALTER TABLE plugins ALTER COLUMN entry DROP DEFAULT;
ALTER TABLE plugins ALTER COLUMN kapsel_version DROP DEFAULT;
