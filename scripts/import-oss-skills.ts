/**
 * scripts/import-oss-skills.ts
 *
 * Imports high-quality skills and tools from open-source repos into the Plexo
 * Hub extension_registry table.
 *
 * Sources:
 *   - addyosmani/agent-skills (MIT)  — 20 skills + 3 agents + 4 checklists
 *   - block/agent-skills     (Apache-2.0) — 7 skills
 *
 * Each entry carries full upstream attribution (sourceAuthor, sourceLicense,
 * sourceRepo, sourceUrl). Idempotent via ON CONFLICT DO UPDATE on the `name`
 * unique key — safe to run multiple times.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm tsx scripts/import-oss-skills.ts
 *
 * The script reads skill markdown files from /tmp/oss-skills-import/{addy,block}
 * (cloned repos). Clone them first:
 *   git clone --depth 1 https://github.com/addyosmani/agent-skills.git /tmp/oss-skills-import/addy
 *   git clone --depth 1 https://github.com/block/agent-skills.git /tmp/oss-skills-import/block
 */

import fs from 'node:fs'
import path from 'node:path'
import { db, sql } from '@plexo/db'
import { extensionRegistry } from '@plexo/db'

// ── Config ───────────────────────────────────────────────────────────────────

const ADDY_ROOT = process.env.ADDY_CLONE_PATH || '/tmp/oss-skills-import/addy'
const BLOCK_ROOT = process.env.BLOCK_CLONE_PATH || '/tmp/oss-skills-import/block'

const ADDY_REPO = 'https://github.com/addyosmani/agent-skills'
const BLOCK_REPO = 'https://github.com/block/agent-skills'

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillEntry {
    name: string                    // scoped: @addyosmani/code-review
    displayName: string
    description: string
    publisher: string
    type: 'skill' | 'tool'
    category: string
    tags: string[]
    readme: string                  // full markdown content
    sourceUrl: string
    sourceAuthor: string
    sourceLicense: string
    sourceRepo: string
    manifest: Record<string, unknown>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(str: string): string {
    return str
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
    if (!raw.startsWith('---\n')) return null
    const end = raw.indexOf('\n---', 4)
    if (end === -1) return null
    const yaml = raw.slice(4, end)
    const body = raw.slice(end + 4).replace(/^\n/, '')
    const meta: Record<string, string> = {}
    let currentKey: string | null = null
    for (const line of yaml.split('\n')) {
        if (!line.trim()) continue
        // Skip YAML list items (tags etc)
        if (line.trim().startsWith('- ')) continue
        const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/)
        if (m) {
            currentKey = m[1]
            let val = m[2].trim()
            if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1)
            if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1)
            meta[currentKey] = val
        } else if (currentKey && line.startsWith('  ') && !line.trim().startsWith('-')) {
            meta[currentKey] = (meta[currentKey] + ' ' + line.trim()).trim()
        }
    }
    return { meta, body }
}

function buildSkillMd(
    title: string,
    body: string,
    sourceUrl: string,
    author: string,
    license: string,
    repo: string,
): string {
    return [
        `# ${title}`,
        '',
        body.trim(),
        '',
        '---',
        '',
        `*Imported from [${repo}](${repo}) by ${author}. Licensed under ${license}. Source: [${sourceUrl}](${sourceUrl})*`,
        '',
    ].join('\n')
}

// ── Category mapping ─────────────────────────────────────────────────────────

/** Explicit slug -> Hub category overrides. Heuristic matching is fragile
 *  (e.g. "api-and-interface-design" contains "design" but is a code skill),
 *  so we pin every known slug here. Unknown slugs fall back to 'development'. */
const CATEGORY_OVERRIDES: Record<string, string> = {
    'api-and-interface-design': 'code',
    'ci-cd-and-automation': 'devops',
    'debugging-and-error-recovery': 'code',
    'code-reviewer': 'code',
    'code-review-and-quality': 'code',
    'code-simplification': 'code',
    'deprecation-and-migration': 'code',
    'incremental-implementation': 'code',
    'source-driven-development': 'code',
    'spec-driven-development': 'code',
    'performance-optimization': 'code',
    'performance-checklist': 'code',
    'security-and-hardening': 'security',
    'security-auditor': 'security',
    'security-checklist': 'security',
    'test-driven-development': 'testing',
    'test-engineer': 'testing',
    'testing-patterns': 'testing',
    'browser-testing-with-devtools': 'testing',
    'testing-strategy': 'testing',
    'frontend-ui-engineering': 'design',
    'frontend-design': 'design',
    'accessibility-checklist': 'design',
    'git-workflow-and-versioning': 'devops',
    'shipping-and-launch': 'devops',
    'documentation-and-adrs': 'productivity',
    'context-engineering': 'productivity',
    'idea-refine': 'productivity',
    'planning-and-task-breakdown': 'productivity',
    'using-agent-skills': 'productivity',
    'api-setup': 'code',
    'beads': 'productivity',
    'code-review': 'code',
    'goose-blog-post': 'marketing',
    'rp-why': 'productivity',
}

function inferCategory(slug: string): string {
    return CATEGORY_OVERRIDES[slug] || 'development'
}

/** Classify: workflow/process/checklist = 'skill', action/capability = 'tool' */
function inferType(slug: string, source: 'skill' | 'agent' | 'reference'): 'skill' | 'tool' {
    if (source === 'agent') return 'skill'          // agents are persona-driven workflows
    if (source === 'reference') return 'skill'       // checklists are reference skills
    // Skills from addy/block are process-oriented workflows
    return 'skill'
}

// ── Parse addyosmani/agent-skills ────────────────────────────────────────────

function parseAddySkills(): SkillEntry[] {
    const entries: SkillEntry[] = []
    const author = 'addyosmani'
    const license = 'MIT'
    const repo = ADDY_REPO

    // 1) skills/*/SKILL.md — the 20 engineering workflows
    const skillsDir = path.join(ADDY_ROOT, 'skills')
    if (fs.existsSync(skillsDir)) {
        for (const dir of fs.readdirSync(skillsDir, { withFileTypes: true })) {
            if (!dir.isDirectory()) continue
            const skillFile = path.join(skillsDir, dir.name, 'SKILL.md')
            if (!fs.existsSync(skillFile)) continue

            const raw = fs.readFileSync(skillFile, 'utf8')
            const parsed = parseFrontmatter(raw)
            if (!parsed) continue

            const slug = slugify(parsed.meta.name || dir.name)
            const displayName = parsed.meta.name || dir.name.replace(/-/g, ' ')
            const description = (parsed.meta.description || '').replace(/\n/g, ' ').trim()
            if (!description) continue

            const sourceUrl = `${ADDY_REPO}/blob/main/skills/${dir.name}/SKILL.md`
            const category = inferCategory(slug)
            const type = inferType(slug, 'skill')
            const skillMd = buildSkillMd(displayName, parsed.body, sourceUrl, author, license, repo)

            entries.push({
                name: `@addyosmani/${slug}`,
                displayName: toTitleCase(displayName),
                description,
                publisher: author,
                type,
                category,
                tags: ['addyosmani', 'agent-skills', category, 'imported'],
                readme: skillMd,
                sourceUrl,
                sourceAuthor: author,
                sourceLicense: license,
                sourceRepo: repo,
                manifest: {
                    name: `@addyosmani/${slug}`,
                    version: '1.0.0',
                    displayName: toTitleCase(displayName),
                    description,
                    type,
                    runtime: 'skill',
                    entry: 'skill://',
                    author,
                    license,
                    source: sourceUrl,
                    category,
                    tags: ['addyosmani', 'agent-skills', category],
                    skill: skillMd,
                },
            })
        }
    }

    // 2) agents/*.md — 3 personas (code-reviewer, security-auditor, test-engineer)
    const agentsDir = path.join(ADDY_ROOT, 'agents')
    if (fs.existsSync(agentsDir)) {
        for (const file of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
            const filePath = path.join(agentsDir, file)
            const raw = fs.readFileSync(filePath, 'utf8')
            const parsed = parseFrontmatter(raw)
            if (!parsed) continue

            const slug = slugify(parsed.meta.name || file.replace('.md', ''))
            const displayName = parsed.meta.name || file.replace('.md', '').replace(/-/g, ' ')
            const description = (parsed.meta.description || '').replace(/\n/g, ' ').trim()
            if (!description) continue

            const sourceUrl = `${ADDY_REPO}/blob/main/agents/${file}`
            const category = inferCategory(slug)
            const type = inferType(slug, 'agent')
            const skillMd = buildSkillMd(displayName, parsed.body, sourceUrl, author, license, repo)

            entries.push({
                name: `@addyosmani/${slug}`,
                displayName: toTitleCase(displayName),
                description,
                publisher: author,
                type,
                category,
                tags: ['addyosmani', 'agent-skills', 'agent', category, 'imported'],
                readme: skillMd,
                sourceUrl,
                sourceAuthor: author,
                sourceLicense: license,
                sourceRepo: repo,
                manifest: {
                    name: `@addyosmani/${slug}`,
                    version: '1.0.0',
                    displayName: toTitleCase(displayName),
                    description,
                    type: 'agent',
                    runtime: 'skill',
                    entry: 'skill://',
                    author,
                    license,
                    source: sourceUrl,
                    category,
                    tags: ['addyosmani', 'agent-skills', 'agent', category],
                    skill: skillMd,
                },
            })
        }
    }

    // 3) references/*.md — 4 checklists (no frontmatter, derive from filename)
    const refsDir = path.join(ADDY_ROOT, 'references')
    if (fs.existsSync(refsDir)) {
        for (const file of fs.readdirSync(refsDir).filter(f => f.endsWith('.md'))) {
            const filePath = path.join(refsDir, file)
            const raw = fs.readFileSync(filePath, 'utf8')
            const slug = slugify(file.replace('.md', ''))
            const displayName = file.replace('.md', '').replace(/-/g, ' ')

            // Try frontmatter first, fall back to first heading + first paragraph
            const parsed = parseFrontmatter(raw)
            let description: string
            let body: string
            if (parsed && parsed.meta.description) {
                description = parsed.meta.description.replace(/\n/g, ' ').trim()
                body = parsed.body
            } else {
                body = raw
                // Extract description from first paragraph
                const lines = raw.split('\n').filter(l => l.trim() && !l.startsWith('#'))
                description = lines[0]?.trim().slice(0, 200) || `${displayName} reference checklist`
            }

            const sourceUrl = `${ADDY_REPO}/blob/main/references/${file}`
            const category = inferCategory(slug)
            const type = inferType(slug, 'reference')
            const skillMd = buildSkillMd(displayName, body, sourceUrl, author, license, repo)

            entries.push({
                name: `@addyosmani/${slug}`,
                displayName: toTitleCase(displayName),
                description,
                publisher: author,
                type,
                category,
                tags: ['addyosmani', 'agent-skills', 'reference', 'checklist', category, 'imported'],
                readme: skillMd,
                sourceUrl,
                sourceAuthor: author,
                sourceLicense: license,
                sourceRepo: repo,
                manifest: {
                    name: `@addyosmani/${slug}`,
                    version: '1.0.0',
                    displayName: toTitleCase(displayName),
                    description,
                    type,
                    runtime: 'skill',
                    entry: 'skill://',
                    author,
                    license,
                    source: sourceUrl,
                    category,
                    tags: ['addyosmani', 'agent-skills', 'reference', 'checklist', category],
                    skill: skillMd,
                },
            })
        }
    }

    return entries
}

// ── Parse block/agent-skills ─────────────────────────────────────────────────

function parseBlockSkills(): SkillEntry[] {
    const entries: SkillEntry[] = []
    const publisher = 'block'
    const license = 'Apache-2.0'
    const repo = BLOCK_REPO

    // Each top-level dir with a SKILL.md (skip .github, scripts, etc)
    const skipDirs = new Set(['.git', '.github', 'scripts', 'node_modules'])

    for (const dir of fs.readdirSync(BLOCK_ROOT, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        if (skipDirs.has(dir.name)) continue
        const skillFile = path.join(BLOCK_ROOT, dir.name, 'SKILL.md')
        if (!fs.existsSync(skillFile)) continue

        const raw = fs.readFileSync(skillFile, 'utf8')
        const parsed = parseFrontmatter(raw)
        if (!parsed) continue

        const slug = slugify(parsed.meta.name || dir.name)
        const displayName = parsed.meta.name || dir.name.replace(/-/g, ' ')
        const description = (parsed.meta.description || '').replace(/\n/g, ' ').trim()
        if (!description) continue

        const skillAuthor = parsed.meta.author || 'block'
        const sourceUrl = `${BLOCK_REPO}/blob/main/${dir.name}/SKILL.md`
        const category = inferCategory(slug)
        const type = inferType(slug, 'skill')
        const skillMd = buildSkillMd(displayName, parsed.body, sourceUrl, `${skillAuthor} (Block, Inc.)`, license, repo)

        entries.push({
            name: `@block/${slug}`,
            displayName: toTitleCase(displayName),
            description,
            publisher,
            type,
            category,
            tags: ['block', 'goose', 'agent-skills', category, 'imported'],
            readme: skillMd,
            sourceUrl,
            sourceAuthor: `${skillAuthor} (Block, Inc.)`,
            sourceLicense: license,
            sourceRepo: repo,
            manifest: {
                name: `@block/${slug}`,
                version: parsed.meta.version || '1.0.0',
                displayName: toTitleCase(displayName),
                description,
                type,
                runtime: 'skill',
                entry: 'skill://',
                author: `${skillAuthor} (Block, Inc.)`,
                license,
                source: sourceUrl,
                category,
                tags: ['block', 'goose', 'agent-skills', category],
                skill: skillMd,
            },
        })
    }

    return entries
}

// ── Util ─────────────────────────────────────────────────────────────────────

function toTitleCase(str: string): string {
    return str
        .split(/[-\s]+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ')
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // Validate clones exist
    if (!fs.existsSync(ADDY_ROOT)) {
        console.error(`addyosmani clone not found at ${ADDY_ROOT}`)
        console.error('Run: git clone --depth 1 https://github.com/addyosmani/agent-skills.git ' + ADDY_ROOT)
        process.exit(1)
    }
    if (!fs.existsSync(BLOCK_ROOT)) {
        console.error(`block clone not found at ${BLOCK_ROOT}`)
        console.error('Run: git clone --depth 1 https://github.com/block/agent-skills.git ' + BLOCK_ROOT)
        process.exit(1)
    }

    const addyEntries = parseAddySkills()
    const blockEntries = parseBlockSkills()
    const allEntries = [...addyEntries, ...blockEntries]

    console.log(`Parsed ${addyEntries.length} entries from addyosmani/agent-skills`)
    console.log(`Parsed ${blockEntries.length} entries from block/agent-skills`)
    console.log(`Total: ${allEntries.length} entries to upsert\n`)

    let inserted = 0
    let updated = 0
    let failed = 0

    for (const entry of allEntries) {
        try {
            const result = await db
                .insert(extensionRegistry)
                .values({
                    name: entry.name,
                    displayName: entry.displayName,
                    description: entry.description,
                    publisher: entry.publisher,
                    latestVersion: '1.0.0',
                    versions: ['1.0.0'],
                    manifest: entry.manifest,
                    tags: entry.tags,
                    category: entry.category,
                    readme: entry.readme,
                    repositoryUrl: entry.sourceRepo,
                    sourceUrl: entry.sourceUrl,
                    sourceAuthor: entry.sourceAuthor,
                    sourceLicense: entry.sourceLicense,
                    sourceRepo: entry.sourceRepo,
                })
                .onConflictDoUpdate({
                    target: extensionRegistry.name,
                    set: {
                        displayName: entry.displayName,
                        description: entry.description,
                        publisher: entry.publisher,
                        latestVersion: '1.0.0',
                        versions: ['1.0.0'],
                        manifest: entry.manifest,
                        tags: entry.tags,
                        category: entry.category,
                        readme: entry.readme,
                        repositoryUrl: entry.sourceRepo,
                        sourceUrl: entry.sourceUrl,
                        sourceAuthor: entry.sourceAuthor,
                        sourceLicense: entry.sourceLicense,
                        sourceRepo: entry.sourceRepo,
                        updatedAt: new Date(),
                    },
                })
                .returning({
                    name: extensionRegistry.name,
                    publishedAt: extensionRegistry.publishedAt,
                    updatedAt: extensionRegistry.updatedAt,
                })

            const rec = result[0]
            if (rec && rec.publishedAt && rec.updatedAt && rec.publishedAt.getTime() === rec.updatedAt.getTime()) {
                inserted++
                console.log(`  + ${entry.name}`)
            } else {
                updated++
                console.log(`  ~ ${entry.name}`)
            }
        } catch (err) {
            failed++
            console.error(`  FAIL ${entry.name}: ${(err as Error).message}`)
        }
    }

    console.log('\n=== Import complete ===')
    console.log(`  Inserted: ${inserted}`)
    console.log(`  Updated:  ${updated}`)
    console.log(`  Failed:   ${failed}`)

    // Verification
    const countAddy = await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM extension_registry WHERE name LIKE '@addyosmani/%'`,
    )
    const countBlock = await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM extension_registry WHERE name LIKE '@block/%'`,
    )
    const nAddy = (countAddy as unknown as { n: number }[])[0]?.n ?? (countAddy as any).rows?.[0]?.n
    const nBlock = (countBlock as unknown as { n: number }[])[0]?.n ?? (countBlock as any).rows?.[0]?.n
    console.log(`  @addyosmani/* rows in DB: ${nAddy}`)
    console.log(`  @block/* rows in DB: ${nBlock}`)

    const total = await db.execute(
        sql`SELECT COUNT(*)::int AS n FROM extension_registry`,
    )
    const nTotal = (total as unknown as { n: number }[])[0]?.n ?? (total as any).rows?.[0]?.n
    console.log(`  Total extension_registry rows: ${nTotal}`)

    process.exit(failed === 0 ? 0 : 2)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
