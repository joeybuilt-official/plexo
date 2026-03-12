// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Browser automation tools — powered by Playwright.
 *
 * Provides interactive browser capabilities: navigate, click, type, select,
 * extract text, take screenshots, and run multi-step browser workflows.
 *
 * A single shared browser context is lazily created per task execution and
 * cleaned up when the executor finishes.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { ulid } from 'ulid'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page } from 'playwright'
import type { StepEvent } from '../types.js'

// ── Shared browser lifecycle ────────────────────────────────────────────────

let _browser: Browser | null = null
let _context: BrowserContext | null = null
let _page: Page | null = null

async function ensureBrowser(): Promise<Page> {
    if (_page && !_page.isClosed()) return _page

    const { chromium } = await import('playwright')

    if (!_browser || !_browser.isConnected()) {
        _browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
        })
    }

    _context = await _browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    })

    _page = await _context.newPage()
    _page.setDefaultTimeout(30_000)
    return _page
}

/** Call this when the task executor finishes to free resources. */
export async function closeBrowser(): Promise<void> {
    try { await _page?.close() } catch { /* ignore */ }
    try { await _context?.close() } catch { /* ignore */ }
    try { await _browser?.close() } catch { /* ignore */ }
    _page = null
    _context = null
    _browser = null
}

// ── Helper: wait for network idle ───────────────────────────────────────────

async function safeWaitForLoad(page: Page, timeout = 10_000): Promise<void> {
    try {
        await page.waitForLoadState('networkidle', { timeout })
    } catch {
        // networkidle can time out on long-polling pages — that's fine
    }
}

// ── Screenshot helper: capture page and emit as base64 data URL ─────────────

type EmitFn = (event: StepEvent) => void

async function captureAndEmit(
    page: Page,
    taskId: string,
    workspaceId: string,
    label: string,
    emit: EmitFn | undefined,
): Promise<void> {
    if (!emit) return
    try {
        const buf = await page.screenshot({ type: 'jpeg', quality: 60 })
        const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
        emit({
            type: 'step.screenshot',
            taskId,
            workspaceId,
            dataUrl,
            label,
            ts: Date.now(),
        } satisfies import('../types.js').StepScreenshotEvent)
    } catch {
        // Non-fatal — screenshot emission is best-effort
    }
}

// ── Tool definitions ────────────────────────────────────────────────────────

export interface BrowserToolCtx {
    taskId: string
    workspaceId: string
    emitStepEvent?: (event: StepEvent) => void
}

export function buildBrowserTools(ctx: BrowserToolCtx) {
    const assetDir = `/tmp/plexo-assets/${ctx.taskId}`
    const emit = ctx.emitStepEvent

    return {
        browser_navigate: tool({
            description: 'Navigate the browser to a URL. Returns the page title and current URL after navigation completes. Use this to open websites, go to specific pages, or follow links by URL.',
            inputSchema: z.object({
                url: z.string().describe('URL to navigate to'),
                waitFor: z.string().optional().describe('Optional CSS selector to wait for before returning'),
            }),
            execute: async ({ url, waitFor }) => {
                try {
                    const page = await ensureBrowser()
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
                    await safeWaitForLoad(page)
                    if (waitFor) {
                        await page.waitForSelector(waitFor, { timeout: 10_000 }).catch(() => {})
                    }
                    await captureAndEmit(page, ctx.taskId, ctx.workspaceId, `Navigate → ${url}`, emit)
                    return JSON.stringify({
                        title: await page.title(),
                        url: page.url(),
                    })
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_click: tool({
            description: 'Click an element on the page. Identify elements by CSS selector or text content. Use this to click buttons, links, menu items, etc.',
            inputSchema: z.object({
                selector: z.string().describe('CSS selector or text= selector (e.g. "text=Sign Up", "#submit-btn", "button.primary")'),
            }),
            execute: async ({ selector }) => {
                try {
                    const page = await ensureBrowser()
                    await page.click(selector, { timeout: 10_000 })
                    await safeWaitForLoad(page, 5_000)
                    await captureAndEmit(page, ctx.taskId, ctx.workspaceId, `Click: ${selector}`, emit)
                    return JSON.stringify({
                        clicked: selector,
                        url: page.url(),
                        title: await page.title(),
                    })
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_type: tool({
            description: 'Type text into an input field. Clears the field first, then types the new value. Use for form fields, search boxes, text areas, etc.',
            inputSchema: z.object({
                selector: z.string().describe('CSS selector for the input/textarea element'),
                text: z.string().describe('Text to type into the field'),
                pressEnter: z.boolean().optional().default(false).describe('Whether to press Enter after typing'),
            }),
            execute: async ({ selector, text, pressEnter }) => {
                try {
                    const page = await ensureBrowser()
                    await page.fill(selector, text, { timeout: 10_000 })
                    if (pressEnter) {
                        await page.press(selector, 'Enter')
                        await safeWaitForLoad(page, 5_000)
                        await captureAndEmit(page, ctx.taskId, ctx.workspaceId, `Type + Enter: ${text.slice(0, 30)}`, emit)
                    }
                    return JSON.stringify({ typed: text, selector, url: page.url() })
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_select: tool({
            description: 'Select an option from a <select> dropdown element.',
            inputSchema: z.object({
                selector: z.string().describe('CSS selector for the <select> element'),
                value: z.string().describe('The option value or visible text to select'),
            }),
            execute: async ({ selector, value }) => {
                try {
                    const page = await ensureBrowser()
                    // Try by value first, fall back to label
                    const selected = await page.selectOption(selector, value, { timeout: 10_000 })
                        .catch(() => page.selectOption(selector, { label: value }, { timeout: 10_000 }))
                    await captureAndEmit(page, ctx.taskId, ctx.workspaceId, `Select: ${value}`, emit)
                    return JSON.stringify({ selected, selector })
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_extract: tool({
            description: 'Extract text content or attributes from elements on the page. Use to read page content, scrape data, check form values, or verify page state.',
            inputSchema: z.object({
                selector: z.string().optional().describe('CSS selector to extract from. Omit to get full page text.'),
                attribute: z.string().optional().describe('HTML attribute to extract (e.g. "href", "src", "value"). Omit for text content.'),
            }),
            execute: async ({ selector, attribute }) => {
                try {
                    const page = await ensureBrowser()
                    if (!selector) {
                        const text = await page.innerText('body').catch(() => '')
                        // Truncate
                        return text.length > 30_000
                            ? text.slice(0, 30_000) + '\n\n[Truncated at 30k chars]'
                            : text
                    }
                    const elements = await page.$$(selector)
                    if (elements.length === 0) return `No elements found matching "${selector}"`
                    const results: string[] = []
                    for (const el of elements.slice(0, 50)) {
                        if (attribute) {
                            results.push(await el.getAttribute(attribute) ?? '')
                        } else {
                            results.push(await el.innerText())
                        }
                    }
                    return results.join('\n---\n')
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_screenshot: tool({
            description: 'Take a screenshot of the current browser page. Returns the saved asset path. Use to see what the page looks like, debug issues, or verify visual state.',
            inputSchema: z.object({
                fullPage: z.boolean().optional().default(false).describe('Capture full scrollable page (default: viewport only)'),
            }),
            execute: async ({ fullPage }) => {
                try {
                    const page = await ensureBrowser()
                    const { mkdirSync } = await import('node:fs')
                    mkdirSync(assetDir, { recursive: true })

                    const filename = `browser_${ulid()}.png`
                    const filePath = join(assetDir, filename)
                    await page.screenshot({ path: filePath, fullPage })
                    // Also emit live screenshot event
                    await captureAndEmit(page, ctx.taskId, ctx.workspaceId, `Screenshot: ${page.url()}`, emit)
                    return `Screenshot saved: ${filename}\nView at: /api/v1/tasks/${ctx.taskId}/assets/${filename}\nPage: ${page.url()}`
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_eval: tool({
            description: 'Execute JavaScript in the browser page context. Returns the result serialized as JSON. Use for advanced DOM manipulation, reading complex page state, or interacting with page-level JavaScript APIs.',
            inputSchema: z.object({
                expression: z.string().describe('JavaScript expression to evaluate in the page context'),
            }),
            execute: async ({ expression }) => {
                try {
                    const page = await ensureBrowser()
                    const result = await page.evaluate(expression)
                    return JSON.stringify(result, null, 2)
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        browser_wait: tool({
            description: 'Wait for a specific condition on the page — an element to appear, disappear, or a timeout. Use between actions when the page needs time to update.',
            inputSchema: z.object({
                selector: z.string().optional().describe('CSS selector to wait for'),
                state: z.enum(['visible', 'hidden', 'attached', 'detached']).optional().default('visible').describe('What state to wait for'),
                timeout: z.number().optional().default(10000).describe('Max wait time in ms (default: 10000)'),
            }),
            execute: async ({ selector, state = 'visible', timeout = 10_000 }) => {
                try {
                    const page = await ensureBrowser()
                    if (selector) {
                        await page.waitForSelector(selector, { state, timeout })
                        await captureAndEmit(page, ctx.taskId, ctx.workspaceId, `Wait: ${selector} is ${state}`, emit)
                        return `Element "${selector}" is now ${state}`
                    } else {
                        await page.waitForTimeout(Math.min(timeout, 15_000))
                        return `Waited ${timeout}ms`
                    }
                } catch (err) {
                    return `ERROR: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
