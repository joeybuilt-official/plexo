-- Kapsel v0.3.0: Add 'function' type to plugin_type enum
-- 'function' replaces the deprecated 'tool' and 'skill' types in the Kapsel v0.3.0 spec.
-- Existing 'skill' and 'tool' values are kept for backward compatibility.
ALTER TYPE plugin_type ADD VALUE IF NOT EXISTS 'function';

-- Update default kapsel_version for new plugin installs
ALTER TABLE plugins ALTER COLUMN kapsel_version SET DEFAULT '0.3.0';
