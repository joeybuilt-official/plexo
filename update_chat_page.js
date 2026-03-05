const fs = require('fs')

let code = fs.readFileSync('apps/web/src/app/(dashboard)/chat/page.tsx', 'utf-8')

code = code.replace(
    "status?: 'queued' | 'running' | 'complete' | 'failed' | 'pending'",
    "status?: 'queued' | 'running' | 'complete' | 'failed' | 'pending' | 'confirm_action'\n    intent?: 'TASK' | 'PROJECT'\n    actionDescription?: string"
)

// In sendMessageWith:
/*
            // Direct conversational reply — no polling needed
            if (data.status === 'complete' && data.reply) {
*/
code = code.replace(
    "// Direct conversational reply — no polling needed",
    `// Action needs confirmation
            if (data.status === 'confirm_action' && data.intent && data.description) {
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? {
                        ...m,
                        status: 'confirm_action',
                        content: 'Please confirm creation of this ' + data.intent.toLowerCase() + ':',
                        intent: data.intent as 'TASK' | 'PROJECT',
                        actionDescription: data.description
                    } : m
                ))
                return
            }

            // Direct conversational reply — no polling needed`
)

// Add the execute confirmed action to ChatContent:
const handlerStr = `
    async function executeConfirmedAction(msgId: string, intent: 'TASK' | 'PROJECT', description: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'queued', content: '', intent: undefined, actionDescription: undefined } : m
        ))
        try {
            const res = await fetch(\`\${API}/api/v1/chat/execute-action\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, intent, description, sessionId: sessionId.current }),
            })
            if (!res.ok) throw new Error('Failed to execute')
            const data = await res.json() as { taskId?: string; sprintId?: string; status?: string }
            if (data.taskId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, taskId: data.taskId, status: 'running' } : m
                ))
                await pollReply(data.taskId, msgId)
            } else if (data.sprintId) {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, status: 'complete', content: '' } : m
                ))
                window.location.href = \`/projects/\${data.sprintId}\`
            }
        } catch {
            setMessages((prev) => prev.map((m) =>
                m.id === msgId ? { ...m, status: 'failed', content: 'Failed to start action.', intent: undefined, actionDescription: undefined } : m
            ))
        }
    }

    function cancelAction(msgId: string) {
        setMessages((prev) => prev.map((m) =>
            m.id === msgId ? { ...m, status: 'complete', content: 'Action cancelled.', intent: undefined, actionDescription: undefined } : m
        ))
    }
`

code = code.replace("async function sendMessageWith(text: string) {", handlerStr + "\n    async function sendMessageWith(text: string) {")

// Render logic:
const renderLogic = `
                                ) : msg.status === 'failed' ? (
                                    <div className="flex items-center gap-1.5">
                                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                                        {msg.content || 'Failed.'}
                                    </div>
                                ) : msg.status === 'confirm_action' && msg.intent ? (
                                    <div className="flex flex-col gap-2">
                                        <span className="font-semibold text-zinc-100">{msg.content}</span>
                                        <span className="text-sm text-zinc-300 italic">"{msg.actionDescription}"</span>
                                        <div className="flex items-center gap-2 mt-2">
                                            <button
                                                onClick={() => executeConfirmedAction(msg.id, msg.intent!, msg.actionDescription!)}
                                                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                                            >
                                                Confirm {msg.intent === 'TASK' ? 'Task' : 'Project'}
                                            </button>
                                            <button
                                                onClick={() => cancelAction(msg.id)}
                                                className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-zinc-600 transition-colors"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                ) : (
`
code = code.replace(
    /                                \) : msg.status === 'failed' \? \(\n                                    <div className="flex items-center gap-1.5">\n                                        <XCircle className="h-3.5 w-3.5 shrink-0" \/>\n                                        \{msg.content \|\| 'Failed.'\}\n                                    <\/div>\n                                \) : \(/g,
    renderLogic
)

fs.writeFileSync('apps/web/src/app/(dashboard)/chat/page.tsx', code)
