// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { looksLikeChat, QUICK_SEND_CHAT_MAX_LEN } from '../quick-send-routing'

describe('looksLikeChat', () => {
    it('routes short status questions to chat', () => {
        expect(looksLikeChat('You working?')).toBe(true)
    })

    it('routes bare greetings to chat', () => {
        expect(looksLikeChat('Hello')).toBe(true)
    })

    it('routes generic short questions to chat', () => {
        expect(looksLikeChat('What time is it?')).toBe(true)
    })

    it('keeps project build requests on the task path', () => {
        expect(looksLikeChat('Build me a CRM with auth and a dashboard')).toBe(false)
    })

    it('keeps "create a task" drafts on the task path', () => {
        expect(looksLikeChat('Create a new task to review the Q4 budget')).toBe(false)
    })

    it('rejects drafts that exceed the length cap', () => {
        expect(looksLikeChat('a'.repeat(250))).toBe(false)
    })

    it('rejects empty / whitespace-only drafts', () => {
        expect(looksLikeChat('')).toBe(false)
        expect(looksLikeChat('   \n\t')).toBe(false)
        expect(looksLikeChat(null)).toBe(false)
        expect(looksLikeChat(undefined)).toBe(false)
    })

    it('catches project verbs regardless of case', () => {
        expect(looksLikeChat('MAKE a todo app')).toBe(false)
        expect(looksLikeChat('please implement a login form')).toBe(false)
        expect(looksLikeChat('scaffold the workspace')).toBe(false)
        expect(looksLikeChat('set up a Postgres instance')).toBe(false)
    })

    it('allows drafts that merely contain a project verb as a substring', () => {
        // "setupbar" is not a whole-word match for "setup"
        expect(looksLikeChat('what is setupbar doing?')).toBe(true)
    })

    it('uses the exported length cap', () => {
        const atCap = 'a'.repeat(QUICK_SEND_CHAT_MAX_LEN)
        const overCap = 'a'.repeat(QUICK_SEND_CHAT_MAX_LEN + 1)
        expect(looksLikeChat(atCap)).toBe(true)
        expect(looksLikeChat(overCap)).toBe(false)
    })
})
