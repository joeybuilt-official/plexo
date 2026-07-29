// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Bridge unit tests — Phase 9 read-only mode filter.
 *
 * The full `loadConnectionTools` path requires a DB and decrypted
 * credentials; we test it indirectly via the `isWriteTool` helper,
 * which is the sole classification used by the read-only filter.
 */

import { describe, expect, it } from 'vitest'
import { isWriteTool } from './write-tool-filter.js'

describe('isWriteTool', () => {
    it('treats known read verbs as non-write', () => {
        const reads = [
            'github__get_repo',
            'github__list_repos',
            'github__search_repos',
            'github__list_issues',
            'github__read_file',
            'github__get_ci_status',
            'slack__list_channels',
            'vercel__list_deployments',
            'vercel__get_deployment_status',
            'stripe__list_recent_payments',
            'stripe__get_revenue_summary',
            'cloudflare__list_dns',
            'sentry__list_projects',
            'sentry__list_issues',
            'posthog__list_feature_flags',
            'ovhcloud__list_servers',
            'ovhcloud__get_server_status',
            'deepgram__transcribe_audio',
            'deepgram__analyze_audio',
            'deepgram__detect_language',
            'linear__list_issues',
            'linear__search',
            'gdrive__search',
            'gdrive__get_file',
            'gdrive__list_folders',
            'jira__list_issues',
            'jira__search',
            'airtable__list_records',
            'airtable__search',
            'notion__search',
            'notion__get_page',
            'notion__list_databases',
            'notion__query_database',
            'ssh__list_dir',
            'ssh__download',
            'discord__list_channels',
        ]
        for (const r of reads) {
            expect(isWriteTool(r)).toBe(false)
        }
    })

    it('treats mutation verbs as write', () => {
        const writes = [
            'github__create_issue',
            'github__open_pr',
            'github__merge_pr',
            'github__create_branch',
            'github__push_file',
            'slack__send_message',
            'cloudflare__purge_cache',
            'sentry__resolve_issue',
            'posthog__toggle_feature_flag',
            'deepgram__text_to_speech',
            'linear__create_issue',
            'linear__update_issue',
            'gdrive__create_file',
            'jira__create_issue',
            'jira__update_issue',
            'airtable__create_record',
            'airtable__update_record',
            'notion__create_page',
            'notion__update_page',
            'telegram__send_message',
            'discord__send_message',
            'ssh__exec',
            'synthesize_extension',
        ]
        for (const w of writes) {
            expect(isWriteTool(w)).toBe(true)
        }
    })

    it('fails closed for unknown verbs (treats them as write)', () => {
        expect(isWriteTool('unknown__frobnicate_widget')).toBe(true)
        expect(isWriteTool('mystery__eject_ship')).toBe(true)
        expect(isWriteTool('xyz__')).toBe(true)
    })
})
