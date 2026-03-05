const fs = require('fs')

let code = fs.readFileSync('apps/api/src/routes/chat.ts', 'utf-8')

// Add ulid and sprints import
if (!code.includes('import { ulid }')) {
    code = code.replace("import { workspaces, tasks, taskSteps } from '@plexo/db'", "import { workspaces, tasks, taskSteps, sprints } from '@plexo/db'\nimport { ulid } from 'ulid'")
}

// Update CLASSIFY_SYSTEM
code = code.replace("TASK: Clear", "TASK: Clear") // It's already there?

// We want intent to be 'TASK' | 'PROJECT' | 'CONVERSATION' and create Execute endpoint.
fs.writeFileSync('apps/api/src/routes/chat.ts', code)
