-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 Joeybuilt LLC
--
-- Big-bang rename: Fabric → PEX (Plexo Extension Protocol).
--
-- extensions.fabric_version → extensions.pex_version
-- extensions.source default 'fabric' → 'pex' (and any existing 'fabric' rows updated)
--
-- Safe because the live `extensions` table has 0 installed extensions at
-- the time of this migration. The `extension_registry` stub rows are
-- unaffected — they live in a separate table.

-- 1. Rename the column on extensions (no data copy needed; single rename).
ALTER TABLE extensions
    RENAME COLUMN fabric_version TO pex_version;

-- 2. Update the `source` column default and normalize any existing rows.
--    0 installed rows expected, but do this defensively for any historical
--    'fabric' values so the rename is total.
UPDATE extensions
    SET source = 'pex'
    WHERE source = 'fabric';

ALTER TABLE extensions
    ALTER COLUMN source SET DEFAULT 'pex';
