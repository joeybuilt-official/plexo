/**
 * Pino logger for the MCP server.
 * Structured JSON in production, pretty-print in dev.
 */
import pino from 'pino'

export const logger = pino({
    name: 'plexo-mcp',
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
        paths: ['token', 'rawToken', 'password', 'apiKey', 'credentials'],
        censor: '[REDACTED]',
    },
})
