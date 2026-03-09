#!/bin/bash
set -e
FILE='/home/dustin/dev/plexo/apps/web/src/app/(dashboard)/chat/page.tsx'

# Step 1: Remove lines 343-368 (code mode block misplaced in VoiceWaveform)
awk 'NR>=343 && NR<=368 { next } { print }' "$FILE" > /tmp/chat_step1.tsx

echo "After VoiceWaveform fix: $(wc -l < /tmp/chat_step1.tsx) lines"

# Step 2: Insert code mode block before ChatContent closing brace
# File ends with:  "    )\n}\n" (last 3 text lines are:  "    )", "}", "")
# Use head -n -2 to strip last non-blank lines, add the new content

head -n -2 /tmp/chat_step1.tsx > /tmp/chat_step2.tsx

cat >> /tmp/chat_step2.tsx << 'CODEMODE'
    )

    if (codeMode) {
        return (
            <CodeModeShell
                workspaceId={WS_ID}
                taskId={lastRunningTaskId}
                isTaskRunning={!!lastRunningTaskId}
                context={codeModeContext}
                onRepoSelect={(sel) => {
                    setCodeModeContext({ repo: sel.repo, branch: sel.branch, isNew: sel.isNew })
                }}
                onRerunTest={(testNames) => {
                    const text = testNames.length === 1
                        ? `Re-run the failing test: ${testNames[0]}`
                        : `Re-run these failing tests: ${testNames.join(', ')}`
                    void sendMessageWith(text)
                }}
                onClose={() => setCodeMode(false)}
            >
                {chatPanel}
            </CodeModeShell>
        )
    }

    return chatPanel
}
CODEMODE

echo "After insertion: $(wc -l < /tmp/chat_step2.tsx) lines"
grep -n "if (codeMode)\|return chatPanel" /tmp/chat_step2.tsx

cp /tmp/chat_step2.tsx "$FILE"
echo "Done!"
