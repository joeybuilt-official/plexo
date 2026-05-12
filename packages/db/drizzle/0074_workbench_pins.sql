-- 0074_workbench_pins — Works Phase 7 workbench handoff.
--
-- Additive. Stores which works a user has pinned to their workbench pane.
-- References artifacts(id) which is a TEXT (ulid) column, not uuid — the
-- FK column type mirrors it. User id is text (Better Auth id), no FK
-- because users live behind postgres_fdw (same reasoning as 0071).

CREATE TABLE IF NOT EXISTS workbench_pins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    work_id text NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    position integer NOT NULL DEFAULT 0,
    pinned_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workbench_pins_user_work_idx
    ON workbench_pins(user_id, work_id);

CREATE INDEX IF NOT EXISTS workbench_pins_user_position_idx
    ON workbench_pins(user_id, position);

CREATE INDEX IF NOT EXISTS workbench_pins_workspace_idx
    ON workbench_pins(workspace_id);
