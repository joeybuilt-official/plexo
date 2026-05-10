-- Hub schema additions: category, readme, icon, full-text search
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'other';
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS readme text NOT NULL DEFAULT '';
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS icon_url text;

CREATE INDEX IF NOT EXISTS extension_registry_category_idx ON extension_registry(category);

-- Full-text search vector (generated from name + display_name + description)
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('english',
            coalesce(name, '') || ' ' ||
            coalesce(display_name, '') || ' ' ||
            coalesce(description, '')
        )
    ) STORED;

CREATE INDEX IF NOT EXISTS extension_registry_search_idx ON extension_registry USING gin(search_vector);
