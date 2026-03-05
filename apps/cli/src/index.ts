#!/usr/bin/env node
/**
 * @plexo/cli — terminal interface to your Plexo instance
 *
 * npx plexo@latest [command]
 * PLEXO_HOST / PLEXO_TOKEN / PLEXO_WORKSPACE env vars for CI/CD
 */
import { Command } from 'commander'
import pkg from '../package.json' with { type: 'json' }
import { registerAuth } from './commands/auth.js'
import { registerTask } from './commands/task.js'
import { registerSprint } from './commands/sprint.js'
import { registerCron } from './commands/cron.js'
import { registerConnection } from './commands/connection.js'
import { registerPlugin } from './commands/plugin.js'
import { registerMemory } from './commands/memory.js'
import { registerLogs } from './commands/logs.js'
import { registerStatus } from './commands/status.js'
import { registerConfig } from './commands/config.js'

const program = new Command()
    .name('plexo')
    .description('Plexo CLI — control your AI agent from the terminal')
    .version(pkg.version)
    .option('--profile <name>', 'Config profile to use')
    .option('--verbose', 'Show request/response details')
    .option('--quiet', 'Suppress all output except errors and final result')

registerAuth(program)
registerTask(program)
registerSprint(program)
registerCron(program)
registerConnection(program)
registerPlugin(program)
registerMemory(program)
registerLogs(program)
registerStatus(program)
registerConfig(program)

// Global error handler
program.hook('postAction', () => {
    // Intentionally left blank — command handlers call process.exit() on failure
})

process.on('uncaughtException', (err) => {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
})

process.on('unhandledRejection', (reason) => {
    process.stderr.write(`Error: ${reason}\n`)
    process.exit(1)
})

program.parse(process.argv)
