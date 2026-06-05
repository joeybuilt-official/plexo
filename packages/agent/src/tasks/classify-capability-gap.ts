/**
 * Conservative classifier distinguishing a *capability gap* (the agent was asked
 * to do something it has no tool/integration for — e.g. deploy/host a site) from a
 * genuine *tool error* (a tool that ran and threw). Used to label
 * `tasks.failure_reason` as `capability_unavailable` instead of the catch-all
 * `tool_error`.
 *
 * Mandate: "never worse". Only return true on a STRONG signal; default false so the
 * caller keeps `tool_error`. A false negative is harmless (status unchanged); a false
 * positive would mislabel a real failure, so the bar is deliberately high.
 */

const CAPABILITY_GAP_SIGNALS: readonly RegExp[] = [
    /\bdeployment capabilit/i,
    /\bno (?:deployment|hosting) (?:capabilit|access)/i,
    /\b(?:can'?t|cannot) actually deploy\b/i,
    /\bcannot (?:deploy|host)\b/i,
    /\bcannot create external\b/i,
    /\bdo(?:es)?n'?t have (?:that |the )?capabilit/i,
    /\bunknown tool\b/i,
    /\bno such tool\b/i,
    /\bno (?:tool|integration|connector) (?:available|configured|found)\b/i,
]

export function classifyCapabilityGap(errorText: string | null | undefined): boolean {
    if (!errorText) return false
    return CAPABILITY_GAP_SIGNALS.some(re => re.test(errorText))
}
