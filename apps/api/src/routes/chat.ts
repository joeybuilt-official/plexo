/**
 * Webchat API
 *
 * POST /api/chat/message  — Accept a user message, classify intent:
 *   CONVERSATION → direct AI reply (no task queued)
 *   TASK → queue a task, return taskId for polling
 * GET  /api/chat/reply/:taskId — Poll for agent reply (returns when complete)
 * GET  /api/chat/widget.js — Serve the embeddable chat widget script
 *
 * The widget is injected via:
 *   <script src="https://your-api/api/chat/widget.js"
 *           data-workspace="<wsId>" data-site-name="My App"
 *   ></script>
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { tasks, workspaces } from '@plexo/db'
import { logger } from '../logger.js'
import { ulid } from 'ulid'
import { generateText } from 'ai'
import { buildModel } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'

export const chatRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Intent classification ────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK REQUEST or CONVERSATION.

TASK: requires autonomous execution — create, write, fix, research, build, deploy, analyze, automate, schedule, etc.
CONVERSATION: greetings, status checks, questions about you, small talk, thanks, clarifications, simple questions.

Reply with ONLY one word: TASK or CONVERSATION.`

// Per-session conversation history (last 20 messages, in-memory)
const sessionHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string }>>()

// ── POST /api/chat/message ────────────────────────────────────────────────────

chatRouter.post('/message', async (req, res) => {
    const { workspaceId, message, sessionId } = req.body as {
        workspaceId?: string
        message?: string
        sessionId?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!message || message.trim().length === 0) {
        res.status(400).json({ error: { code: 'MISSING_MESSAGE', message: 'message required' } })
        return
    }
    if (message.length > 2000) {
        res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: 'Max 2000 characters' } })
        return
    }

    try {
        // Verify workspace exists
        const [ws] = await db.select({ id: workspaces.id }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Load AI settings
        const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!credential || !aiSettings) {
            res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: 'No AI provider configured. Go to Settings → AI Providers.' } })
            return
        }

        const providerKey = aiSettings.primaryProvider
        const config = aiSettings.providers[providerKey]
        if (!config) {
            res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: `No config for provider ${providerKey}` } })
            return
        }

        const model = buildModel(providerKey, config, 'summarization', aiSettings)
        const trimmedMsg = message.trim()

        // Classify intent
        let intent: 'TASK' | 'CONVERSATION' = 'CONVERSATION'
        try {
            const classifyResult = await generateText({
                model,
                system: CLASSIFY_SYSTEM,
                messages: [{ role: 'user', content: trimmedMsg }],
                abortSignal: AbortSignal.timeout(10_000),
            })
            intent = classifyResult.text?.trim().toUpperCase().startsWith('TASK') ? 'TASK' : 'CONVERSATION'
        } catch {
            // On classification failure, default to CONVERSATION
            intent = 'CONVERSATION'
        }

        logger.info({ workspaceId, intent, message: trimmedMsg.slice(0, 80) }, 'Webchat intent classified')

        if (intent === 'CONVERSATION') {
            // Direct conversational reply — no task queue
            const sid = sessionId ?? 'default'
            const history = sessionHistory.get(sid) ?? []
            history.push({ role: 'user', content: trimmedMsg })
            if (history.length > 20) history.splice(0, history.length - 20)
            sessionHistory.set(sid, history)

            try {
                logger.info({ workspaceId, providerKey, modelId: config.model }, 'Webchat: generating conversational reply')
                const result = await generateText({
                    model,
                    system: 'You are Plexo, a helpful AI agent. Keep replies concise and friendly. '
                        + 'If the user describes something they want done, ask them to confirm so you can execute it as a task.',
                    messages: history.map(m => ({ role: m.role, content: m.content })),
                    abortSignal: AbortSignal.timeout(30_000),
                })
                const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
                history.push({ role: 'assistant', content: replyText })
                if (history.length > 20) history.splice(0, history.length - 20)
                sessionHistory.set(sid, history)

                // Persist as a completed task so it appears in Conversations
                const chatTaskId = ulid()
                await db.insert(tasks).values({
                    id: chatTaskId,
                    workspaceId,
                    type: 'online',
                    status: 'complete',
                    priority: 1,
                    source: 'dashboard',
                    context: {
                        message: trimmedMsg,
                        reply: replyText,
                        sessionId: sid,
                        channel: 'webchat',
                    },
                    outcomeSummary: replyText,
                    completedAt: new Date(),
                })

                res.json({ status: 'complete', reply: replyText })
            } catch (err) {
                logger.error({ err, workspaceId }, 'Webchat conversational reply failed')
                res.json({ status: 'complete', reply: "I'm having a bit of trouble right now — please try again in a moment." })
            }
            return
        }

        // TASK — queue for the agent
        const taskId = ulid()
        await db.insert(tasks).values({
            id: taskId,
            workspaceId,
            type: 'online',
            status: 'queued',
            priority: 5,
            source: 'dashboard',
            context: {
                description: trimmedMsg,
                message: trimmedMsg,
                sessionId: sessionId ?? null,
                channel: 'webchat',
                respondVia: 'task_outcome',
            },
        })

        logger.info({ workspaceId, taskId }, 'Webchat task queued')
        res.status(202).json({ taskId, status: 'queued' })
    } catch (err) {
        logger.error({ err }, 'POST /api/chat/message failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to queue message' } })
    }
})

// ── GET /api/chat/reply/:taskId ───────────────────────────────────────────────
// Long-poll: waits up to 25s for the task to complete, then returns outcome

chatRouter.get('/reply/:taskId', async (req, res) => {
    const { taskId } = req.params
    const deadline = Date.now() + 25_000
    const interval = 1_000

    const poll = async (): Promise<void> => {
        try {
            const [task] = await db.select({
                status: tasks.status,
                outcomeSummary: tasks.outcomeSummary,
            }).from(tasks).where(eq(tasks.id, taskId!)).limit(1)

            if (!task) {
                res.status(404).json({ error: { code: 'TASK_NOT_FOUND' } })
                return
            }

            if (task.status === 'complete') {
                res.json({
                    taskId,
                    status: task.status,
                    reply: task.outcomeSummary ?? 'Done.',
                })
                return
            }

            if (task.status === 'cancelled' || task.status === 'blocked') {
                const reason = task.outcomeSummary ?? ''
                const isNoCredential = !reason || reason.toLowerCase().includes('credential') || reason.toLowerCase().includes('no ai')
                res.json({
                    taskId,
                    status: task.status,
                    reply: task.status === 'blocked'
                        ? isNoCredential
                            ? 'No AI provider configured. Go to Settings → AI Providers and test your connection.'
                            : `Agent error: ${reason}`
                        : 'Task cancelled.',
                })
                return
            }

            if (Date.now() >= deadline) {
                res.json({ taskId, status: 'pending', reply: "I'm still working on it — check back shortly." })
                return
            }

            await new Promise<void>((resolve) => setTimeout(resolve, interval))
            await poll()
        } catch (err) {
            logger.error({ err, taskId }, 'Webchat poll failed')
            res.status(500).json({ error: { code: 'POLL_FAILED' } })
        }
    }

    await poll()
})

// ── GET /api/chat/widget.js ───────────────────────────────────────────────────
// Embeddable chat widget — vanilla JS, no framework needed

chatRouter.get('/widget.js', (req, res) => {
    const apiBase = process.env.PUBLIC_URL ?? 'http://localhost:3001'

    const script = `
(function() {
    var cfg = document.currentScript;
    var wsId = cfg && cfg.getAttribute('data-workspace') || '';
    var siteName = cfg && cfg.getAttribute('data-site-name') || 'Plexo';
    var apiBase = cfg && cfg.getAttribute('data-api') || '${apiBase}';
    if (!wsId) { console.warn('[Plexo] data-workspace attribute required'); return; }

    // Inject styles
    var style = document.createElement('style');
    style.textContent = [
        '#plexo-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;cursor:pointer;box-shadow:0 4px 24px rgba(99,102,241,.4);display:flex;align-items:center;justify-content:center;z-index:9999;transition:transform .2s}',
        '#plexo-widget-btn:hover{transform:scale(1.08)}',
        '#plexo-widget-panel{position:fixed;bottom:96px;right:24px;width:360px;height:480px;border-radius:16px;background:#18181b;border:1px solid #3f3f46;box-shadow:0 24px 64px rgba(0,0,0,.6);display:flex;flex-direction:column;z-index:9998;overflow:hidden;opacity:0;transform:translateY(16px) scale(.96);transition:opacity .2s,transform .2s;pointer-events:none}',
        '#plexo-widget-panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}',
        '#plexo-widget-header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #3f3f46;background:#09090b}',
        '#plexo-widget-header span{font-size:14px;font-weight:600;color:#f4f4f5;font-family:system-ui,sans-serif}',
        '#plexo-widget-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:16px}',
        '#plexo-widget-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth}',
        '.plexo-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;font-family:system-ui,sans-serif;word-break:break-word}',
        '.plexo-msg.user{align-self:flex-end;background:#6366f1;color:#fff;border-bottom-right-radius:4px}',
        '.plexo-msg.agent{align-self:flex-start;background:#27272a;color:#e4e4e7;border-bottom-left-radius:4px}',
        '.plexo-msg.typing{color:#71717a;font-style:italic;background:#27272a}',
        '#plexo-widget-input-row{display:flex;gap:8px;padding:10px;border-top:1px solid #3f3f46;background:#09090b}',
        '#plexo-widget-input{flex:1;border:1px solid #3f3f46;background:#18181b;color:#f4f4f5;border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:system-ui,sans-serif}',
        '#plexo-widget-input:focus{border-color:#6366f1}',
        '#plexo-widget-send{background:#6366f1;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:system-ui,sans-serif}',
        '#plexo-widget-send:disabled{opacity:.5;cursor:not-allowed}',
    ].join('');
    document.head.appendChild(style);

    // Build DOM
    var btn = document.createElement('button');
    btn.id = 'plexo-widget-btn';
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.setAttribute('aria-label', 'Open chat');

    var panel = document.createElement('div');
    panel.id = 'plexo-widget-panel';
    panel.innerHTML = '<div id="plexo-widget-header"><div id="plexo-widget-avatar">\ud83e\udd16</div><span>' + siteName + '</span></div><div id="plexo-widget-msgs"></div><div id="plexo-widget-input-row"><input id="plexo-widget-input" placeholder="Ask anything\u2026" /><button id="plexo-widget-send">Send</button></div>';

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    var msgs = document.getElementById('plexo-widget-msgs');
    var input = document.getElementById('plexo-widget-input');
    var send = document.getElementById('plexo-widget-send');
    var open = false;
    var sessionId = 'ws-' + Math.random().toString(36).slice(2);

    btn.onclick = function() {
        open = !open;
        panel.classList.toggle('open', open);
        if (open && msgs.children.length === 0) addMsg('agent', 'Hi! I\\'m ' + siteName + '. How can I help you today?');
        if (open) setTimeout(function(){ input.focus(); }, 200);
    };

    function addMsg(role, text) {
        var d = document.createElement('div');
        d.className = 'plexo-msg ' + role;
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
        return d;
    }

    async function sendMsg() {
        var text = input.value.trim();
        if (!text) return;
        input.value = '';
        send.disabled = true;
        addMsg('user', text);
        var typing = addMsg('typing', 'Thinking\u2026');
        try {
            var r = await fetch(apiBase + '/api/chat/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: wsId, message: text, sessionId: sessionId }),
            });
            if (!r.ok) { typing.textContent = 'Error sending message.'; return; }
            var d = await r.json();
            var taskId = d.taskId;
            var reply = await fetch(apiBase + '/api/chat/reply/' + taskId);
            var rd = await reply.json();
            typing.textContent = rd.reply || 'Done.';
            typing.className = 'plexo-msg agent';
        } catch(e) {
            typing.textContent = 'Connection error. Please try again.';
        } finally {
            send.disabled = false;
            input.focus();
        }
    }

    send.onclick = sendMsg;
    input.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } };
})();
`.trim()

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(script)
})
