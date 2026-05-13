// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { detectSideEffectGap, SIDE_EFFECT_PENALTY_CEILING } from './side-effect-check.js'

describe('detectSideEffectGap', () => {
    describe('no-op cases', () => {
        it('returns not-penalised for empty request', () => {
            expect(detectSideEffectGap('', 'did stuff', [])).toEqual({ penalised: false })
        })

        it('returns not-penalised for whitespace-only request', () => {
            expect(detectSideEffectGap('   ', 'did stuff', [])).toEqual({ penalised: false })
        })

        it('returns not-penalised when request has no action-hint match', () => {
            const result = detectSideEffectGap(
                'What is the weather today?',
                'The weather is sunny.',
                [],
            )
            expect(result.penalised).toBe(false)
        })
    })

    describe('Notion', () => {
        it('penalises when agent describes Notion creation instead of calling tool', () => {
            const result = detectSideEffectGap(
                'Create a Notion page for the project kickoff',
                "I will create a page with the following content...",
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.expectedLabel).toBe('Notion')
        })

        it('marks as hypothetical when summary contains future-tense language', () => {
            const result = detectSideEffectGap(
                'Make a Notion doc for the onboarding guide',
                "I would create a doc and add the following sections...",
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.reason).toMatch(/described it without calling/i)
        })

        it('does NOT penalise when a notion__ tool was called', () => {
            const result = detectSideEffectGap(
                'Create a Notion page for the project kickoff',
                'Page created successfully.',
                ['notion__create_page'],
            )
            expect(result.penalised).toBe(false)
            expect(result.matchedTools).toContain('notion__create_page')
        })
    })

    describe('Email', () => {
        it('penalises when agent describes email send without calling a mail tool', () => {
            const result = detectSideEffectGap(
                'Send an email to the team about the launch',
                "I'll compose and send the email now.",
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.expectedLabel).toBe('Email')
        })

        it('does NOT penalise when gmail__ tool was used', () => {
            const result = detectSideEffectGap(
                'Draft and send an email to marketing',
                'Email sent.',
                ['gmail__send_message'],
            )
            expect(result.penalised).toBe(false)
        })
    })

    describe('Slack', () => {
        it('penalises on "post to Slack" with no slack tool', () => {
            const result = detectSideEffectGap(
                'Post a message to Slack about the release',
                'I can post that for you.',
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.expectedLabel).toBe('Slack')
        })

        it('does NOT penalise when slack__ tool was used', () => {
            const result = detectSideEffectGap(
                'Send to Slack',
                'Posted.',
                ['slack__post_message'],
            )
            expect(result.penalised).toBe(false)
        })
    })

    describe('GitHub', () => {
        it('penalises when agent describes creating a GitHub issue without a tool', () => {
            const result = detectSideEffectGap(
                'Create a GitHub issue for the login bug',
                "Once you provide the repo, I would open the issue...",
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.expectedLabel).toBe('GitHub')
        })

        it('does NOT penalise when github__ tool was invoked', () => {
            const result = detectSideEffectGap(
                'Create a GitHub issue for the login bug',
                'Issue #42 created.',
                ['github__create_issue'],
            )
            expect(result.penalised).toBe(false)
        })
    })

    describe('Project trackers (Linear / Jira)', () => {
        it('penalises on "add a Jira ticket" with no tracker tool', () => {
            const result = detectSideEffectGap(
                'Add a Jira ticket for the payment bug',
                "I'd add a ticket to the backlog.",
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.expectedLabel).toBe('Project tracker')
        })
    })

    describe('matchedTools returned', () => {
        it('returns matched tool names when tool was found', () => {
            const result = detectSideEffectGap(
                'Create a Notion page',
                'Done.',
                ['notion__create_page', 'notion__update_block'],
            )
            expect(result.penalised).toBe(false)
            expect(result.matchedTools).toEqual(
                expect.arrayContaining(['notion__create_page', 'notion__update_block']),
            )
        })

        it('returns empty matchedTools when penalised', () => {
            const result = detectSideEffectGap(
                'Create a Notion page',
                'I will do that.',
                [],
            )
            expect(result.penalised).toBe(true)
            expect(result.matchedTools).toEqual([])
        })
    })
})

describe('SIDE_EFFECT_PENALTY_CEILING', () => {
    it('is 0.25 — the maximum quality score when simulated tool use is detected', () => {
        expect(SIDE_EFFECT_PENALTY_CEILING).toBe(0.25)
    })
})
