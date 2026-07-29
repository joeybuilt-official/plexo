// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, test, expect } from 'vitest'
import { requiresProjectScope, enforceSmallestAction, maxSprintTasks, preflightCheck, isConversationalContinuation, forceConversationOverrideWithContext, isShortKnowledgeQuestion, isObviousTaskRequest } from '../principles.js'

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

describe('Principle 6: Conversational Continuation', () => {
    test('short referential replies are conversational continuations', () => {
        expect(isConversationalContinuation('Give me a link, please')).toBe(true)
        expect(isConversationalContinuation('Send me the link')).toBe(true)
        expect(isConversationalContinuation('share it here')).toBe(true)
        expect(isConversationalContinuation('send it')).toBe(true)
        expect(isConversationalContinuation('yes please')).toBe(true)
        expect(isConversationalContinuation('go ahead')).toBe(true)
        expect(isConversationalContinuation('link please')).toBe(true)
        expect(isConversationalContinuation('Can I get the file?')).toBe(true)
    })

    test('actual task requests are NOT continuations', () => {
        expect(isConversationalContinuation('Create a snake game')).toBe(false)
        expect(isConversationalContinuation('Write a blog post about AI trends in 2026')).toBe(false)
        expect(isConversationalContinuation('Fix the broken import in auth.ts')).toBe(false)
        expect(isConversationalContinuation('Research the best frameworks for building mobile apps')).toBe(false)
    })

    test('forceConversationOverrideWithContext uses continuations only with history', () => {
        // Without history, "give me a link" should NOT be forced to CONVERSATION
        expect(forceConversationOverrideWithContext('Give me a link, please', false)).toBe(false)
        // With history, it should be forced to CONVERSATION
        expect(forceConversationOverrideWithContext('Give me a link, please', true)).toBe(true)
        // Greetings are always forced regardless of history
        expect(forceConversationOverrideWithContext('hello', false)).toBe(true)
        expect(forceConversationOverrideWithContext('hello', true)).toBe(true)
    })
})

describe('Phase 6: Classifier Resilience — pre-classifier heuristics', () => {
    test('isShortKnowledgeQuestion catches short what/how/why questions', () => {
        expect(isShortKnowledgeQuestion('What is the meaning of life?')).toBe(true)
        expect(isShortKnowledgeQuestion('How many countries are there?')).toBe(true)
        expect(isShortKnowledgeQuestion('Why does the sky look blue?')).toBe(true)
        expect(isShortKnowledgeQuestion('Who is the president of France?')).toBe(true)
        expect(isShortKnowledgeQuestion('Tell me about Mormon theology')).toBe(true)
        expect(isShortKnowledgeQuestion('Explain quantum entanglement')).toBe(true)
        expect(isShortKnowledgeQuestion('Do you know what time it is?')).toBe(true)
    })

    test('isShortKnowledgeQuestion rejects task verbs', () => {
        // Has a task verb → NOT a knowledge question (could be a task)
        expect(isShortKnowledgeQuestion('How do I deploy my app?')).toBe(false)
        expect(isShortKnowledgeQuestion('How do I fix the auth bug?')).toBe(false)
        expect(isShortKnowledgeQuestion('What files should I create?')).toBe(false)
    })

    test('isShortKnowledgeQuestion rejects long messages', () => {
        const longQuestion = 'What is the best way to approach the problem of distributed consensus when you have multiple nodes that may fail at any time'
        expect(isShortKnowledgeQuestion(longQuestion)).toBe(false)
    })

    test('isObviousTaskRequest catches file-referencing imperatives', () => {
        expect(isObviousTaskRequest('Fix the broken import in auth.ts')).toBe(true)
        expect(isObviousTaskRequest('Update src/components/Button.tsx')).toBe(true)
        expect(isObviousTaskRequest('Write a test for packages/agent/executor')).toBe(true)
        expect(isObviousTaskRequest('Deploy to https://staging.example.com')).toBe(true)
        expect(isObviousTaskRequest('Delete the old package.json entries')).toBe(true)
    })

    test('isObviousTaskRequest rejects vague requests', () => {
        expect(isObviousTaskRequest('Fix the bug')).toBe(false) // no file ref
        expect(isObviousTaskRequest('Deploy it')).toBe(false) // no URL / path
        expect(isObviousTaskRequest('What is happening')).toBe(false) // no task verb
    })

    test("today's regression messages all route correctly", () => {
        // The "You there?" disaster — must be CONVERSATION
        expect(forceConversationOverrideWithContext('You there?', true)).toBe(true)
        expect(forceConversationOverrideWithContext('You there?', false)).toBe(true)
        expect(forceConversationOverrideWithContext('Are you there?', true)).toBe(true)
        expect(forceConversationOverrideWithContext('still working?', true)).toBe(true)
        // Knowledge questions from the session
        expect(forceConversationOverrideWithContext('What are the LDS sacramental prayers?', true)).toBe(true)
        expect(forceConversationOverrideWithContext('How many countries are there?', true)).toBe(true)
        expect(forceConversationOverrideWithContext('Who are the 12 apostles?', true)).toBe(true)
        // Simple continuations
        expect(forceConversationOverrideWithContext('thanks', true)).toBe(true)
        expect(forceConversationOverrideWithContext('cool', true)).toBe(true)
        // Short vague greetings
        expect(forceConversationOverrideWithContext('hey', false)).toBe(true)
        expect(forceConversationOverrideWithContext('hi', false)).toBe(true)
    })

    test('real task messages still fall through to LLM classifier', () => {
        // These should NOT be force-overridden — they're genuine tasks
        expect(forceConversationOverrideWithContext('Create a snake game', true)).toBe(false)
        expect(forceConversationOverrideWithContext('Deploy the latest build', true)).toBe(false)
        expect(forceConversationOverrideWithContext('Research the top 5 JS frameworks', true)).toBe(false)
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
