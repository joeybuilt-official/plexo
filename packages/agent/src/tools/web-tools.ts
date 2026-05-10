// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// SEC-032: SSRF protection — resolve hostname before fetch, reject private/internal IPs

/**
 * Consolidated web tools — one search, one fetch, one page-read.
 *
 * Providers (in priority order):
 *   1. Tavily          (TAVILY_API_KEY)        — purpose-built for agents, cleanest results
 *   2. Brave Search    (BRAVE_SEARCH_API_KEY)  — 2k free queries/month
 *   3. DuckDuckGo HTML — free, no key, scrapes html.duckduckgo.com
 *
 * All three are encapsulated behind `webSearch()`. Callers get a uniform shape.
 *
 * `webFetch()` — raw HTTP GET with SSRF guards, returns the raw body.
 * `webReadPage()` — fetches + extracts main readable text (strips nav/scripts/styles/tags).
 *
 * No heavy dependencies. No Playwright. Works in any Node 22+ container.
 */

import { lookup } from 'node:dns/promises'
import { tool } from 'ai'
import { z } from 'zod'
import pino from 'pino'

const logger = pino({ name: 'web-tools' })

// ── Types ────────────────────────────────────────────────────────────────────

export interface WebSearchResult {
    title: string
    url: string
    snippet: string
}

export interface WebSearchOptions {
    query: string
    maxResults?: number
    /** Optional injected keys (API layer resolves workspace-scoped keys). */
    tavilyApiKey?: string | null
    braveApiKey?: string | null
}

export interface WebSearchResponse {
    provider: 'tavily' | 'brave' | 'duckduckgo'
    results: WebSearchResult[]
}

// ── SSRF guards ──────────────────────────────────────────────────────────────

const BLOCKED_HOSTS = new Set([
    'localhost', '127.0.0.1', '0.0.0.0', '[::1]', 'metadata.google.internal',
    '169.254.169.254',
])

/** Check whether an IP is in a private, loopback, or reserved range. */
function isPrivateOrReservedIP(ip: string): boolean {
    // IPv4
    const parts = ip.split('.').map(Number)
    if (parts.length === 4 && parts.every((n) => n >= 0 && n <= 255)) {
        return (
            parts[0] === 127 ||                                           // loopback
            parts[0] === 10 ||                                            // 10.0.0.0/8
            (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||  // 172.16.0.0/12
            (parts[0] === 192 && parts[1] === 168) ||                    // 192.168.0.0/16
            (parts[0] === 169 && parts[1] === 254) ||                    // link-local
            parts[0] === 0                                                // 0.0.0.0/8
        )
    }
    // IPv6
    const lower = ip.toLowerCase()
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')
}

/**
 * Resolve hostname via DNS and check the resulting IP against private/reserved ranges.
 * Fails closed: DNS errors → blocked.
 */
async function isBlockedAddress(hostname: string): Promise<boolean> {
    if (BLOCKED_HOSTS.has(hostname.toLowerCase())) return true
    try {
        const { address } = await lookup(hostname)
        return isPrivateOrReservedIP(address)
    } catch {
        return true // DNS failure = block (fail closed)
    }
}

export async function isBlockedUrl(url: string): Promise<string | null> {
    try {
        const parsed = new URL(url)
        if (!/^https?:$/.test(parsed.protocol)) return 'Only http/https URLs are allowed'
        const host = parsed.hostname.toLowerCase()
        if (await isBlockedAddress(host)) return 'Blocked — internal/metadata/private host'
        return null
    } catch {
        return 'Invalid URL'
    }
}

// ── Web search ───────────────────────────────────────────────────────────────

/** Primary entry point — tries providers in order, returns first that succeeds. */
export async function webSearch(opts: WebSearchOptions): Promise<WebSearchResponse> {
    const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 10)
    const query = opts.query.trim()
    if (!query) return { provider: 'duckduckgo', results: [] }

    const tavilyKey = opts.tavilyApiKey ?? process.env.TAVILY_API_KEY ?? null
    const braveKey = opts.braveApiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? null

    // 1. Tavily
    if (tavilyKey) {
        try {
            const results = await searchTavily(query, maxResults, tavilyKey)
            if (results.length > 0) return { provider: 'tavily', results }
        } catch (err) {
            logger.warn({ err }, 'Tavily failed, falling back to next provider')
        }
    }

    // 2. Brave
    if (braveKey) {
        try {
            const results = await searchBrave(query, maxResults, braveKey)
            if (results.length > 0) return { provider: 'brave', results }
        } catch (err) {
            logger.warn({ err }, 'Brave failed, falling back to DuckDuckGo')
        }
    }

    // 3. DuckDuckGo HTML scrape — zero-config fallback
    const results = await searchDuckDuckGo(query, maxResults)
    if (results.length === 0) {
        logger.warn({ query: query.slice(0, 60), tavilyConfigured: !!tavilyKey, braveConfigured: !!braveKey }, 'All search providers returned zero results')
    }
    return { provider: 'duckduckgo', results }
}

async function searchTavily(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults,
            search_depth: 'basic',
            include_answer: false,
        }),
        signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`)
    const data = await res.json() as { results?: Array<{ title?: string; url?: string; content?: string }> }
    return (data.results ?? []).map((r) => ({
        title: r.title ?? r.url ?? '',
        url: r.url ?? '',
        snippet: r.content ?? '',
    })).filter((r) => r.url)
}

async function searchBrave(query: string, maxResults: number, apiKey: string): Promise<WebSearchResult[]> {
    const params = new URLSearchParams({ q: query, count: String(maxResults) })
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Brave HTTP ${res.status}`)
    const data = await res.json() as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
    }
    return (data.web?.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: r.description ?? '',
    })).filter((r) => r.url)
}

async function searchDuckDuckGo(query: string, maxResults: number): Promise<WebSearchResult[]> {
    // DuckDuckGo's HTML endpoint returns a simple result page we can parse with regex.
    // This is a best-effort scraper — if DDG changes its layout it may return fewer results.
    try {
        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) {
            logger.warn({ status: res.status, query: query.slice(0, 60) }, 'DDG returned non-OK status')
            return []
        }
        const html = await res.text()
        const results = parseDuckDuckGoHtml(html, maxResults)
        if (results.length === 0 && html.length > 500) {
            logger.warn({ htmlBytes: html.length }, 'DDG returned bytes but parser found 0 results — possible CAPTCHA or layout change')
        }
        return results
    } catch (err) {
        logger.warn({ err }, 'DDG fetch error')
        return []
    }
}

/** Exported for tests — parses DuckDuckGo HTML result page. */
export function parseDuckDuckGoHtml(html: string, maxResults: number): WebSearchResult[] {
    const results: WebSearchResult[] = []
    // Split on result block boundaries — each result starts with
    // <div class="result results_links...">. Splitting gives us the full
    // content of each result including deeply nested snippets.
    const blocks = html.split(/(?=<div[^>]*class="[^"]*\bresult\s+results_links\b)/)
    for (const block of blocks) {
        if (results.length >= maxResults) break
        // Title + URL: <a class="result__a" href="ENCODED-URL">TITLE</a>
        const aMatch = /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
        if (!aMatch) continue
        const rawHref = decodeEntities(aMatch[1] ?? '')
        const title = stripTags(aMatch[2] ?? '').trim()
        const url = cleanDuckDuckGoHref(rawHref)
        if (!url) continue

        // Snippet: <a class="result__snippet" ...>SNIPPET</a> or <div class="result__snippet">
        const snippetMatch = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)
            ?? /<div[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)
        const snippet = stripTags(snippetMatch?.[1] ?? '').trim()

        results.push({ title, url, snippet })
    }
    return results
}

/** DuckDuckGo wraps result links in a redirect — extract the real URL. */
function cleanDuckDuckGoHref(href: string): string {
    if (!href) return ''
    // Forms:
    //   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
    //   /l/?uddg=...
    //   https://example.com/...
    if (href.startsWith('//')) href = 'https:' + href
    if (href.startsWith('/l/')) href = 'https://duckduckgo.com' + href
    try {
        const u = new URL(href)
        const uddg = u.searchParams.get('uddg')
        if (uddg) return uddg
        return u.toString()
    } catch {
        return href.startsWith('http') ? href : ''
    }
}

// ── HTML utilities ───────────────────────────────────────────────────────────

const ENTITY_MAP: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ndash;': '–',
    '&mdash;': '—',
    '&hellip;': '…',
    '&lsquo;': '‘',
    '&rsquo;': '’',
    '&ldquo;': '“',
    '&rdquo;': '”',
}

export function decodeEntities(s: string): string {
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&[a-zA-Z]+;/g, (m) => ENTITY_MAP[m] ?? m)
}

export function stripTags(html: string): string {
    return decodeEntities(html.replace(/<[^>]*>/g, ''))
}

/** Extract the main readable text from an HTML document. */
export function htmlToText(html: string): string {
    // Strip scripts/styles/noscript/template wholesale
    let s = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
        .replace(/<template[\s\S]*?<\/template>/gi, '')
        .replace(/<svg[\s\S]*?<\/svg>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')

    // Replace block elements with newlines for readability
    s = s.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|main|pre|blockquote)[^>]*>/gi, '\n')

    // Strip remaining tags and decode entities
    s = stripTags(s)

    // Collapse whitespace
    s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    return s
}

// ── Web fetch ────────────────────────────────────────────────────────────────

export interface WebFetchOptions {
    url: string
    method?: 'GET' | 'POST'
    body?: string
    headers?: Record<string, string>
    maxBytes?: number
}

export interface WebFetchResponse {
    status: number
    statusText: string
    body: string
    truncated: boolean
}

export async function webFetch(opts: WebFetchOptions): Promise<WebFetchResponse | { error: string }> {
    const blocked = await isBlockedUrl(opts.url)
    if (blocked) return { error: blocked }

    const maxBytes = opts.maxBytes ?? 50_000
    try {
        const init: RequestInit = {
            method: opts.method ?? 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Plexo-Agent/1.0)',
                'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                ...(opts.headers ?? {}),
            },
            signal: AbortSignal.timeout(30_000),
        }
        if (opts.body && opts.method === 'POST') {
            init.body = opts.body
            ;(init.headers as Record<string, string>)['Content-Type'] ??= 'application/json'
        }
        const res = await fetch(opts.url, init)
        const text = await res.text()
        const truncated = text.length > maxBytes
        return {
            status: res.status,
            statusText: res.statusText,
            body: truncated ? text.slice(0, maxBytes) : text,
            truncated,
        }
    } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
    }
}

// ── Web read page ────────────────────────────────────────────────────────────

export async function webReadPage(url: string): Promise<string> {
    const result = await webFetch({ url, maxBytes: 500_000 })
    if ('error' in result) return `ERROR: ${result.error}`
    if (result.status >= 400) return `ERROR: HTTP ${result.status} ${result.statusText}`

    // Detect content type heuristically
    const body = result.body
    const looksLikeHtml = /<html|<body|<!doctype/i.test(body.slice(0, 500))
    const text = looksLikeHtml ? htmlToText(body) : body

    const max = 30_000
    const out = text.length > max ? text.slice(0, max) + '\n\n[Truncated at 30k chars]' : text
    return out || '[Empty page]'
}

// ── Formatters ───────────────────────────────────────────────────────────────

export function formatSearchResults(resp: WebSearchResponse): string {
    if (resp.results.length === 0) {
        return 'No results found for this query. Try rephrasing with different keywords, or use web_read_page to fetch a specific URL directly if you know the site.'
    }
    const header = `Found ${resp.results.length} result${resp.results.length === 1 ? '' : 's'} via ${resp.provider}:\n`
    const body = resp.results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? '\n   ' + r.snippet.slice(0, 300) : ''}`
    ).join('\n\n')
    return header + '\n' + body
}

// ── AI SDK tool factories ────────────────────────────────────────────────────

export interface WebToolDeps {
    tavilyApiKey?: string | null
    braveApiKey?: string | null
}

/**
 * Build the unified web tool set. Used by both the executor (task path) and
 * workspace-tools (conversational path). Single source of truth.
 */
export function buildWebTools(deps: WebToolDeps = {}) {
    return {
        web_search: tool({
            description:
                'Search the web for current information. Returns real results with titles, URLs, and snippets. '
                + 'Automatically uses the best available provider (Tavily > Brave > DuckDuckGo). '
                + 'Use for factual lookups, current events, documentation URLs, entity research, and any query needing live data.',
            inputSchema: z.object({
                query: z.string().describe('The search query'),
                maxResults: z.number().int().min(1).max(10).optional().default(5).describe('How many results to return (1-10, default 5)'),
            }),
            execute: async ({ query, maxResults }) => {
                const resp = await webSearch({ query, maxResults, tavilyApiKey: deps.tavilyApiKey, braveApiKey: deps.braveApiKey })
                return formatSearchResults(resp)
            },
        }),

        web_fetch: tool({
            description:
                'Fetch a public URL and return the raw response body. Use for downloading JSON APIs, raw files, or when you need the unmodified HTTP response. '
                + 'For readable article/documentation content, prefer web_read_page which strips HTML and returns clean text. '
                + 'Internal/private IPs are blocked.',
            inputSchema: z.object({
                url: z.string().url().describe('The URL to fetch (public only)'),
                method: z.enum(['GET', 'POST']).optional().default('GET').describe('HTTP method'),
                body: z.string().optional().describe('Request body for POST (JSON string)'),
                headers: z.record(z.string()).optional().describe('Additional request headers'),
            }),
            execute: async ({ url, method, body, headers }) => {
                const result = await webFetch({ url, method, body, headers })
                if ('error' in result) return `ERROR: ${result.error}`
                const suffix = result.truncated ? '\n\n[Response truncated at 50k chars]' : ''
                return `HTTP ${result.status} ${result.statusText}\n\n${result.body}${suffix}`
            },
        }),

        web_read_page: tool({
            description:
                'Fetch a web page and extract its main readable text content (HTML stripped, nav/scripts/styles removed). '
                + 'Use this when you need to read an article, blog post, documentation page, or any human-readable web content. '
                + 'Returns clean text, not HTML. Internal/private IPs are blocked.',
            inputSchema: z.object({
                url: z.string().url().describe('The URL of the page to read'),
            }),
            execute: async ({ url }) => webReadPage(url),
        }),
    }
}
