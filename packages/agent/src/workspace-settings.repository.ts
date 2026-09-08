// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the workspace AI-settings port (Stage 3). The only
 * settings module permitted to import the ORM. The queries are the ones that
 * used to sit in `providers/settings-from-instances.ts`, narrowed to the
 * columns the caller reads.
 */

import { db, providerInstances, workspaces } from '@plexo/db'
import { eq, and, asc, isNull, isNotNull } from 'drizzle-orm'
import type {
    WorkspaceSettingsStore,
    SettingsInstanceRow,
    BalanceExhaustedRow,
    JudgeModelSelection,
} from './workspace-settings.ports.js'

export class DrizzleWorkspaceSettingsStore implements WorkspaceSettingsStore {
    async listInstances(workspaceId: string): Promise<SettingsInstanceRow[]> {
        return db.select({
            id: providerInstances.id,
            nickname: providerInstances.nickname,
            providerType: providerInstances.providerType,
            endpointUrl: providerInstances.endpointUrl,
            encryptedKey: providerInstances.encryptedKey,
            capabilities: providerInstances.capabilities,
            managed: providerInstances.managed,
            enabled: providerInstances.enabled,
            selectedModel: providerInstances.selectedModel,
            balanceExhaustedAt: providerInstances.balanceExhaustedAt,
        })
            .from(providerInstances)
            .where(eq(providerInstances.workspaceId, workspaceId))
            .orderBy(asc(providerInstances.preferenceOrder))
    }

    async getJudgeModel(workspaceId: string): Promise<JudgeModelSelection | null> {
        const rows = await db.select({ intelligenceSettings: workspaces.intelligenceSettings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        const intel = (rows[0]?.intelligenceSettings ?? {}) as Record<string, unknown>
        const judge = intel.judgeModel as { provider?: string; model?: string } | undefined
        if (!judge?.provider || !judge.model) return null
        return { provider: judge.provider, model: judge.model }
    }

    async markBalanceExhausted(workspaceId: string, providerType: string, at: Date): Promise<number> {
        const marked = await db.update(providerInstances)
            .set({ balanceExhaustedAt: at })
            .where(and(
                eq(providerInstances.workspaceId, workspaceId),
                eq(providerInstances.providerType, providerType),
                isNull(providerInstances.balanceExhaustedAt),
            ))
            .returning({ id: providerInstances.id })
        return marked.length
    }

    async clearBalanceExhausted(workspaceId: string, providerType: string): Promise<void> {
        await db.update(providerInstances)
            .set({ balanceExhaustedAt: null })
            .where(and(
                eq(providerInstances.workspaceId, workspaceId),
                eq(providerInstances.providerType, providerType),
            ))
    }

    async listBalanceExhausted(workspaceId: string): Promise<BalanceExhaustedRow[]> {
        return db.select({
            providerType: providerInstances.providerType,
            nickname: providerInstances.nickname,
            exhaustedAt: providerInstances.balanceExhaustedAt,
        })
            .from(providerInstances)
            .where(and(
                eq(providerInstances.workspaceId, workspaceId),
                isNotNull(providerInstances.balanceExhaustedAt),
            ))
    }
}
