const WEEK_MS = 604800000

// confidence×recency-decay; used for tie-stable pure ranking (SQL already orders, this is the pure spec).
export function salienceScore(confidence: number, ageMs: number, halfLifeMs: number): number {
    return confidence * Math.exp(-ageMs / halfLifeMs)
}

export function rankBySalience<T extends { content: string; shorthand: string | null; createdAt: Date | string; confidence: number }>(
    rows: T[],
    opts: { budgetChars: number; limit: number; halfLifeMs?: number },
): T[] {
    const halfLifeMs = opts.halfLifeMs ?? WEEK_MS
    const now = Date.now()
    const scored = rows.map((r, i) => {
        const created = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime()
        return { r, i, score: salienceScore(r.confidence, now - created, halfLifeMs) }
    })
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i))

    const out: T[] = []
    let chars = 0
    for (const { r } of scored) {
        if (out.length >= opts.limit) break
        const cost = (r.shorthand ?? r.content).length
        if (chars + cost > opts.budgetChars) break
        chars += cost
        out.push(r)
    }
    return out
}
