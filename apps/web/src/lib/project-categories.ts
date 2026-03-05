/**
 * Project category definitions — single source of truth for all
 * category-specific labels, icons, and field schemas used throughout the UI.
 *
 * Internally, everything is stored as a "sprint" in the DB. This module
 * maps category → industry-appropriate terminology so users see language
 * that fits their domain.
 */

export type ProjectCategory =
    | 'code'
    | 'research'
    | 'writing'
    | 'ops'
    | 'data'
    | 'marketing'
    | 'general'

export interface CategoryDef {
    /** Machine key stored in DB */
    id: ProjectCategory
    /** Display label for this category */
    label: string
    /** Short description shown in the picker */
    description: string
    /** Lucide icon name */
    icon: string
    /** Tailwind gradient for card accent */
    accent: string
    /** Word used for a single unit of work */
    unitSingular: string
    /** Plural units */
    unitPlural: string
    /** Word for the execution run */
    runLabel: string
    /** What the final output is called */
    outputLabel: string
    /** Label for the "request" field */
    requestLabel: string
    /** Placeholder text for the request field */
    requestPlaceholder: string
    /** Explainer steps shown below the form */
    howItWorks: string[]
    /** Whether this category requires a GitHub repo */
    requiresRepo: boolean
    /** Category-specific extra fields (rendered dynamically) */
    extraFields: CategoryField[]
}

export interface CategoryField {
    key: string
    label: string
    type: 'text' | 'select' | 'textarea' | 'url-list'
    placeholder?: string
    hint?: string
    options?: { value: string; label: string }[]
    required?: boolean
}

export const CATEGORIES: CategoryDef[] = [
    {
        id: 'code',
        label: 'Code',
        description: 'Build, fix, or refactor a codebase',
        icon: 'Code2',
        accent: 'from-indigo-500 to-violet-600',
        unitSingular: 'Task',
        unitPlural: 'Tasks',
        runLabel: 'Run',
        outputLabel: 'Pull Request',
        requestLabel: 'What do you want built or fixed?',
        requestPlaceholder:
            'Add rate limiting to all public API routes, implement request deduplication, and add OpenTelemetry tracing to the auth service…',
        howItWorks: [
            'Plexo analyzes your goal and the repository structure',
            'Breaks it into parallel tasks that run simultaneously',
            'Each task runs in isolation, then results are combined',
            'Draft pull requests are opened; conflicts flagged for review',
        ],
        requiresRepo: true,
        extraFields: [
            {
                key: 'repo',
                label: 'GitHub Repository',
                type: 'text',
                placeholder: 'owner/repo',
                hint: 'Must match a GitHub repository you have access to.',
                required: true,
            },
        ],
    },
    {
        id: 'research',
        label: 'Research',
        description: 'Investigate a topic and synthesize findings',
        icon: 'Search',
        accent: 'from-cyan-500 to-blue-600',
        unitSingular: 'Finding',
        unitPlural: 'Findings',
        runLabel: 'Analysis',
        outputLabel: 'Report',
        requestLabel: 'What do you need researched?',
        requestPlaceholder:
            'Analyze the competitive landscape for AI coding assistants, focusing on pricing models, feature differentiation, and target markets…',
        howItWorks: [
            'Plexo breaks the topic into parallel research threads',
            'Each thread investigates independently',
            'Findings are cross-referenced and synthesized',
            'A structured report is produced with citations',
        ],
        requiresRepo: false,
        extraFields: [
            {
                key: 'scope',
                label: 'Scope constraints (optional)',
                type: 'textarea',
                placeholder: 'Limit to peer-reviewed sources, focus on 2023–2025, exclude X…',
                hint: 'Optional. Specify domains, date ranges, or source restrictions.',
            },
            {
                key: 'outputFormat',
                label: 'Output format',
                type: 'select',
                options: [
                    { value: 'report', label: 'Structured report' },
                    { value: 'summary', label: 'Executive summary' },
                    { value: 'bullets', label: 'Bullet points' },
                    { value: 'comparison', label: 'Comparison table' },
                ],
            },
        ],
    },
    {
        id: 'writing',
        label: 'Writing',
        description: 'Draft, edit, or generate written content',
        icon: 'PenLine',
        accent: 'from-emerald-500 to-teal-600',
        unitSingular: 'Draft',
        unitPlural: 'Drafts',
        runLabel: 'Pass',
        outputLabel: 'Document',
        requestLabel: 'What do you need written?',
        requestPlaceholder:
            'Write a technical blog post explaining how our new vector search API works, aimed at developers with no ML background…',
        howItWorks: [
            'Plexo analyzes your brief and audience',
            'Parallel drafts are generated for each section',
            'Drafts are refined and assembled',
            'A polished document is produced for your review',
        ],
        requiresRepo: false,
        extraFields: [
            {
                key: 'tone',
                label: 'Tone',
                type: 'select',
                options: [
                    { value: 'professional', label: 'Professional' },
                    { value: 'conversational', label: 'Conversational' },
                    { value: 'technical', label: 'Technical' },
                    { value: 'persuasive', label: 'Persuasive' },
                    { value: 'educational', label: 'Educational' },
                ],
            },
            {
                key: 'lengthHint',
                label: 'Length',
                type: 'select',
                options: [
                    { value: 'short', label: 'Short (< 500 words)' },
                    { value: 'medium', label: 'Medium (500–2000 words)' },
                    { value: 'long', label: 'Long (2000+ words)' },
                ],
            },
            {
                key: 'references',
                label: 'Reference URLs (optional)',
                type: 'url-list',
                placeholder: 'https://example.com/source',
                hint: 'One URL per line. Plexo will read these as source material.',
            },
        ],
    },
    {
        id: 'ops',
        label: 'Ops',
        description: 'Infrastructure, deployment, and operational tasks',
        icon: 'Server',
        accent: 'from-amber-500 to-orange-600',
        unitSingular: 'Action',
        unitPlural: 'Actions',
        runLabel: 'Execution',
        outputLabel: 'Runbook',
        requestLabel: 'What operation needs to be carried out?',
        requestPlaceholder:
            'Audit all production servers for unpatched CVEs from the last 90 days and produce a remediation plan ordered by severity…',
        howItWorks: [
            'Plexo decomposes the operation into parallel actions',
            'Each action executes against the target system',
            'Results are verified and cross-checked',
            'A runbook with outcomes is produced for your records',
        ],
        requiresRepo: false,
        extraFields: [
            {
                key: 'target',
                label: 'Target system or service (optional)',
                type: 'text',
                placeholder: 'production-api, k8s-cluster-eu, AWS account 123…',
                hint: 'Describe the system this operation targets.',
            },
            {
                key: 'urgency',
                label: 'Urgency',
                type: 'select',
                options: [
                    { value: 'normal', label: 'Normal' },
                    { value: 'high', label: 'High — expedite' },
                    { value: 'critical', label: 'Critical — drop everything' },
                ],
            },
        ],
    },
    {
        id: 'data',
        label: 'Data',
        description: 'Query, transform, or analyze datasets',
        icon: 'BarChart2',
        accent: 'from-violet-500 to-purple-600',
        unitSingular: 'Query',
        unitPlural: 'Queries',
        runLabel: 'Pipeline',
        outputLabel: 'Dataset',
        requestLabel: 'What do you need from your data?',
        requestPlaceholder:
            'Identify all users who converted from free to paid in Q1 2025, segment by acquisition channel, and compute 30-day LTV by segment…',
        howItWorks: [
            'Plexo breaks the analysis into parallel query threads',
            'Each thread runs independently against the data',
            'Results are joined and validated',
            'A clean dataset or report is delivered',
        ],
        requiresRepo: false,
        extraFields: [
            {
                key: 'dataSource',
                label: 'Data source (optional)',
                type: 'text',
                placeholder: 'PostgreSQL prod DB, BigQuery project-id.dataset, S3 bucket…',
                hint: 'Describe where your data lives.',
            },
            {
                key: 'outputFormat',
                label: 'Output format',
                type: 'select',
                options: [
                    { value: 'csv', label: 'CSV' },
                    { value: 'json', label: 'JSON' },
                    { value: 'report', label: 'Narrative report' },
                    { value: 'chart', label: 'Chart + summary' },
                ],
            },
        ],
    },
    {
        id: 'marketing',
        label: 'Marketing',
        description: 'Campaigns, copy, and go-to-market assets',
        icon: 'Megaphone',
        accent: 'from-pink-500 to-rose-600',
        unitSingular: 'Asset',
        unitPlural: 'Assets',
        runLabel: 'Launch',
        outputLabel: 'Brief',
        requestLabel: 'What do you need created or planned?',
        requestPlaceholder:
            'Plan a product launch campaign for our new developer API tier — include social copy, a launch email sequence, and a blog post outline…',
        howItWorks: [
            'Plexo breaks the campaign into parallel asset tracks',
            'Each track produces its content independently',
            'Assets are reviewed for consistency and brand fit',
            'A complete campaign brief is delivered',
        ],
        requiresRepo: false,
        extraFields: [
            {
                key: 'audience',
                label: 'Target audience (optional)',
                type: 'text',
                placeholder: 'B2B SaaS developers, enterprise CTOs, SMB owners…',
                hint: 'Who are you trying to reach?',
            },
            {
                key: 'channels',
                label: 'Channels',
                type: 'select',
                options: [
                    { value: 'all', label: 'All channels' },
                    { value: 'social', label: 'Social media' },
                    { value: 'email', label: 'Email' },
                    { value: 'content', label: 'Content / SEO' },
                    { value: 'paid', label: 'Paid media' },
                ],
            },
        ],
    },
    {
        id: 'general',
        label: 'General',
        description: 'Anything else — describe what you need',
        icon: 'Sparkles',
        accent: 'from-zinc-500 to-zinc-600',
        unitSingular: 'Task',
        unitPlural: 'Tasks',
        runLabel: 'Run',
        outputLabel: 'Summary',
        requestLabel: 'What do you need done?',
        requestPlaceholder:
            'Describe your goal in as much detail as possible. Plexo will figure out the best way to break it into parallel work…',
        howItWorks: [
            'Plexo analyzes your goal',
            'Breaks it into parallel tasks that run simultaneously',
            'Each task runs in isolation, results combined',
            'A summary of outcomes is delivered',
        ],
        requiresRepo: false,
        extraFields: [],
    },
]

export function getCategoryDef(id: string): CategoryDef {
    return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES.find((c) => c.id === 'general')!
}

/** Category-specific planner system prompt prefix */
export function categoryPlannerPrompt(category: string): string {
    const def = getCategoryDef(category)
    const prompts: Record<ProjectCategory, string> = {
        code: `You are a sprint planning system for software development. Given a repository and a feature/change request, decompose the work into independent coding tasks that can be executed in parallel by separate AI agents.

Rules:
- Each task MUST be independently executable without knowledge of the others
- Each task has a "scope" — list of file paths or directories it will touch
- Minimize scope overlap between parallel tasks (overlaps = conflicts)
- Each task needs an acceptance criterion that can be verified programmatically
- Tasks that share scope must be marked as dependencies in depends_on
- Branch names use the format: sprint/{sprintId}/{short-slug}
- Maximum 8 tasks per sprint`,

        research: `You are a research planning system. Given a research topic and optional scope constraints, decompose the investigation into independent research threads that can be explored in parallel.

Rules:
- Each thread MUST be independently researchable without knowledge of the others
- Each thread has a "scope" — the specific sub-topic or question it addresses
- Threads should be designed so findings can be synthesized into a unified report
- Each thread needs a clear deliverable (finding, data point, analysis)
- Use "branch" field for finding ID (e.g., "finding/introduction", "finding/competitive-analysis")
- Maximum 8 threads per study`,

        writing: `You are a content planning system. Given a writing brief, decompose the content into independent sections or drafts that can be written in parallel by separate AI agents.

Rules:
- Each section MUST be independently writable without knowledge of the others' draft content
- Each section has a "scope" — what it covers (outline, introduction, section name, conclusion)
- Sections should be ordered logically so they can be assembled into a coherent document
- Each section needs a clear word count target and key points to cover
- Use "branch" field for section ID (e.g., "draft/introduction", "draft/section-1")
- Maximum 8 sections per document`,

        ops: `You are an operations planning system. Given an operational goal, decompose the work into independent actions that can be executed in parallel by separate AI agents.

Rules:
- Each action MUST be independently executable without knowledge of the others
- Each action has a "scope" — the specific system, service, or resource it touches
- Scope overlap between parallel actions is a risk — flag dependencies clearly
- Each action needs a clear verification criterion
- Use "branch" field for action ID (e.g., "action/audit-servers", "action/patch-cves")
- Maximum 8 actions per operation`,

        data: `You are a data analysis planning system. Given a data analysis goal, decompose it into independent query or transformation threads that can run in parallel.

Rules:
- Each thread MUST be independently queryable without knowledge of the others
- Each thread has a "scope" — the specific table, dataset, or metric it covers
- Threads should produce outputs that can be joined into a final result
- Each thread needs a clear output format and validation criterion
- Use "branch" field for query ID (e.g., "query/user-segments", "query/ltv-calculation")
- Maximum 8 threads per pipeline`,

        marketing: `You are a marketing campaign planning system. Given a campaign goal, decompose it into independent asset tracks that can be produced in parallel.

Rules:
- Each track MUST be independently produceable without knowledge of the others
- Each track has a "scope" — the specific channel, format, or asset type it covers
- Tracks should produce assets that form a coherent campaign when assembled
- Each track needs a clear deliverable and success metric
- Use "branch" field for asset ID (e.g., "asset/email-sequence", "asset/social-copy")
- Maximum 8 tracks per campaign`,

        general: `You are a general-purpose task planning system. Given a goal, decompose it into independent tasks that can be executed in parallel by separate AI agents.

Rules:
- Each task MUST be independently executable without knowledge of the others
- Each task has a "scope" — what it covers or what resources it uses
- Minimize dependencies between parallel tasks
- Each task needs a clear acceptance criterion
- Use "branch" field for task ID (e.g., "task/research", "task/draft")
- Maximum 8 tasks per project`,
    }
    return prompts[category as ProjectCategory] ?? prompts.general
}
