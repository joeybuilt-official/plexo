/**
 * Environment Validation — fail-fast at startup
 *
 * Called before any network binding or DB connection.
 * Exits the process with code 1 on missing required vars,
 * with a clear message listing exactly what's missing.
 *
 * Required vs. optional:
 *   Required  — process won't function at all without these
 *   Optional  — features degrade gracefully (AI providers, OAuth)
 *   Warned    — wrong format but not fatal
 */

interface EnvVar {
    key: string
    description: string
    /** If true, process exits if missing. If false, logs a warning. */
    required: boolean
    /** If provided, also validates format */
    validate?: (val: string) => boolean
    validateMsg?: string
}

const ENV_SPEC: EnvVar[] = [
    // ── Required ──────────────────────────────────────────────────────────────
    {
        key: 'DATABASE_URL',
        description: 'PostgreSQL connection string',
        required: true,
        validate: (v) => v.startsWith('postgresql://') || v.startsWith('postgres://'),
        validateMsg: 'Must start with postgresql:// or postgres://',
    },
    {
        key: 'REDIS_URL',
        description: 'Redis connection string',
        required: true,
        validate: (v) => v.startsWith('redis://') || v.startsWith('rediss://'),
        validateMsg: 'Must start with redis:// or rediss://',
    },
    {
        key: 'SESSION_SECRET',
        description: 'Session encryption secret (generate: openssl rand -hex 64)',
        required: true,
        validate: (v) => v.length >= 32,
        validateMsg: 'Must be at least 32 characters',
    },
    {
        key: 'ENCRYPTION_SECRET',
        description: 'AES-256-GCM root key for credential encryption (generate: openssl rand -hex 32)',
        required: true,
        validate: (v) => v.length >= 32,
        validateMsg: 'Must be at least 32 characters — generate with: openssl rand -hex 32',
    },
    // ── Optional — AI providers (at least one must be present for agent tasks) ─
    {
        key: 'ANTHROPIC_API_KEY',
        description: 'Anthropic API key (primary AI provider)',
        required: false,
    },
    {
        key: 'OPENAI_API_KEY',
        description: 'OpenAI API key (fallback AI provider)',
        required: false,
    },
    // ── Optional — OAuth ──────────────────────────────────────────────────────
    {
        key: 'GITHUB_CLIENT_ID',
        description: 'GitHub OAuth App client ID',
        required: false,
    },
]

export function validateEnv(): void {
    const errors: string[] = []
    const warnings: string[] = []

    for (const spec of ENV_SPEC) {
        const val = process.env[spec.key]

        if (!val) {
            if (spec.required) {
                errors.push(`  ✗ ${spec.key} — ${spec.description}`)
            } else {
                warnings.push(`  ⚠ ${spec.key} not set — ${spec.description}`)
            }
            continue
        }

        if (spec.validate && !spec.validate(val)) {
            const msg = `  ✗ ${spec.key} — ${spec.validateMsg ?? 'invalid format'}`
            if (spec.required) {
                errors.push(msg)
            } else {
                warnings.push(msg)
            }
        }
    }

    // At least one AI provider must be set for tasks to work
    const hasAiProvider =
        !!process.env.ANTHROPIC_API_KEY ||
        !!process.env.OPENAI_API_KEY ||
        !!process.env.GEMINI_API_KEY ||
        !!process.env.GROQ_API_KEY ||
        !!process.env.MISTRAL_API_KEY

    if (!hasAiProvider) {
        warnings.push(
            '  ⚠ No AI provider key set — agent tasks will fail. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, MISTRAL_API_KEY',
        )
    }

    // Print warnings (non-fatal)
    if (warnings.length > 0) {
        console.warn('[env] Missing optional configuration:')
        for (const w of warnings) console.warn(w)
    }

    // Exit on errors (fatal)
    if (errors.length > 0) {
        console.error('[env] FATAL — Missing required environment variables:')
        for (const e of errors) console.error(e)
        console.error('\nSet these in .env (root of the repo). See .env.example for descriptions and generation commands.')
        console.error('See .env.example for descriptions and generation commands.')
        process.exit(1)
    }
}
