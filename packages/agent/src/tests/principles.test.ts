// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, test, expect } from 'vitest'
import { requiresProjectScope, enforceSmallestAction, maxSprintTasks, preflightCheck } from '../principles.js'

describe('Principle 1: Smallest Possible Action', () => {
    test('single-deliverable requests are never PROJECT', () => {
        // These should all be downgraded from PROJECT to TASK
        expect(enforceSmallestAction('PROJECT', 'Create a simple web-based snake game')).toBe('TASK')
        expect(enforceSmallestAction('PROJECT', 'Write a landing page with a contact form')).toBe('TASK')
        expect(enforceSmallestAction('PROJECT', 'Build a calculator app')).toBe('TASK')
        expect(enforceSmallestAction('PROJECT', 'Generate a quarterly report')).toBe('TASK')
        expect(enforceSmallestAction('PROJECT', 'Fix the authentication bug')).toBe('TASK')
    })

    test('explicit multi-deliverable requests remain PROJECT', () => {
        expect(enforceSmallestAction('PROJECT', 'Build a SaaS project with auth, billing, dashboard, and API')).toBe('PROJECT')
        expect(enforceSmallestAction('PROJECT', 'Start a multi-phase initiative to migrate from AWS to GCP and update all services and documentation')).toBe('PROJECT')
    })

    test('TASK and CONVERSATION are never changed', () => {
        expect(enforceSmallestAction('TASK', 'anything')).toBe('TASK')
        expect(enforceSmallestAction('CONVERSATION', 'anything')).toBe('CONVERSATION')
    })

    test('requiresProjectScope detects multi-deliverable signals', () => {
        expect(requiresProjectScope('Create a snake game')).toBe(false)
        expect(requiresProjectScope('Build a project with auth, billing, dashboard, and API')).toBe(true)
        expect(requiresProjectScope('Start a multi-phase initiative to do X and Y and Z')).toBe(true)
    })
})

describe('Principle 3: Proportional Planning', () => {
    test('short requests get fewer tasks', () => {
        expect(maxSprintTasks('Create a snake game')).toBe(2)
        expect(maxSprintTasks('Fix the bug')).toBe(2)
    })

    test('medium requests get moderate tasks', () => {
        expect(maxSprintTasks('Build a landing page with hero section, features grid, pricing table, and contact form with email validation')).toBe(3)
    })

    test('long detailed requests get more tasks', () => {
        const longRequest = 'Build a complete SaaS application with user authentication using OAuth2, a billing system integrated with Stripe, an admin dashboard with analytics, a REST API with rate limiting and versioning, comprehensive test coverage, CI/CD pipeline, and production deployment configuration with monitoring, alerting, log aggregation, and automated rollback procedures for each service component in the distributed architecture with separate frontend and backend deployments'
        expect(maxSprintTasks(longRequest)).toBe(8)
    })
})

describe('Principle 2: No Infrastructure Assumptions', () => {
    test('coding tasks require a repo', () => {
        const result = preflightCheck('coding', { hasRepo: false, hasAIProvider: true, hasChannel: false, hasConnections: [] })
        expect(result).not.toBeNull()
        expect(result!.fixUrl).toContain('github')
    })

    test('non-coding tasks work without a repo', () => {
        const result = preflightCheck('research', { hasRepo: false, hasAIProvider: true, hasChannel: false, hasConnections: [] })
        expect(result).toBeNull()
    })

    test('all tasks require an AI provider', () => {
        const result = preflightCheck('research', { hasRepo: false, hasAIProvider: false, hasChannel: false, hasConnections: [] })
        expect(result).not.toBeNull()
        expect(result!.fixUrl).toContain('ai-providers')
    })
})
