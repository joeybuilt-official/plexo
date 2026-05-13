// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @plexo/research-agent — reference PEX agent (Phase 5)
//
// This extension is the first installable reference agent shipped with the
// Plexo host. Under the agent-as-mode interpretation of PEX agents (Phase 5
// of the agents plan), it registers two tools:
//
//   research_query     — gather sources for a question
//   summarize_findings — synthesize findings into a markdown report
//
// Phase 6 is where true agent-as-mode runtime semantics kick in. Until then,
// this ships as a tool-bundle-with-an-agent-badge so the install flow,
// marketplace surfacing, and manifest schema can all be exercised end-to-end.
// ── Web search helpers ──────────────────────────────────────────────────────
//
// DuckDuckGo's HTML endpoint returns a simple page we can regex-parse without
// headless browsers or API keys. For a reference agent this is good enough;
// production research agents should swap in a real search API (Tavily,
// SerpAPI, Brave, etc.) via a Connection.
const DDG_ENDPOINT = 'https://duckduckgo.com/html/';
const USER_AGENT = 'Mozilla/5.0 (compatible; PlexoResearchAgent/1.0; +https://getplexo.com)';
const FETCH_TIMEOUT_MS = 15_000;
async function fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: {
                'user-agent': USER_AGENT,
                ...(init.headers ?? {}),
            },
        });
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Minimal DuckDuckGo HTML result parser. Pulls title / snippet / url from
 * the lightweight DDG HTML layout. Defensive — returns whatever it can find.
 */
function parseDuckDuckGoResults(html, limit) {
    const results = [];
    // Each result is wrapped in <a class="result__a" href="...">TITLE</a>
    // followed by a snippet in <a class="result__snippet">SNIPPET</a>.
    const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    let rank = 1;
    while ((match = blockRe.exec(html)) !== null) {
        if (results.length >= limit)
            break;
        const rawUrl = match[1] ?? '';
        const rawTitle = match[2] ?? '';
        const rawSnippet = match[3] ?? '';
        // DuckDuckGo wraps real URLs in /l/?uddg=<encoded>
        let url = rawUrl;
        try {
            if (url.startsWith('//'))
                url = 'https:' + url;
            const parsed = new URL(url, 'https://duckduckgo.com');
            const uddg = parsed.searchParams.get('uddg');
            if (uddg)
                url = decodeURIComponent(uddg);
        }
        catch {
            // Leave as-is if parsing fails
        }
        results.push({
            title: stripTags(rawTitle).trim(),
            url,
            snippet: stripTags(rawSnippet).trim(),
            rank: rank++,
        });
    }
    return results;
}
function stripTags(input) {
    return input
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ');
}
async function searchWeb(query, limit) {
    const params = new URLSearchParams({ q: query });
    const response = await fetchWithTimeout(`${DDG_ENDPOINT}?${params.toString()}`, {
        method: 'GET',
    });
    if (!response.ok) {
        throw new Error(`Web search failed: HTTP ${response.status}`);
    }
    const html = await response.text();
    return parseDuckDuckGoResults(html, limit);
}
// ── Tool handlers ───────────────────────────────────────────────────────────
function makeResearchQueryTool() {
    return {
        name: 'research_query',
        description: 'Gather sources for a research question. Performs a web search, extracts titles, URLs and snippets from the top results, and returns structured findings ready for summarization. Input: { query: string, depth?: "quick" | "deep", maxSources?: number }. Use depth="deep" for broader coverage (up to 10 sources).',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The research question or topic to investigate.',
                },
                depth: {
                    type: 'string',
                    enum: ['quick', 'deep'],
                    description: 'How thorough the search should be. "quick" returns up to 5 sources; "deep" returns up to 10.',
                },
                maxSources: {
                    type: 'integer',
                    description: 'Hard cap on the number of sources returned. Overrides depth when provided.',
                },
            },
            required: ['query'],
        },
        hints: {
            estimatedMs: 6000,
            timeoutMs: 30_000,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params) => {
            const input = (params ?? {});
            const query = String(input.query ?? '').trim();
            if (!query) {
                throw new Error('research_query: "query" parameter is required');
            }
            const depth = input.depth === 'deep' ? 'deep' : 'quick';
            const defaultLimit = depth === 'deep' ? 10 : 5;
            const limit = Math.min(Math.max(1, input.maxSources ?? defaultLimit), 15);
            const sources = await searchWeb(query, limit);
            const notes = [];
            if (sources.length === 0) {
                notes.push('No results returned by the search engine. Consider rephrasing the query.');
            }
            else if (sources.length < limit) {
                notes.push(`Requested ${limit} sources but only ${sources.length} were available.`);
            }
            return {
                query,
                depth,
                fetchedAt: new Date().toISOString(),
                sources,
                notes,
            };
        },
    };
}
function makeSummarizeFindingsTool() {
    return {
        name: 'summarize_findings',
        description: 'Synthesize research findings into a structured markdown report with inline citations. Accepts the output of research_query. Input: { findings: object, format?: "brief" | "detailed" }. Returns a markdown string the agent can present to the user or write to a file.',
        parameters: {
            type: 'object',
            properties: {
                findings: {
                    type: 'object',
                    description: 'The findings object returned by research_query.',
                },
                format: {
                    type: 'string',
                    enum: ['brief', 'detailed'],
                    description: 'Report shape. "brief" is a bulleted one-screen summary; "detailed" adds per-source breakdowns.',
                },
            },
            required: ['findings'],
        },
        hints: {
            estimatedMs: 800,
            timeoutMs: 10_000,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params) => {
            const input = (params ?? {});
            const findings = input.findings;
            if (!findings || typeof findings !== 'object') {
                throw new Error('summarize_findings: "findings" parameter is required and must be an object');
            }
            const format = input.format === 'detailed' ? 'detailed' : 'brief';
            const sources = Array.isArray(findings.sources) ? findings.sources : [];
            const lines = [];
            lines.push(`# Research Summary: ${findings.query ?? 'Untitled'}`);
            lines.push('');
            lines.push(`_Depth: **${findings.depth ?? 'quick'}** — ${sources.length} source${sources.length === 1 ? '' : 's'}_`);
            if (findings.fetchedAt) {
                lines.push(`_Gathered: ${findings.fetchedAt}_`);
            }
            lines.push('');
            if (sources.length === 0) {
                lines.push('_No sources were returned for this query._');
            }
            else {
                lines.push('## Key Points');
                lines.push('');
                for (const src of sources.slice(0, format === 'brief' ? 5 : sources.length)) {
                    const title = src.title || 'Untitled';
                    const snippet = src.snippet || '(no snippet)';
                    lines.push(`- **${title}** — ${snippet} [[${src.rank}]](${src.url})`);
                }
                lines.push('');
                if (format === 'detailed') {
                    lines.push('## Sources');
                    lines.push('');
                    for (const src of sources) {
                        lines.push(`### [${src.rank}] ${src.title || 'Untitled'}`);
                        lines.push(`${src.url}`);
                        lines.push('');
                        lines.push(src.snippet || '_(no snippet available)_');
                        lines.push('');
                    }
                }
                else {
                    lines.push('## Citations');
                    lines.push('');
                    for (const src of sources) {
                        lines.push(`${src.rank}. ${src.title || 'Untitled'} — ${src.url}`);
                    }
                }
            }
            const notes = Array.isArray(findings.notes) ? findings.notes : [];
            if (notes.length > 0) {
                lines.push('');
                lines.push('## Notes');
                for (const note of notes) {
                    lines.push(`- ${note}`);
                }
            }
            const report = lines.join('\n');
            return { report, sourceCount: sources.length, format };
        },
    };
}
// ── Activation entry point ──────────────────────────────────────────────────
export async function activate(sdk) {
    sdk.registerTool(makeResearchQueryTool());
    sdk.registerTool(makeSummarizeFindingsTool());
}
