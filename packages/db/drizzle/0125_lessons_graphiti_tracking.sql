-- ADR-0010 Phase 3: track Graphiti episode ID on prompt_revisions for temporal invalidation.
--
-- graphiti_episode_id: set asynchronously when the lessons-graphiti-write Inngest job
--   completes. Used by readFromGraphiti callers to populate lessonEpisodeIds for recall cap.
--
-- graphiti_invalidated_at: set when a lesson is physically deleted from the graph via
--   invalidateLessonForRevision(). Null means the lesson is still live in Graphiti.
--
-- SAFE: additive-only. Existing rows get NULL for both columns (correct — no episode written yet).
-- Apply after DISTILL_ENABLED=true has been observed for ≥1 revision in prod.

ALTER TABLE prompt_revisions
    ADD COLUMN IF NOT EXISTS graphiti_episode_id      text,
    ADD COLUMN IF NOT EXISTS graphiti_invalidated_at  timestamptz;

CREATE INDEX IF NOT EXISTS prompt_revisions_graphiti_ep_idx
    ON prompt_revisions (graphiti_episode_id)
    WHERE graphiti_episode_id IS NOT NULL;
