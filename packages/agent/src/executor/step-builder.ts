// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Step-level checkpointing helpers for the iterative agent loop.
 * Reads persisted step records from task_steps to enable resume-from-checkpoint.
 */

import { DrizzleTaskStepStore } from '../executor.repository.js'
import type { TaskStepStore } from '../executor.ports.js'

// ── Composition root + test seam ────────────────────────────────────────────
let store: TaskStepStore = new DrizzleTaskStepStore()

/** Swap the task-step store (e.g. an in-memory fake in unit tests). */
export function setTaskStepStore(next: TaskStepStore): void {
    store = next
}

/**
 * Determine where to resume execution. Returns the next step number
 * (0 if fresh task, N+1 if resuming after step N).
 */
export async function getResumeStep(taskId: string): Promise<number> {
    const lastStep = await store.getLastStep(taskId)

    if (!lastStep) return 0
    // If the last step was terminal, the task is done — return -1 as sentinel
    if (lastStep.isTerminal) return -1
    return lastStep.stepNumber + 1
}

/**
 * Reconstruct message history from persisted step states for resume.
 * Returns the messages array that should be passed to the next generateText call.
 */
export async function buildResumeMessages(
    taskId: string,
    systemPrompt: string,
    userMessage: string,
): Promise<{ messages: unknown[]; resumeFromStep: number }> {
    const steps = await store.listSteps(taskId)

    if (steps.length === 0) {
        return {
            messages: [{ role: 'user', content: userMessage }],
            resumeFromStep: 0,
        }
    }

    // Start with the original user message
    let messages: unknown[] = [{ role: 'user', content: userMessage }]

    // Replay persisted step messages
    for (const step of steps) {
        const state = step.stepState as { responseMessages?: unknown[] } | null
        if (state?.responseMessages) {
            messages = messages.concat(state.responseMessages)
        }
    }

    // Add continuation prompt so the model knows it's resuming
    messages.push({
        role: 'user',
        content: 'You are resuming from a checkpoint. Continue from where you left off. Do not repeat already-completed work.',
    })

    return {
        messages,
        resumeFromStep: steps.length,
    }
}

/**
 * Extract tool calls from a generateText result step for persistence.
 */
export function extractToolCalls(result: { steps: Array<{ toolCalls: Array<{ toolName: string; toolCallId: string; input?: unknown }> }> }): Array<{ tool: string; input: unknown; output: string }> {
    const records: Array<{ tool: string; input: unknown; output: string }> = []
    for (const step of result.steps) {
        for (const tc of step.toolCalls) {
            records.push({
                tool: tc.toolName,
                input: (tc as { input?: unknown }).input ?? {},
                output: '', // filled later from toolResults
            })
        }
    }
    return records
}

/**
 * Check if a generateText result contains a task_complete call.
 */
export function hasTaskComplete(result: { steps: Array<{ toolCalls?: Array<{ toolName: string }> }> }): boolean {
    return result.steps.some(s => (s.toolCalls ?? []).some(tc => tc.toolName === 'task_complete'))
}
