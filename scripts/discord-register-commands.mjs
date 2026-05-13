#!/usr/bin/env node
/**
 * Discord slash command registration.
 * Run once (or on command changes) to register /task with Discord.
 *
 * Usage:
 *   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/discord-register-commands.js
 *
 * For guild-specific registration (instant, use for dev):
 *   DISCORD_GUILD_ID=<guild_id> ... node scripts/discord-register-commands.js
 *
 * For global registration (takes up to 1 hour to propagate):
 *   Omit DISCORD_GUILD_ID
 */

const applicationId = process.env.DISCORD_APPLICATION_ID
const botToken = process.env.DISCORD_BOT_TOKEN
const guildId = process.env.DISCORD_GUILD_ID

if (!applicationId || !botToken) {
    console.error('❌ DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required')
    process.exit(1)
}

const commands = [
    {
        name: 'task',
        description: 'Create a task for the Plexo agent to execute',
        options: [
            {
                type: 3, // STRING
                name: 'description',
                description: 'What should the agent do?',
                required: true,
            },
        ],
    },
]

const endpoint = guildId
    ? `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${applicationId}/commands`

console.log(`Registering commands at: ${endpoint}`)

const res = await fetch(endpoint, {
    method: 'PUT',
    headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
})

if (!res.ok) {
    const text = await res.text()
    console.error(`❌ Failed: ${res.status} ${text}`)
    process.exit(1)
}

const registered = await res.json()
console.log('✅ Registered commands:')
for (const cmd of registered) {
    console.log(`  /${cmd.name} (ID: ${cmd.id})`)
}
