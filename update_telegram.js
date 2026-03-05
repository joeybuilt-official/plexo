const fs = require('fs')

let code = fs.readFileSync('apps/api/src/routes/telegram.ts', 'utf-8')

// Add pendingActions map
if (!code.includes('const pendingActions')) {
    code = code.replace(
        "export const telegramRouter: RouterType = Router()",
        "export const telegramRouter: RouterType = Router()\n\nconst pendingActions = new Map<string, { workspaceId: string, intent: 'TASK' | 'PROJECT', description: string, from?: string, messageId?: number }>()"
    )
}

// Add ulid and sprints import
if (!code.includes('import { ulid }')) {
    code = code.replace("import { channels } from '@plexo/db'", "import { channels, sprints } from '@plexo/db'\nimport { ulid } from 'ulid'")
}


// Replace CLASSIFY_SYSTEM
code = code.replace(
    /const CLASSIFY_SYSTEM \= `[\s\S]*?CONVERSATION.`/m,
    `const CLASSIFY_SYSTEM = \`You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK, PROJECT, or CONVERSATION.

TASK: The user is explicitly asking to start a clear, immediate, actionable task. Or the user is confirming (e.g. "yes", "do it") a previous proposal to create a task.
PROJECT: The user is explicitly asking to start a large, multi-step goal requiring planning (e.g., "Build a new features"). Or the user is confirming a proposal to create a project.
CONVERSATION: Vague requests, troubleshooting, requests needing clarification, greetings, checks, small talk, or rejecting proposals.

Reply with ONLY one word: TASK, PROJECT, or CONVERSATION.\``
)

// Update the handling block inside handleUpdate
const handleBlockContent = `
    if (intent === 'CONVERSATION') {
        const result = await chatWithAI(
            workspaceId,
            history,
            'You are Plexo, a helpful AI agent. Keep replies concise and friendly. '
            + 'If the user proposes a single distinct action, tell them you can execute it as a task and ask for confirmation. '
            + 'If the user proposes a large conceptual goal, tell them you can create a Project for it and ask for confirmation. '
            + 'If they ask for troubleshooting, help, or advice, ask clarifying questions first and do not rush to create tasks. '
            + 'Only agree to start a task or project when the scope is clear.'
        )
        // Log internal errors server-side; expose only neutral message to user
        if (result.error) {
            logger.warn({ chatId, workspaceId, error: result.error }, 'AI error during Telegram conversation')
        }
        const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
        addToHistory(chatId, 'assistant', replyText)
        await sendMessage(chatId, replyText)
        return
    }

    // TASK or PROJECT: Send inline keyboard
    const actionId = 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    pendingActions.set(actionId, { 
        workspaceId, 
        intent, 
        description: text, 
        from: msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
        messageId: msg.message_id
    })

    if (_botToken) {
        await fetch(\`\${TELEGRAM_API}\${_botToken}/sendMessage\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId, 
                text: \`Ready to create a **\${intent === 'TASK' ? 'Task' : 'Project'}**.\\n\\nDescription: _\${text.slice(0, 100)}\${text.length > 100 ? '...' : ''}_\\n\\nProceed?\`, 
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: \`✅ Confirm\`, callback_data: \`confirm_\${actionId}\` },
                        { text: '❌ Cancel', callback_data: \`cancel_\${actionId}\` }
                    ]]
                }
            }),
        })
    }
`

code = code.replace(
    /    if \(intent === 'CONVERSATION' \|\| intent === 'PROJECT'\) \{[\s\S]*?catch \(err\) \{\n        logger.error\(\{ err, chatId \}, 'Failed to queue Telegram task'\)\n        await sendMessage\(chatId, '❌ Failed to queue task\. Please try again\.'\)\n    \}\n/m,
    handleBlockContent + '\n'
)

// Add callback_query processing to the top of handleUpdate
const cbLogic = `
async function handleUpdate(update: TelegramUpdate): Promise<void> {
    // Check for callback_query (inline buttons)
    if (update.callback_query) {
        const cb = update.callback_query
        const chatId = String(cb.message?.chat.id)
        const data = cb.data
        if (data.startsWith('confirm_') || data.startsWith('cancel_')) {
            const isConfirm = data.startsWith('confirm_')
            const actionId = data.split('_')[1]
            const action = pendingActions.get(actionId)

            if (!action) {
                await sendMessage(chatId, '❌ This action has expired or was already handled.')
                return
            }
            pendingActions.delete(actionId)

            // Remove the inline keyboard (clean up)
            if (_botToken && cb.message) {
                await fetch(\`\${TELEGRAM_API}\${_botToken}/editMessageReplyMarkup\`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: chatId,
                        message_id: cb.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }),
                })
            }

            if (!isConfirm) {
                await sendMessage(chatId, 'Action cancelled.')
                return
            }

            // Execute the action
            if (action.intent === 'TASK') {
                try {
                    const taskId = await pushTask({
                        workspaceId: action.workspaceId,
                        type: 'automation',
                        source: 'telegram',
                        context: {
                            description: action.description,
                            channel: 'telegram',
                            chatId,
                            from: action.from ?? 'Unknown',
                            messageId: action.messageId,
                        },
                        priority: 2,
                    })

                    await sendMessage(chatId, \`⏳ Queueing Task… _(\${taskId.slice(0, 8)})_\`)

                    const unsub = onAgentEvent((event) => {
                        if (event.taskId !== taskId) return
                        if (event.type === 'task_complete') {
                            unsub()
                            const result = (event.result as string | undefined) ?? 'Done.'
                            sendMessage(chatId, \`✅ \${result}\`).catch(() => null)
                            addToHistory(chatId, 'assistant', result)
                        } else if (event.type === 'task_failed' || event.type === 'task_blocked') {
                            unsub()
                            const reason = (event.reason as string | undefined) ?? 'Unknown error'
                            sendMessage(chatId, \`❌ \${reason}\`).catch(() => null)
                        }
                    })
                    setTimeout(() => unsub(), 5 * 60 * 1000)

                    emitToWorkspace(action.workspaceId, { type: 'task_queued_via_telegram', taskId, chatId, text: action.description.slice(0, 200) })
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to queue Telegram task')
                    await sendMessage(chatId, '❌ Failed to queue task. Please try again.')
                }
            } else if (action.intent === 'PROJECT') {
                try {
                    const id = ulid()
                    const [sprint] = await db.insert(sprints).values({
                        id,
                        workspaceId: action.workspaceId,
                        request: action.description,
                        category: 'general',
                        status: 'planning',
                        metadata: {},
                    }).returning()
                    await sendMessage(chatId, \`✅ Project created: _\${sprint!.id}_. You can view it in the dashboard.\`)
                } catch (err) {
                    logger.error({ err, chatId }, 'Failed to create Telegram project')
                    await sendMessage(chatId, '❌ Failed to create project. Please try again.')
                }
            }
            return
        }
    }
    
    // Regular text message
    `

code = code.replace("async function handleUpdate(update: TelegramUpdate): Promise<void> {", cbLogic)

// Add callback_query to interface
code = code.replace(
    "    update_id: number\n    message?: {",
    "    update_id: number\n    message?: {\n        message_id: number\n        from: { id: number; username?: string; first_name?: string }\n        chat: { id: number; type: string }\n        date: number\n        text?: string\n    }\n    callback_query?: {\n        id: string\n        from: { id: number; username?: string; first_name?: string }\n        message?: { message_id: number; chat: { id: number; type: string } }\n        data: string\n    }\n"
)
// remove duplicated message?
code = code.replace(
    "    update_id: number\n    message?: {\n        message_id: number\n        from: { id: number; username?: string; first_name?: string }\n        chat: { id: number; type: string }\n        date: number\n        text?: string\n    }\n    callback_query?: {\n        id: string\n        from: { id: number; username?: string; first_name?: string }\n        message?: { message_id: number; chat: { id: number; type: string } }\n        data: string\n    }\n\n    message?: {",
    "    update_id: number\n    callback_query?: {\n        id: string\n        from: { id: number; username?: string; first_name?: string }\n        message?: { message_id: number; chat: { id: number; type: string } }\n        data: string\n    }\n    message?: {"
)


fs.writeFileSync('apps/api/src/routes/telegram.ts', code)
