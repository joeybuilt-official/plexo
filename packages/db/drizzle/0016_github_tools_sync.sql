-- 0016: Sync connections_registry tools_provided for github to match bridge.ts
-- Adds github__read_file and github__push_file which were implemented in Phase N.
-- Also corrects list_prs -> open_pr (the bridge now exports open_pr, not list_prs).

UPDATE connections_registry
SET tools_provided = '["create_branch","open_pr","merge_pr","list_issues","create_issue","get_ci_status","read_file","push_file"]'::jsonb
WHERE id = 'github';
