/**
 * GitHub API client — thin wrapper around Octokit with just what the sprint
 * engine needs. Avoids pulling all of @octokit/rest; uses fetch directly.
 *
 * Operations:
 * - List branches
 * - Create branch from base
 * - Get file contents (for conflict detection scope analysis)
 * - Create / update PR
 * - Get pull request status (CI checks)
 * - Merge PR (squash)
 *
 * Auth: PAT stored in installed_connections (encrypted) or GITHUB_TOKEN env.
 */

export interface GitHubClientOptions {
    owner: string
    repo: string
    token: string
}

export interface Branch {
    name: string
    sha: string
}

export interface PullRequest {
    number: number
    html_url: string
    title: string
    state: string
    merged: boolean
    head: { sha: string; ref: string }
    base: { ref: string }
}

export interface CheckRun {
    id: number
    name: string
    status: 'queued' | 'in_progress' | 'completed'
    conclusion: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | null
    html_url: string
}

export interface RepoFile {
    name: string
    path: string
    sha: string
    type: 'file' | 'dir' | 'symlink'
}

type GitHubMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export class GitHubClient {
    private readonly base = 'https://api.github.com'
    private readonly owner: string
    private readonly repo: string
    private readonly headers: Record<string, string>

    constructor(opts: GitHubClientOptions) {
        this.owner = opts.owner
        this.repo = opts.repo
        this.headers = {
            Authorization: `Bearer ${opts.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'Plexo-Sprint-Engine/1.0',
        }
    }

    private async call<T>(method: GitHubMethod, path: string, body?: unknown): Promise<T> {
        const res = await fetch(`${this.base}${path}`, {
            method,
            headers: this.headers,
            body: body ? JSON.stringify(body) : undefined,
        })

        if (!res.ok) {
            const text = await res.text()
            throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
        }

        if (res.status === 204) return undefined as T
        return res.json() as Promise<T>
    }

    // ── Repository info ─────────────────────────────────────────────────────────

    async getDefaultBranch(): Promise<string> {
        const repo = await this.call<{ default_branch: string }>('GET', `/repos/${this.owner}/${this.repo}`)
        return repo.default_branch
    }

    // ── Branches ────────────────────────────────────────────────────────────────

    async getBranch(branch: string): Promise<Branch> {
        const data = await this.call<{ name: string; commit: { sha: string } }>(
            'GET', `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(branch)}`,
        )
        return { name: data.name, sha: data.commit.sha }
    }

    async createBranch(newBranch: string, fromSha: string): Promise<void> {
        await this.call('POST', `/repos/${this.owner}/${this.repo}/git/refs`, {
            ref: `refs/heads/${newBranch}`,
            sha: fromSha,
        })
    }

    async deleteBranch(branch: string): Promise<void> {
        await this.call('DELETE', `/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(branch)}`)
    }

    // ── File tree (for conflict detection) ──────────────────────────────────────

    async listFiles(path = '', ref?: string): Promise<RepoFile[]> {
        const qs = ref ? `?ref=${encodeURIComponent(ref)}` : ''
        const items = await this.call<RepoFile[]>(
            'GET', `/repos/${this.owner}/${this.repo}/contents/${path}${qs}`,
        )
        return Array.isArray(items) ? items : []
    }

    /** Read a file's decoded text content at a given ref. Returns null if not found. */
    async getFileContent(path: string, ref = 'main'): Promise<string | null> {
        try {
            const data = await this.call<{ content?: string; encoding?: string; message?: string }>(
                'GET', `/repos/${this.owner}/${this.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
            )
            if (data.message) return null  // 404 or access error
            if (data.content && data.encoding === 'base64') {
                return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
            }
            return null
        } catch {
            return null
        }
    }

    // ── Pull Requests ────────────────────────────────────────────────────────────

    async createPR(opts: {
        title: string
        body: string
        head: string
        base: string
        draft?: boolean
    }): Promise<PullRequest> {
        return this.call<PullRequest>('POST', `/repos/${this.owner}/${this.repo}/pulls`, {
            title: opts.title,
            body: opts.body,
            head: opts.head,
            base: opts.base,
            draft: opts.draft ?? false,
        })
    }

    async getPR(prNumber: number): Promise<PullRequest> {
        return this.call<PullRequest>('GET', `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`)
    }

    async updatePR(prNumber: number, updates: Partial<{ title: string; body: string; state: string }>): Promise<PullRequest> {
        return this.call<PullRequest>('PATCH', `/repos/${this.owner}/${this.repo}/pulls/${prNumber}`, updates)
    }

    async mergePR(prNumber: number, commitMessage: string): Promise<void> {
        await this.call('PUT', `/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
            merge_method: 'squash',
            commit_message: commitMessage,
        })
    }

    // ── CI status ───────────────────────────────────────────────────────────────

    async getCheckRuns(ref: string): Promise<CheckRun[]> {
        const data = await this.call<{ check_runs: CheckRun[] }>(
            'GET', `/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(ref)}/check-runs`,
        )
        return data.check_runs
    }

    async waitForCI(
        ref: string,
        opts = { pollIntervalMs: 15_000, timeoutMs: 15 * 60 * 1000 },
    ): Promise<'pass' | 'fail' | 'timeout'> {
        const deadline = Date.now() + opts.timeoutMs
        while (Date.now() < deadline) {
            const checks = await this.getCheckRuns(ref)
            if (checks.length === 0) {
                await new Promise((r) => setTimeout(r, opts.pollIntervalMs))
                continue
            }
            const allDone = checks.every((c) => c.status === 'completed')
            if (allDone) {
                const anyFailed = checks.some((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out')
                return anyFailed ? 'fail' : 'pass'
            }
            await new Promise((r) => setTimeout(r, opts.pollIntervalMs))
        }
        return 'timeout'
    }

    // ── Compare (for conflict detection) ────────────────────────────────────────

    async compare(base: string, head: string): Promise<{ files: { filename: string }[] }> {
        return this.call<{ files: { filename: string }[] }>(
            'GET', `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        )
    }

    /** Returns true if head branch has commits that base does not. Safe to use before createPR. */
    async hasCommitsAhead(base: string, head: string): Promise<boolean> {
        try {
            const result = await this.call<{ ahead_by: number }>(
                'GET', `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
            )
            return (result.ahead_by ?? 0) > 0
        } catch {
            return false
        }
    }
}

// ── Factory (resolved token from installed_connections or env fallback) ──────
// Preferred: PAT stored via the Connections UI (encrypted in DB).
// Fallback: GITHUB_TOKEN env var (for environments where it's set directly).

export async function resolveGitHubToken(workspaceId?: string): Promise<string> {
    // 1. Try installed_connections for the given workspace
    if (workspaceId) {
        try {
            const { db, eq, and } = await import('@plexo/db')
            const { installedConnections } = await import('@plexo/db')
            const { decrypt } = await import('../connections/crypto-util.js')

            const [row] = await db
                .select({ credentials: installedConnections.credentials })
                .from(installedConnections)
                .where(and(
                    eq(installedConnections.workspaceId, workspaceId),
                    eq(installedConnections.registryId, 'github'),
                    eq(installedConnections.status, 'active'),
                ))
                .limit(1)

            if (row?.credentials) {
                const raw = row.credentials as { encrypted?: string }
                if (raw.encrypted) {
                    const decrypted = decrypt(raw.encrypted, workspaceId)
                    const creds = JSON.parse(decrypted) as Record<string, string>
                    const token = creds.access_token ?? creds.token ?? Object.values(creds).find(Boolean)
                    if (token) return token
                }
            }
        } catch {
            // Fall through to env var
        }
    }

    // 2. Env var fallback
    const token = process.env.GITHUB_TOKEN
    if (token) return token

    throw new Error('No GitHub token available — install GitHub connection in the workspace or set GITHUB_TOKEN env var')
}

/** Synchronous factory for contexts that already have a token (e.g. env-only scenarios). */
export function buildGitHubClient(owner: string, repo: string, token?: string): GitHubClient {
    const resolved = token ?? process.env.GITHUB_TOKEN
    if (!resolved) throw new Error('GITHUB_TOKEN not set — GitHub integration unavailable')
    return new GitHubClient({ owner, repo, token: resolved })
}

/** Async factory — resolves token from workspace connection first, env fallback second. */
export async function buildGitHubClientForWorkspace(owner: string, repo: string, workspaceId: string): Promise<GitHubClient> {
    const token = await resolveGitHubToken(workspaceId)
    return new GitHubClient({ owner, repo, token })
}
