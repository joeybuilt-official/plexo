-- Attribution columns for imported third-party items.
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS source_author text;
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS source_license text;
ALTER TABLE extension_registry ADD COLUMN IF NOT EXISTS source_repo text;

-- Voting table.
CREATE TABLE IF NOT EXISTS extension_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extension_id text NOT NULL,  -- references extension_registry.name (text, FDW-compatible)
  user_id text NOT NULL,
  vote_type text NOT NULL CHECK (vote_type IN ('up', 'down')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS extension_votes_user_extension_idx ON extension_votes(user_id, extension_id);
CREATE INDEX IF NOT EXISTS extension_votes_extension_idx ON extension_votes(extension_id);

-- Materialized view for fast vote count lookups (refreshed by trigger).
CREATE OR REPLACE VIEW extension_vote_counts AS
SELECT
  extension_id,
  COUNT(*) FILTER (WHERE vote_type = 'up') AS upvotes,
  COUNT(*) FILTER (WHERE vote_type = 'down') AS downvotes,
  COUNT(*) FILTER (WHERE vote_type = 'up') - COUNT(*) FILTER (WHERE vote_type = 'down') AS score
FROM extension_votes
GROUP BY extension_id;
