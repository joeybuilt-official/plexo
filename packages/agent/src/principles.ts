// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Governing Principles — encoded as code, not prompts.
 *
 * These are hard guardrails that the classifier, planner, and executor
 * enforce at the code level. They cannot be overridden by prompt
 * engineering, model quirks, or user confusion.
 *
 * Principle 1: SMALLEST POSSIBLE ACTION
 *   Default to the smallest action that satisfies the request.
 *   Only escalate scope when the user explicitly asks for more.
 *
 * Principle 2: NO INFRASTRUCTURE ASSUMPTIONS
 *   Work with what exists. Don't create tasks that require unconfigured
 *   services (repos, channels, providers).
 *
 * Principle 3: PROPORTIONAL PLANNING
 *   Plan complexity must be proportional to request complexity.
 *   A 10-word request never gets an 8-task plan.
 *
 * Principle 4: FAIL VISIBLE, FAIL FAST
 *   If something can't work, surface it in under 2 seconds with
 *   a specific fix action — don't queue tasks that will fail later.
 *
 * Principle 5: USER IS NOT A PROJECT MANAGER
 *   The agent never makes the user triage, coordinate, or debug
 *   the agent's own planning decisions.
 */

// ── Principle 1: Smallest Possible Action ────────────────────────────────────

/**
 * Hard-coded signals that force TASK classification regardless of model output.
 * These are structural patterns — the model can't override them.
 */
const PROJECT_REQUIRED_SIGNALS = [
    'project', 'initiative', 'multi-phase', 'multi-step',
    'workstreams', 'parallel tracks',
]

/**
 * Returns true only if the message explicitly describes multiple independent
 * deliverables. A single "create X" never qualifies, no matter how complex X sounds.
 */
export function requiresProjectScope(message: string): boolean {
    const lower = message.toLowerCase()
    // Must contain at least one explicit project signal
    const hasProjectSignal = PROJECT_REQUIRED_SIGNALS.some(s => lower.includes(s))
    if (!hasProjectSignal) return false

    // Must describe multiple independent deliverables (3+ "and"-separated items or explicit enumeration)
    const andCount = (lower.match(/\band\b/g) || []).length
    const commaListCount = (lower.match(/,\s*\w+/g) || []).length
    return andCount >= 2 || commaListCount >= 3
}

/**
 * Override classifier output when the message is clearly a single-deliverable request.
 * Called AFTER the LLM classifier runs. Returns the corrected intent.
 */
export function enforceSmallestAction(
    classifierResult: 'TASK' | 'PROJECT' | 'CONVERSATION',
    message: string,
): 'TASK' | 'PROJECT' | 'CONVERSATION' {
    if (classifierResult !== 'PROJECT') return classifierResult
    // If the classifier said PROJECT but the message doesn't have explicit project signals,
    // downgrade to TASK. The user can always escalate.
    if (!requiresProjectScope(message)) return 'TASK'
    return 'PROJECT'
}

// ── Principle 6: Conversational Override ─────────────────────────────────────
//
// Some messages are NEVER tasks, regardless of what the classifier thinks.
// These are detected at the code level and forced to CONVERSATION.

/** Messages that are clearly greetings, check-ins, or meta-communication — never tasks. */
const GREETING_PATTERNS = [
    /^(hey|hi|hello|yo|sup|what'?s up|howdy|good\s+(morning|afternoon|evening))[\s!?.,]*$/i,
    /^you\s+(there|up|around|working|ready|alive|online)[\s!?.,]*$/i,
    /^(still\s+(working|there)|ready\s+to\s+(rock|go|work)|what'?s\s+the\s+move)[\s!?.,]*$/i,
    /^(test(ing)?|ping|check)[\s!?.]*$/i,
    /^(thanks|thank\s+you|thx|ty|cool|ok|okay|got\s+it|nice|great|perfect|awesome|good)[\s!?.]*$/i,
    // Additional check-in / presence probes observed in the wild
    /^(are you (there|up|online|around|working))[\s!?.,]*$/i,
    /^(hello\??|hi there|anyone (home|there))[\s!?.,]*$/i,
    // "you still working?" / "you still there?" — presence probe with "you" prefix
    /^you\s+still\s+(working|there|up|around|online)[\s!?.,]*$/i,
    // Status queries — "any luck?", "status?", "any updates?", "any progress?"
    /^(any\s+(luck|update|updates|news|progress|word)[\s!?.,]*)$/i,
    /^(status|update|progress)[\s!?.,]*$/i,
    // Acknowledgments and affirmations
    /^(sounds\s+good|sounds\s+great|no\s+worries|no\s+problem|np|nvm|never\s+mind|forget\s+it)[\s!?.]*$/i,
    // "how's it going?", "how's everything?", "how are things?" — check-in variations
    /^how'?s?\s+(it|everything|things|that|this|the\s+\w+)\s*(going|looking|coming|coming\s+along)?[\s!?.,]*$/i,
    // "done yet?", "finished yet?", "is it done?", "is it finished?"
    /^(done|finished|complete|ready)\s*(yet|now)?[\s!?.,]*$/i,
    /^(is\s+it|is\s+that)\s+(done|finished|complete|ready|working)[\s!?.,]*$/i,
    // "working on it?", "still at it?", "on it?"
    /^(working\s+on\s+it|still\s+at\s+it|on\s+it)[\s!?.,]*$/i,
    // "what's happening?", "what's going on?"
    /^what'?s?\s+(happening|going\s+on|up|new)[\s!?.,]*$/i,
    // "can you help me with X?" — general help request (not a task)
    /^can\s+you\s+help\s+(me)?\s*(with\s+.{0,40})?[\s!?.,]*$/i,
]

/**
 * Imperative verbs that strongly signal TASK intent. Messages containing
 * these (at word boundaries) should NOT be pre-classified as CONVERSATION
 * even if they are short questions.
 */
const TASK_VERB_PATTERN = /\b(deploy|build|create|write|fix|update|install|configure|set\s+up|implement|migrate|generate|run|execute|send|push|pull|merge|commit|delete|remove|add|connect|integrate|schedule|monitor|restart|rebuild|analyze|audit|scan|refactor|optimize|research|investigate|search|find|look\s+up)\b/i

/**
 * Interrogative lead-ins. A message starting with one of these and
 * containing NO task verb is almost always a knowledge question.
 */
const INTERROGATIVE_LEADINS = [
    /^what(\s+is|\s+are|'?s|\s+does|\s+do)\b/i,
    /^who(\s+is|\s+are|'?s)\b/i,
    /^why(\s+is|\s+are|\s+does|\s+do|'?s)\b/i,
    /^how('?s?|\s+do|\s+does|\s+can|\s+many|\s+much|\s+to|\s+are|\s+is)\b/i,
    /^when(\s+is|\s+was|\s+will|'?s|\s+do|\s+does|\s+did)\b/i,
    /^where(\s+is|\s+are|\s+can|'?s|\s+do|\s+does|\s+did)\b/i,
    /^which\b/i,
    /^(tell\s+me|explain|describe)\b/i,
    /^(do|does|did|is|are|was|were|can|could|should|will|would)\s+(you|i|we|they|it|he|she)\b/i,
]

/**
 * Returns true if the message is a short knowledge question that should
 * route to CONVERSATION. Criteria:
 * - Starts with an interrogative lead-in (what/how/why/who/...)
 * - Contains no task verbs (deploy, build, create, fix, ...)
 * - Shorter than 15 words
 *
 * This covers the bulk of "what is X?", "how do Y?", "explain Z" messages
 * that would otherwise go through the LLM classifier.
 */
export function isShortKnowledgeQuestion(message: string): boolean {
    const trimmed = message.trim()
    if (!trimmed) return false
    const wordCount = trimmed.split(/\s+/).length
    if (wordCount >= 15) return false
    if (TASK_VERB_PATTERN.test(trimmed)) return false
    return INTERROGATIVE_LEADINS.some((p) => p.test(trimmed))
}

/**
 * Returns true if the message has a task verb AND is specific enough
 * (contains a file reference, URL, or concrete object). These should
 * always be treated as TASK — no LLM call needed.
 *
 * This is a narrow fast-path: only fires on high-confidence TASK signals.
 */
export function isObviousTaskRequest(message: string): boolean {
    const trimmed = message.trim()
    if (!trimmed) return false
    if (!TASK_VERB_PATTERN.test(trimmed)) return false
    // File reference like "auth.ts", "src/foo.js", "package.json"
    const hasFileRef = /\b[\w.-]+\.(ts|tsx|js|jsx|py|rs|go|java|cs|rb|php|css|html|json|yaml|yml|md|toml|sh)\b/i.test(trimmed)
    // URL reference
    const hasUrl = /\bhttps?:\/\/\S+/i.test(trimmed)
    // Path reference like "src/..." or "packages/..."
    const hasPath = /(^|\s)[./]?(src|apps|packages|lib|components|routes|pages|tests?)\//i.test(trimmed)
    return hasFileRef || hasUrl || hasPath
}

/** Messages where the user explicitly refuses task creation. */
const REFUSAL_PATTERNS = [
    /don'?t\s+(create|make|start|queue)\s+(a\s+)?task/i,
    /no\s+task/i,
    /just\s+(send|give|show|tell|answer|respond|reply)/i,
    /don'?t\s+need\s+a\s+task/i,
    /not\s+a\s+task/i,
    /stop\s+creating\s+tasks/i,
    /just\s+do\s+it/i,
    /just\s+do\s+the\s+thing/i,
]

/**
 * Short conversational continuations — messages that reference something
 * already in context rather than requesting new work.
 * Examples: "Give me a link, please", "Send it here", "Yes please", "Share the file"
 */
const CONVERSATIONAL_CONTINUATION_PATTERNS = [
    // "give/send/show me a/the [noun](, please)" — referencing something already mentioned
    /^(give|send|show|share)\s+me\s+(a|the)\s+\w+[,.]?\s*(please|pls)?[.,!?\s]*$/i,
    // "send/share it (here)" — clearly referencing prior context
    /^(send|share|give|show|post)\s+(it|that|this)\s*(here|now)?[.,!?\s]*$/i,
    // "yes please", "go ahead", "please do" — affirmative continuations
    /^(yes,?\s*)?(please|go ahead|do it|do that)[.,!?\s]*$/i,
    // "can I get/have/see the [noun]" — requesting something already mentioned
    /^can\s+(i|you)\s+(get|have|see|send|share)\s+(it|that|the\s+\w+)[.,!?\s]*$/i,
    // "link please", "file please" — bare noun + please
    /^(link|url|file|report|summary|results?|output|document)\s*(please|pls)?[.,!?\s]*$/i,
    // "send me the [noun]" — common request form referencing prior context
    /^(give|send|show|share)\s+me\s+the\s+\w+[.,!?\s]*$/i,
    // Short imperative continuations: "look it up", "find out", "check on it", "make one up"
    /^(look\s+it\s+up|find\s+out|check\s+(on\s+)?(it|that)|make\s+(one|it)\s+up|figure\s+it\s+out)[.,!?\s]*$/i,
    // "do it", "make it happen", "run it" — action continuations
    /^(do|run|try|start|make)\s+(it|that|this)\s*(now|again|here)?[.,!?\s]*$/i,
]

/**
 * Returns true if the message is a greeting, check-in, or meta-communication
 * that should never be classified as a TASK.
 */
export function isGreetingOrCheckin(message: string): boolean {
    return GREETING_PATTERNS.some(p => p.test(message.trim()))
}

/**
 * Returns true if the user is explicitly refusing task creation.
 */
export function isTaskRefusal(message: string): boolean {
    return REFUSAL_PATTERNS.some(p => p.test(message))
}

/**
 * Returns true if the message looks like a conversational continuation —
 * a short reply referencing something already discussed (e.g. "give me a link",
 * "send it here"). Only meaningful when conversation history exists.
 */
export function isConversationalContinuation(message: string): boolean {
    return CONVERSATIONAL_CONTINUATION_PATTERNS.some(p => p.test(message.trim()))
}

/**
 * Force CONVERSATION when the message is clearly conversational.
 * Called BEFORE the LLM classifier — short-circuits the entire classification pipeline.
 */
export function forceConversationOverride(message: string): boolean {
    return isGreetingOrCheckin(message) || isTaskRefusal(message)
}

/**
 * Force CONVERSATION when the message is clearly conversational, with context awareness.
 * When conversation history exists, also checks for short conversational continuations
 * like "give me a link" or "send it here" that reference prior context.
 *
 * Also short-circuits knowledge questions (what/how/why/...) shorter than
 * 15 words with no task verbs — these always belong in CONVERSATION.
 */
export function forceConversationOverrideWithContext(message: string, hasHistory: boolean): boolean {
    if (forceConversationOverride(message)) return true
    if (hasHistory && isConversationalContinuation(message)) return true
    if (isShortKnowledgeQuestion(message)) return true
    return false
}

// ── Principle 7: Correction Detection ────────────────────────────────────────
//
// Correction patterns are defined here (no DB dependency) so the classifier
// can check them without pulling in the full corrections module.

/** Patterns that signal the user is correcting or rejecting agent output. */
const CORRECTION_SIGNALS = [
    /that'?s\s+(wrong|incorrect|not\s+right|not\s+what)/i,
    /no,?\s+(actually|i\s+meant|i\s+said|i\s+asked)/i,
    /you\s+(misunderstood|got\s+it\s+wrong|missed)/i,
    /wrong\s+(answer|output|result|approach)/i,
    /try\s+again/i,
    /that\s+doesn'?t\s+(work|look\s+right|make\s+sense)/i,
    /not\s+what\s+i\s+(wanted|asked|meant)/i,
    /i\s+said\s+don'?t/i,
    /please\s+(fix|correct|redo|undo)/i,
    /start\s+over/i,
]

/**
 * Returns true if the message contains correction intent signals.
 */
export function hasCorrectionIntent(message: string): boolean {
    return CORRECTION_SIGNALS.some(p => p.test(message))
}

// ── Principle 2: No Infrastructure Assumptions ───────────────────────────────

export interface WorkspaceCapabilities {
    hasRepo: boolean
    hasAIProvider: boolean
    hasChannel: boolean
    hasConnections: string[]  // list of connected service IDs
}

/**
 * Pre-flight check before task/project creation.
 * Returns null if ready, or a user-facing error with fix action if not.
 */
export function preflightCheck(
    taskType: string,
    capabilities: WorkspaceCapabilities,
): { error: string; fixUrl: string; fixLabel: string } | null {
    if (!capabilities.hasAIProvider) {
        return {
            error: 'No AI provider configured. Add one to get started.',
            fixUrl: '/settings/ai-providers',
            fixLabel: 'Configure AI Provider',
        }
    }

    if (taskType === 'coding' && !capabilities.hasRepo) {
        return {
            error: 'No repository connected. Coding tasks need a repo to work against.',
            fixUrl: '/connections?highlight=github',
            fixLabel: 'Connect GitHub',
        }
    }

    return null
}

// ── Principle 3: Proportional Planning ───────────────────────────────────────

/**
 * Determine the maximum number of sprint tasks based on request complexity.
 * Short requests get fewer tasks. This is a hard cap, not a suggestion.
 */
export function maxSprintTasks(request: string): number {
    const words = request.trim().split(/\s+/).length
    if (words <= 15) return 2
    if (words <= 30) return 3
    if (words <= 60) return 5
    return 8
}

// ── Principle 4: Fail Visible, Fail Fast ─────────────────────────────────────

/**
 * Known failure patterns and their user-facing resolutions.
 * Used by both the error presenter (UI) and the pre-flight check (API).
 */
export const KNOWN_FAILURES: Record<string, { message: string; fixUrl: string; fixLabel: string }> = {
    'no_ai_credential': {
        message: 'No AI provider configured.',
        fixUrl: '/settings/ai-providers',
        fixLabel: 'Add AI Provider',
    },
    'cost_ceiling': {
        message: 'Weekly cost ceiling reached.',
        fixUrl: '/settings/ai-providers',
        fixLabel: 'Adjust Budget',
    },
    'no_repo': {
        message: 'No repository connected for coding tasks.',
        fixUrl: '/connections?highlight=github',
        fixLabel: 'Connect GitHub',
    },
}
