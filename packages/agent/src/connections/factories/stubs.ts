// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stub factories for providers advertised in CONNECTION_CAPABILITIES that do not
 * yet have real implementations. Each tool returns a clear "not yet implemented"
 * message so the agent knows the connection exists but the action cannot run.
 *
 * This is strictly better than the previous silent-drop behavior (factory missing
 * from TOOL_FACTORIES → tool never registered → agent hallucinated failures).
 *
 * Replace these with real factories as they are built.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'

type StubSpec = {
    name: string
    description: string
    inputSchema: z.ZodTypeAny
}

function buildStub(provider: string, specs: StubSpec[]): (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }) => ToolSet {
    return () => {
        const out: ToolSet = {}
        for (const spec of specs) {
            out[`${provider}__${spec.name}`] = tool({
                description: `[NOT YET IMPLEMENTED] ${spec.description} — the connection is installed but the runtime factory is pending. Report this to the user honestly.`,
                inputSchema: spec.inputSchema,
                execute: async () => {
                    return `${provider}__${spec.name} is not yet implemented. The ${provider} connection is installed and credentials are stored, but the runtime tool factory has not been built. Tell the user explicitly that this tool is a known gap.`
                },
            })
        }
        return out
    }
}

export const GITLAB_TOOLS = buildStub('gitlab', [
    { name: 'list_projects', description: 'List GitLab projects', inputSchema: z.object({}) },
    { name: 'create_issue', description: 'Create a GitLab issue', inputSchema: z.object({ projectId: z.string(), title: z.string(), description: z.string().optional() }) },
])

export const NETLIFY_TOOLS = buildStub('netlify', [
    { name: 'list_sites', description: 'List Netlify sites', inputSchema: z.object({}) },
    { name: 'trigger_deploy', description: 'Trigger a Netlify deploy', inputSchema: z.object({ siteId: z.string() }) },
])

export const SENDGRID_TOOLS = buildStub('sendgrid', [
    { name: 'send_email', description: 'Send a transactional email', inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }) },
])

export const MAILCHIMP_TOOLS = buildStub('mailchimp', [
    { name: 'send_campaign', description: 'Send a Mailchimp campaign', inputSchema: z.object({ campaignId: z.string() }) },
    { name: 'list_subscribers', description: 'List Mailchimp subscribers', inputSchema: z.object({ listId: z.string() }) },
])

export const PAGERDUTY_TOOLS = buildStub('pagerduty', [
    { name: 'trigger_incident', description: 'Trigger a PagerDuty incident', inputSchema: z.object({ serviceId: z.string(), summary: z.string() }) },
    { name: 'resolve_incident', description: 'Resolve a PagerDuty incident', inputSchema: z.object({ incidentId: z.string() }) },
])

export const DATADOG_TOOLS = buildStub('datadog', [
    { name: 'query_metrics', description: 'Query Datadog metrics', inputSchema: z.object({ query: z.string() }) },
    { name: 'query_logs', description: 'Query Datadog logs', inputSchema: z.object({ query: z.string() }) },
])

export const REPLICATE_TOOLS = buildStub('replicate', [
    { name: 'run_model', description: 'Run a Replicate model', inputSchema: z.object({ model: z.string(), input: z.record(z.string(), z.unknown()) }) },
])

export const FAL_AI_TOOLS = buildStub('fal-ai', [
    { name: 'run_model', description: 'Run a fal.ai model', inputSchema: z.object({ model: z.string(), input: z.record(z.string(), z.unknown()) }) },
])

export const STABILITY_TOOLS = buildStub('stability', [
    { name: 'generate_image', description: 'Generate an image with Stability AI', inputSchema: z.object({ prompt: z.string() }) },
])

export const ELEVENLABS_TOOLS = buildStub('elevenlabs', [
    { name: 'text_to_speech', description: 'Synthesize speech with ElevenLabs', inputSchema: z.object({ text: z.string(), voiceId: z.string().optional() }) },
])

export const OPENAI_MEDIA_TOOLS = buildStub('openai', [
    { name: 'generate_image', description: 'Generate an image with OpenAI DALL-E', inputSchema: z.object({ prompt: z.string() }) },
    { name: 'transcribe_audio', description: 'Transcribe audio with OpenAI Whisper', inputSchema: z.object({ audioUrl: z.string() }) },
])
