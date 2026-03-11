
import { db, desc } from './packages/db/src/index.ts'
import { conversations } from './packages/db/src/schema.ts'

async function main() {
    console.log(`Fetching last 20 conversations...`)
    try {
        const results = await db.select().from(conversations)
            .orderBy(desc(conversations.createdAt))
            .limit(20)

        // Map to simpler format for display
        const simplified = results.map(r => ({
            id: r.id,
            source: r.source,
            message: r.message.substring(0, 50),
            reply: r.reply?.substring(0, 50),
            createdAt: r.createdAt
        }))

        console.log(JSON.stringify(simplified, null, 2))
    } catch (err) {
        console.error('Query failed:', err)
    }
}

main()
