import { db, eq, and, sql, asc, inArray } from '@plexo/db'
import { tasks } from '@plexo/db'
import { ulid } from 'ulid'

// ── Types ────────────────────────────────────────────────────

export interface PushParams {
    workspaceId: string
    type: 'coding' | 'deployment' | 'research' | 'ops' | 'opportunity' | 'monitoring' | 'report' | 'online' | 'automation'
    source: 'telegram' | 'slack' | 'discord' | 'scanner' | 'github' | 'cron' | 'dashboard' | 'api' | 'extension' | 'sentry'
    context: Record<string, unknown>
    priority?: number
    project?: string
    projectId?: string   // FK → sprints.id — the project this task belongs to
    parentId?: string
    status?: 'queued' | 'claimed' | 'running' | 'complete' | 'blocked' | 'cancelled'
    /** Max USD this task may spend. null = inherit workspace default. */
    costCeilingUsd?: number
    /** Max output tokens. 0 = no cap. */
    tokenBudget?: number
}

export interface CompleteParams {
    qualityScore: number
    outcomeSummary: string
    tokensIn: number
    tokensOut: number
    costUsd: number
}

export interface ListFilter {
    workspaceId?: string
    status?: string | string[]
    type?: string
    source?: string
    project?: string
    projectId?: string   // filter by sprint/project FK
    limit?: number
    cursor?: string
}

// ── Queue Operations ─────────────────────────────────────────

export async function push(params: PushParams): Promise<string> {
    const id = ulid()
    await db.insert(tasks).values({
        id,
        workspaceId: params.workspaceId,
        type: params.type,
        status: params.status ?? 'queued',
        priority: params.priority ?? 1,
        source: params.source,
        project: params.project ?? null,
        projectId: params.projectId ?? null,
        parentId: params.parentId ?? null,
        context: params.context,
        costCeilingUsd: params.costCeilingUsd ?? null,
        tokenBudget: params.tokenBudget ?? null,
    })
    return id
}

export async function claim(agentId: string): Promise<typeof tasks.$inferSelect | null> {
    // Atomic claim: SELECT FOR UPDATE SKIP LOCKED prevents double-claim
    const result = await db.execute<typeof tasks.$inferSelect>(sql`
    UPDATE tasks
    SET status = 'claimed', claimed_at = NOW()
    WHERE id = (
      SELECT id FROM tasks
      WHERE status = 'queued'
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `)

    return result[0] ?? null
}

export async function complete(taskId: string, params: CompleteParams): Promise<void> {
    await db.update(tasks)
        .set({
            status: 'complete',
            qualityScore: params.qualityScore,
            outcomeSummary: params.outcomeSummary,
            tokensIn: params.tokensIn,
            tokensOut: params.tokensOut,
            costUsd: params.costUsd,
            completedAt: new Date(),
        })
        .where(eq(tasks.id, taskId))
}

export async function block(taskId: string, reason: string): Promise<void> {
    await db.update(tasks)
        .set({ status: 'blocked', outcomeSummary: reason })
        .where(eq(tasks.id, taskId))
}

export async function cancel(taskId: string): Promise<void> {
    await db.update(tasks)
        .set({ status: 'cancelled' })
        .where(eq(tasks.id, taskId))
}

export async function list(filter: ListFilter = {}): Promise<(typeof tasks.$inferSelect)[]> {
    const conditions = []

    if (filter.workspaceId) {
        conditions.push(eq(tasks.workspaceId, filter.workspaceId))
    }
    if (filter.status) {
        if (Array.isArray(filter.status)) {
            conditions.push(inArray(tasks.status, filter.status as any)) // eslint-disable-line @typescript-eslint/no-explicit-any -- enum type coercion
        } else {
            conditions.push(eq(tasks.status, filter.status as any)) // eslint-disable-line @typescript-eslint/no-explicit-any -- enum type coercion
        }
    }
    if (filter.type) {
        conditions.push(eq(tasks.type, filter.type as any)) // eslint-disable-line @typescript-eslint/no-explicit-any -- enum type coercion
    }
    if (filter.project) {
        conditions.push(eq(tasks.project, filter.project))
    }
    if (filter.projectId) {
        conditions.push(eq(tasks.projectId, filter.projectId))
    }

    const query = db.select().from(tasks)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(tasks.priority), asc(tasks.createdAt))
        .limit(filter.limit ?? 50)

    return query
}
// ── Aliased exports for agent-loop compatibility ─────────────
export { claim as claimTask, complete as completeTask, block as blockTask, push as pushTask }
