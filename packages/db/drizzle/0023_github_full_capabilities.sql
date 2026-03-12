-- Expand GitHub connection tools to reflect full read/write capabilities.
-- The MCP server (@modelcontextprotocol/server-github) already supports all
-- of these operations — the registry was just understating what's available.

UPDATE connections_registry
SET
    description = 'Full read/write access to repositories, branches, files, issues, pull requests, releases, and GitHub Actions.',
    tools_provided = '["read_code", "write_code", "create_file", "push_commits", "create_branch", "delete_branch", "create_pr", "merge_pr", "review_pr", "list_issues", "create_issue", "update_issue", "search_code", "list_prs", "get_ci_status", "manage_releases", "fork_repo"]'::jsonb
WHERE id = 'github';
