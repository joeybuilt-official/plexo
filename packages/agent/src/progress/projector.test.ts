import { describe, it, expect } from 'vitest'
import { projectEvent, formatCompactProgress, type ChannelType } from './projector.js'
import type { ProgressEvent } from './types.js'

function makeEvent(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
    return {
        id: 'test-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        type: 'status',
        content: 'Scanning repository',
        timestamp: Date.now(),
        ...overrides,
    }
}

describe('projectEvent', () => {
    it('telegram suppresses tool_call events', () => {
        const result = projectEvent(makeEvent({ type: 'tool_call', content: 'Reading file' }), 'telegram')
        expect(result).toBeNull()
    })

    it('telegram includes phase_start events', () => {
        const result = projectEvent(makeEvent({
            type: 'phase_start',
            phase: { index: 2, total: 6, label: 'Writing migration' },
            content: 'Phase 3/6: Writing migration',
        }), 'telegram')
        expect(result).not.toBeNull()
        expect(result!.text).toContain('Writing migration')
    })

    it('web-glass-cockpit includes everything', () => {
        const types: ProgressEvent['type'][] = ['phase_start', 'tool_call', 'tool_result', 'reasoning', 'memory_commit', 'learning', 'error', 'status']
        for (const type of types) {
            const result = projectEvent(makeEvent({ type, content: 'test' }), 'web-glass-cockpit')
            expect(result).not.toBeNull()
        }
    })

    it('enforces voice rules — rejects "Sorry" content', () => {
        const result = projectEvent(makeEvent({
            type: 'status',
            content: 'Sorry, still working on it',
            tool: { name: 'shell', displayAction: 'Running tests' },
        }), 'web-default')
        expect(result).not.toBeNull()
        expect(result!.text).not.toContain('Sorry')
        expect(result!.text).toBe('Running tests')
    })

    it('enforces voice rules — rejects content-free messages', () => {
        const result = projectEvent(makeEvent({
            type: 'status',
            content: 'One moment please...',
            phase: { index: 1, total: 3, label: 'Testing' },
        }), 'telegram')
        expect(result!.text).not.toContain('moment')
        expect(result!.text).toBe('Testing')
    })

    it('embedded matches web-default density', () => {
        const toolCall = makeEvent({ type: 'tool_call', content: 'Reading file' })
        const webResult = projectEvent(toolCall, 'web-default')
        const embeddedResult = projectEvent(toolCall, 'embedded')
        // Both should include tool_call (normal density)
        expect(webResult).not.toBeNull()
        expect(embeddedResult).not.toBeNull()
    })
})

describe('formatCompactProgress', () => {
    it('formats phase progress with emoji', () => {
        const result = formatCompactProgress(makeEvent({
            type: 'phase_start',
            phase: { index: 2, total: 6, label: 'Writing migration' },
        }))
        expect(result).toBe('📍 Phase 3/6: Writing migration')
    })

    it('formats phase completion with checkmark', () => {
        const result = formatCompactProgress(makeEvent({
            type: 'phase_complete',
            phase: { index: 2, total: 6, label: 'Writing migration' },
        }))
        expect(result).toBe('✓ Phase 3/6: Writing migration')
    })

    it('formats errors with warning', () => {
        const result = formatCompactProgress(makeEvent({
            type: 'error',
            content: 'DeepSeek returned 429. Retrying in 10s.',
        }))
        expect(result).toBe('⚠️ DeepSeek returned 429. Retrying in 10s.')
    })

    it('falls back to content when no phases', () => {
        const result = formatCompactProgress(makeEvent({
            type: 'status',
            content: 'Scanning repository',
        }))
        expect(result).toBe('Scanning repository')
    })
})
