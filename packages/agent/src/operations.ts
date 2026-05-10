// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { NotImplementedError } from './errors.js'
import type {
    Task,
    TaskFilter,
    PushTaskParams,
    CompleteTaskParams,
    Session,
    Message,
    Channel,
    AddChannelParams,
    SprintParams,
    SprintStatus,
    MemoryEntry,
    MemorySearchOptions,
    MemoryResult,
} from './types.js'

// ── Task Operations ──────────────────────────────────────────

export async function pushTask(_params: PushTaskParams): Promise<string> {
    throw new NotImplementedError('pushTask')
}

export async function claimTask(_agentId: string): Promise<Task | null> {
    throw new NotImplementedError('claimTask')
}

export async function completeTask(_taskId: string, _result: CompleteTaskParams): Promise<void> {
    throw new NotImplementedError('completeTask')
}

export async function blockTask(_taskId: string, _reason: string): Promise<void> {
    throw new NotImplementedError('blockTask')
}

export async function listTasks(_filter?: TaskFilter): Promise<Task[]> {
    throw new NotImplementedError('listTasks')
}

// ── Session Operations ───────────────────────────────────────

export async function sendMessage(_channelId: string, _message: string): Promise<void> {
    throw new NotImplementedError('sendMessage')
}

export async function getSession(_sessionId: string): Promise<Session> {
    throw new NotImplementedError('getSession')
}

export async function listSessions(_workspaceId: string): Promise<Session[]> {
    throw new NotImplementedError('listSessions')
}

// ── Sprint Operations ────────────────────────────────────────

export async function startSprint(_params: SprintParams): Promise<string> {
    throw new NotImplementedError('startSprint')
}

export async function getSprintStatus(_sprintId: string): Promise<SprintStatus> {
    throw new NotImplementedError('getSprintStatus')
}

export async function cancelSprint(_sprintId: string): Promise<void> {
    throw new NotImplementedError('cancelSprint')
}

// ── Memory Operations ────────────────────────────────────────

export async function storeMemory(_entry: MemoryEntry): Promise<void> {
    throw new NotImplementedError('storeMemory')
}

export async function searchMemory(_query: string, _options?: MemorySearchOptions): Promise<MemoryResult[]> {
    throw new NotImplementedError('searchMemory')
}

// ── Channel Operations ───────────────────────────────────────

export async function getChannels(_workspaceId: string): Promise<Channel[]> {
    throw new NotImplementedError('getChannels')
}

export async function addChannel(_params: AddChannelParams): Promise<string> {
    throw new NotImplementedError('addChannel')
}
