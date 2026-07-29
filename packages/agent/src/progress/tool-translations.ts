// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Translate internal tool names into plain-English present-continuous
 * progress descriptions suitable for user-facing channels (Telegram, SMS,
 * webchat). Prefers specific copy for common tools; falls back to a
 * generic humanization of the tool name for anything unknown.
 */

const EXACT_MATCHES: Record<string, string> = {
    // Built-in executor tools
    read_file: 'Reading a file',
    write_file: 'Writing a file',
    write_asset: 'Saving your deliverable',
    shell: 'Running a command',
    task_complete: 'Wrapping up',
    self_reflect: 'Thinking it through',

    // Web
    web_search: 'Searching the web',
    web_fetch: 'Fetching a page',
    web_read_page: 'Reading a web page',

    // Workspace
    memory_query: 'Checking your memory',
    setup_ssh_connection: 'Setting up SSH',
    setup_connection: 'Setting up a connection',
    list_available_connections: 'Listing available connections',
    list_installed_connections: 'Checking your connections',
    remove_connection: 'Removing a connection',
    setup_channel: 'Setting up a channel',
    list_channels: 'Checking your channels',
    remove_channel: 'Removing a channel',
    browse_hub: 'Browsing the Hub',
    install_extension: 'Installing an extension',
    list_extensions: 'Checking your extensions',
    toggle_extension: 'Toggling an extension',
    uninstall_extension: 'Uninstalling an extension',
    synthesize_extension: 'Building a new extension',
    configure_agent: 'Updating your agent',
    configure_voice: 'Updating voice settings',
    create_agent: 'Creating a new agent',
    manage_behavior: 'Updating behavior',
    toggle_connection_tool: 'Updating a connection tool',

    // Self-knowledge / environment
    list_my_tools: 'Checking my tools',
    get_my_capabilities: 'Checking my capabilities',
    check_connection_status: 'Checking connection status',
    about_plexo: 'Checking Plexo info',
    get_runtime_environment: 'Checking runtime info',
    get_infrastructure: 'Checking infrastructure',
    get_repository_info: 'Checking repo info',
    get_deployment_context: 'Checking deploy context',
    get_self_modification_scope: 'Checking self-modification scope',

    // Levio
    levio__list_emails: 'Checking your email',
    levio__list_events: 'Checking your calendar',
    levio__create_task: 'Creating your task',
}

// Prefix-based matches apply when exact lookup misses. Ordered — first hit wins.
// Keys are matched against the tool name after stripping known namespace prefixes
// (e.g. "plugin__notion__create_page" → "notion__create_page" → fallback verb map).
const VERB_PATTERNS: Array<{ test: RegExp; render: (m: RegExpMatchArray) => string }> = [
    { test: /^(?:[a-z0-9]+__)*list_(\w+)$/, render: (m) => `Listing ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*get_(\w+)$/, render: (m) => `Fetching ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*search_(\w+)$/, render: (m) => `Searching ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*create_(\w+)$/, render: (m) => `Creating a ${humanize(m[1]!).replace(/s$/, '')}` },
    { test: /^(?:[a-z0-9]+__)*update_(\w+)$/, render: (m) => `Updating a ${humanize(m[1]!).replace(/s$/, '')}` },
    { test: /^(?:[a-z0-9]+__)*delete_(\w+)$/, render: (m) => `Deleting a ${humanize(m[1]!).replace(/s$/, '')}` },
    { test: /^(?:[a-z0-9]+__)*remove_(\w+)$/, render: (m) => `Removing a ${humanize(m[1]!).replace(/s$/, '')}` },
    { test: /^(?:[a-z0-9]+__)*send_(\w+)$/, render: (m) => `Sending a ${humanize(m[1]!).replace(/s$/, '')}` },
    { test: /^(?:[a-z0-9]+__)*read_(\w+)$/, render: (m) => `Reading ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*write_(\w+)$/, render: (m) => `Writing ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*check_(\w+)$/, render: (m) => `Checking ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*query_(\w+)$/, render: (m) => `Querying ${humanize(m[1]!)}` },
    { test: /^(?:[a-z0-9]+__)*fetch_(\w+)$/, render: (m) => `Fetching ${humanize(m[1]!)}` },
]

function humanize(slug: string): string {
    return slug.replace(/_/g, ' ').toLowerCase()
}

/**
 * Produce a user-facing present-continuous description for a tool call.
 * Returns a non-empty string — callers can show it directly.
 */
export function describeToolCall(toolName: string | undefined | null): string {
    if (!toolName) return 'Working on it'
    const direct = EXACT_MATCHES[toolName]
    if (direct) return direct

    for (const { test, render } of VERB_PATTERNS) {
        const m = toolName.match(test)
        if (m) return render(m)
    }

    // plugin__ext__action → "Using ext: action"
    const pluginMatch = toolName.match(/^plugin__([a-z0-9-]+)__(\w+)$/)
    if (pluginMatch) {
        return `Running ${humanize(pluginMatch[2]!)} in ${pluginMatch[1]!}`
    }

    // generic namespace__action → "Using namespace: action"
    const nsMatch = toolName.match(/^([a-z0-9]+)__(\w+)$/)
    if (nsMatch) {
        return `Running ${humanize(nsMatch[2]!)} in ${nsMatch[1]!}`
    }

    // Unknown — humanize the whole name
    return `Running ${humanize(toolName)}`
}
