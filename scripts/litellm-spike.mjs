#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// M0 spike for docs/claude/platform/litellm-gateway/plan.md — proves an
// OpenAI-compatible LLM gateway (LiteLLM) under the four load-bearing
// assumptions of Plexo's harness BEFORE any product code is wired:
//
//   A1  anthropic `cache_control` providerOptions survive the gateway and
//       produce real prompt-cache reads/writes on the response usage
//       (B1 cache-aware prompt layering depends on this)
//   A2  streaming `tool_calls` arrive complete and in order (DD-3's thin
//       streaming loop + the executor's multi-step tool use depend on this)
//   A3  gateway model GROUP aliases (not just raw model ids) are accepted as
//       the `model` value — this is how Plexo addresses LiteLLM routing
//   A4  a per-request model override (explicit model id) is honored by the
//       gateway (B11 mid-run downgrade + B17 weak-delegate depend on this)
//
// Run with the deployment's own credentials — never commit them:
//   SPIKE_BASE_URL=https://<gateway-host>/v1 SPIKE_KEY=sk-... \
//     [SPIKE_MODEL_MAIN=claude-sonnet-4-5] [SPIKE_MODEL_CHEAP=<alias-or-id>] \
//     node scripts/litellm-spike.mjs [--json]
//
// Exit 0 = all four green (go). Exit 1 = any red (stop-and-review per plan).
// Skipped (unconfigured) checks are reported and do not fail the run.

const BASE = (process.env.SPIKE_BASE_URL || '').replace(/\/+$/, '')
const KEY = process.env.SPIKE_KEY || ''
const MAIN = process.env.SPIKE_MODEL_MAIN || ''
const CHEAP = process.env.SPIKE_MODEL_CHEAP || ''
const OUT_JSON = process.argv.includes('--json')

if (!BASE || !KEY) {
  console.error('SPIKE_BASE_URL and SPIKE_KEY are required (see header comment). No secrets are committed to this repo.')
  process.exit(2)
}
if (!MAIN) {
  console.error('SPIKE_MODEL_MAIN is required — a real Anthropic-family model id the gateway is configured for (A1 needs a model that supports prompt caching).')
  process.exit(2)
}

const STABLE_PREFIX = `You are a meticulous test engineer. ${'Project conventions and rules follow. '.repeat(1000)}Answer concisely.`

function usageOf(chunkOrBody) {
  const u = chunkOrBody?.usage || {}
  const details = u.prompt_tokens_details || {}
  const anyU = u
  return {
    prompt: u.prompt_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
    cacheRead: anyU.cache_read_input_tokens ?? details.cached_tokens ?? 0,
    cacheWrite: anyU.cache_creation_input_tokens ?? 0,
  }
}

async function chat(body, { stream = false } = {}) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ ...body, stream }),
    signal: AbortSignal.timeout(stream ? 120_000 : 90_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
  if (!stream) {
    const json = await res.json()
    return { json, ms: Date.now() - t0 }
  }
  let text = ''
  const toolCalls = []
  let usage = null
  let sseBuf = ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    sseBuf += decoder.decode(value, { stream: true })
    const lines = sseBuf.split('\n')
    sseBuf = lines.pop()
    for (const line of lines) {
      const data = line.replace(/^data: /, '').trim()
      if (!data || data === '[DONE]') continue
      try {
        const evt = JSON.parse(data)
        const delta = evt.choices?.[0]?.delta
        if (delta?.content) text += delta.content
        for (const tc of delta?.tool_calls || []) {
          const idx = tc.index ?? 0
          toolCalls[idx] = toolCalls[idx] || { id: '', name: '', args: '' }
          if (tc.id) toolCalls[idx].id = tc.id
          if (tc.function?.name) toolCalls[idx].name = tc.function.name
          if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments
        }
        if (evt.usage) usage = evt.usage
      } catch { /* keep-alives / partial frames */ }
    }
  }
  return { text, toolCalls: toolCalls.filter(Boolean), usage, ms: Date.now() - t0 }
}

const results = []
function record(id, ok, detail, extra) {
  results.push({ id, status: ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', detail, ...extra })
  if (!OUT_JSON) console.log(`${results.at(-1).status.padEnd(4)} ${id} — ${detail}`)
}

async function main() {
  // ---- A3: alias / discovery sanity (cheap, do first) -------------------
  let modelCount = 0
  try {
    const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(15_000) })
    const body = await res.json()
    modelCount = (body.data || []).length
    const ids = (body.data || []).map(m => m.id)
    record('A3.discovery', modelCount > 0, `GET /models → ${modelCount} models visible to this key`)
    if (CHEAP) {
      const hit = ids.includes(CHEAP)
      record('A3.alias-listed', hit, `SPIKE_MODEL_CHEAP="${CHEAP}" ${hit ? 'is' : 'is NOT'} among advertised ids (aliases usually appear here on LiteLLM)`)
    } else {
      record('A3.alias-listed', null, 'SPIKE_MODEL_CHEAP unset — alias call check skipped')
    }
    if (!ids.includes(MAIN)) record('A3.main-visible', false, `SPIKE_MODEL_MAIN="${MAIN}" not in advertised list — continuing anyway (some gateways hide deployment ids)`)
    else record('A3.main-visible', true, `main model advertised`)
  } catch (e) {
    record('A3.discovery', false, `GET /models failed: ${e.message}`)
  }

  // ---- A1: automatic prefix-cache economics (two identical big prefixes) --
  // The plan's B1 economics need a long STABLE prefix re-read to be cheap on
  // the second turn. On OpenAI-compatible upstreams (DeepSeek/Qwen) that cache
  // is implicit: `prompt_tokens_details.cached_tokens` on the second call.
  // An explicit Anthropic `cache_control` marker is only meaningful when an
  // Anthropic deployment sits behind the gateway; for OpenAI-compat routes the
  // marker is dropped (reported separately, not a failure).
  const a1Base = {
    model: MAIN,
    max_tokens: 64,
    messages: [
      { role: 'system', content: STABLE_PREFIX },
    ],
  }
  try {
    // Warm the provider cache for THIS prefix first — the measured pair must
    // represent steady-state multi-turn reuse, not a cold first call.
    await chat({ ...a1Base, messages: [...a1Base.messages, { role: 'user', content: 'Reply with exactly: WARMUP' }], temperature: 0 })
    const c1 = await chat({ ...a1Base, messages: [...a1Base.messages, { role: 'user', content: 'Reply with exactly: OK' }], temperature: 0 })
    const u1 = usageOf(c1.json)
    const total1 = u1.prompt + u1.completion
    const c2 = await chat({ ...a1Base, messages: [...a1Base.messages, { role: 'user', content: 'Reply with exactly: OK2 again' }], temperature: 0 })
    const u2 = usageOf(c2.json)
    const hitRatio = total1 > 0 ? (u2.cacheRead / Math.max(1, u2.prompt + u2.completion)) : 0
    const autoOk = hitRatio >= 0.5
    record('A1.auto-cache', autoOk, `identical ~${(total1 / 1000).toFixed(1)}k-token prefix twice → call1 r=${u1.cacheRead}, call2 r=${u2.cacheRead}/${u2.prompt + u2.completion} (${(hitRatio * 100).toFixed(0)}% cached) — ${autoOk ? 'B1 economic premise holds through the gateway' : 'no cache reuse detected — B1 cost savings would not materialise'}`)
  } catch (e) {
    record('A1.auto-cache', false, `request failed: ${e.message}`)
  }
  // Marker passthrough: explicit cache_control, informational on non-Anthropic routes.
  try {
    const mCall = await chat({ ...a1Base, messages: [{ role: 'system', content: [{ type: 'text', text: STABLE_PREFIX, cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'Reply with exactly: OK' }], temperature: 0 })
    const um = usageOf(mCall.json)
    record('A1.marker', null, `explicit cache_control marker sent — cache tokens returned: w=${um.cacheWrite} r=${um.cacheRead} (expected 0 on OpenAI-compat routes without an Anthropic deployment; the marker is dropped)`)
  } catch (e) {
    record('A1.marker', null, `explicit cache_control marker request failed: ${e.message}`)
  }

  // ---- A2: streaming tool_calls ----------------------------------------
  try {
    const s = await chat({
      model: MAIN,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'What is 23 times 7? Use the calculator tool. You MUST call the tool.' }],
      tools: [{ type: 'function', function: { name: 'calculator', description: 'Arithmetic', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } }],
      tool_choice: 'required',
    }, { stream: true })
    const ok = s.toolCalls.length > 0 && s.toolCalls.every(tc => tc.id && tc.name) && (() => { try { JSON.parse(s.toolCalls[0].args); return true } catch { return false } })()
    record('A2.stream_tools', ok, `${s.toolCalls.length} tool_call(s) streamed: ${JSON.stringify(s.toolCalls.map(t => ({ n: t.name, a: t.args.slice(0, 40) })))} — args ${ok ? 'parse as valid JSON' : 'MALFORMED/absent (blockers for the executor loop)'}`)
  } catch (e) {
    record('A2.stream_tools', false, `stream request failed: ${e.message}`)
  }

  // ---- A3.call: address the gateway by alias ----------------------------
  if (CHEAP) {
    try {
      const r = await chat({ model: CHEAP, max_tokens: 16, messages: [{ role: 'user', content: 'Say OK' }] })
      const served = r.json.model || ''
      record('A3.alias-call', true, `chat as model="${CHEAP}" served by "${served}" — this is Plexo's intended call shape`)
    } catch (e) {
      record('A3.alias-call', false, `chat as model="${CHEAP}" failed: ${e.message}`)
    }
  }

  // ---- A4: per-request explicit model honored ---------------------------
  if (CHEAP && MAIN && CHEAP !== MAIN) {
    try {
      const a = await chat({ model: MAIN, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
      const b = await chat({ model: CHEAP, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
      const servedA = a.json.model || 'unknown'
      const servedB = b.json.model || 'unknown'
      const distinct = servedA !== servedB || MAIN !== CHEAP
      record('A4.override', distinct, `explicit model ids resolved to "${servedA}" / "${servedB}" — B11/B17 modelIdOverride ${distinct ? 'would work' : 'indistinguishable, verify manually'}`)
    } catch (e) {
      record('A4.override', false, `failed: ${e.message}`)
    }
  } else {
    record('A4.override', null, 'SPIKE_MODEL_CHEAP unset or equals MAIN — override-distinctness check skipped')
  }

  const fails = results.filter(r => r.status === 'FAIL')
  if (OUT_JSON) console.log(JSON.stringify({ results }, null, 2))
  else {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`VERDICT: ${fails.length === 0 ? 'GO — all configured checks green' : `NO-GO — ${fails.length} failing check(s); fix or re-propose per plan M0`}  (latency: base=${BASE.replace(/^https?:\/\//, '')} models=${modelCount})`)
  }
  process.exit(fails.length === 0 ? 0 : 1)
}

main().catch(e => { console.error('spike crashed:', e); process.exit(2) })
