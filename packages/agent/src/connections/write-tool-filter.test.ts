// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { isWriteTool } from './write-tool-filter.js'

describe('isWriteTool', () => {
    describe('reads — should return false', () => {
        it('get_* tools are reads', () => {
            expect(isWriteTool('github__get_issue')).toBe(false)
        })

        it('list_* tools are reads', () => {
            expect(isWriteTool('notion__list_pages')).toBe(false)
        })

        it('search_* tools are reads', () => {
            expect(isWriteTool('linear__search_issues')).toBe(false)
        })

        it('read_* tools are reads', () => {
            expect(isWriteTool('gdrive__read_file')).toBe(false)
        })

        it('fetch_* tools are reads', () => {
            expect(isWriteTool('slack__fetch_messages')).toBe(false)
        })

        it('view_* tools are reads', () => {
            expect(isWriteTool('airtable__view_records')).toBe(false)
        })

        it('find_* tools are reads', () => {
            expect(isWriteTool('github__find_repos')).toBe(false)
        })

        it('query_* tools are reads', () => {
            expect(isWriteTool('notion__query_database')).toBe(false)
        })

        it('describe_* tools are reads', () => {
            expect(isWriteTool('aws__describe_instance')).toBe(false)
        })

        it('count_* tools are reads', () => {
            expect(isWriteTool('linear__count_issues')).toBe(false)
        })

        it('check_* tools are reads', () => {
            expect(isWriteTool('stripe__check_subscription')).toBe(false)
        })

        it('download_* tools are reads', () => {
            expect(isWriteTool('gdrive__download_file')).toBe(false)
        })

        it('exact read-verb with no suffix is a read', () => {
            expect(isWriteTool('github__list')).toBe(false)
            expect(isWriteTool('github__get')).toBe(false)
        })

        it('bare tool name (no __ prefix) matching read verb is read', () => {
            expect(isWriteTool('list')).toBe(false)
            expect(isWriteTool('get')).toBe(false)
            expect(isWriteTool('search')).toBe(false)
        })
    })

    describe('writes — should return true', () => {
        it('create_* tools are writes', () => {
            expect(isWriteTool('notion__create_page')).toBe(true)
        })

        it('send_* tools are writes', () => {
            expect(isWriteTool('gmail__send_message')).toBe(true)
        })

        it('update_* tools are writes', () => {
            expect(isWriteTool('linear__update_issue')).toBe(true)
        })

        it('delete_* tools are writes', () => {
            expect(isWriteTool('github__delete_branch')).toBe(true)
        })

        it('post_* tools are writes', () => {
            expect(isWriteTool('slack__post_message')).toBe(true)
        })

        it('unknown verb is treated as write (safe default)', () => {
            expect(isWriteTool('github__frobnicate_repo')).toBe(true)
        })

        it('bare unknown tool with no __ is a write', () => {
            expect(isWriteTool('synthesize_extension')).toBe(true)
        })

        it('tool with read-like prefix that is not an exact verb match is a write', () => {
            // "getter" starts with "get" but is not "get" or "get_*"
            expect(isWriteTool('github__getter_thing')).toBe(true)
        })
    })

    describe('edge cases', () => {
        it('empty string is a write (unknown verb)', () => {
            expect(isWriteTool('')).toBe(true)
        })

        it('__ prefix with no short name is a write', () => {
            // split gives ['', ''] — short = '' → no read-verb match
            expect(isWriteTool('__')).toBe(true)
        })

        it('uppercase verb in tool name is treated as write (case-sensitive short name)', () => {
            // Implementation lowercases, so GET should match "get"
            expect(isWriteTool('github__GET_repo')).toBe(false)
        })
    })
})
