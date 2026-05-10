import { db, sessionLogs } from './src/index.js';
import { desc, eq } from 'drizzle-orm';

async function run() {
    try {
        const personaId = process.argv[2] || 'new-user';
        const latest = await db.select().from(sessionLogs)
            .where(eq(sessionLogs.personaId, personaId))
            .orderBy(desc(sessionLogs.createdAt))
            .limit(1);
        
        if (latest.length === 0) {
            console.log('No logs found for persona:', personaId);
            process.exit(0);
        }

        const sessionId = latest[0].sessionId;
        const logs = await db.select().from(sessionLogs)
            .where(eq(sessionLogs.sessionId, sessionId))
            .orderBy(desc(sessionLogs.createdAt));
        
        console.log('Logs for session:', sessionId);
        console.log(JSON.stringify(logs, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('Logs query failed', e);
        process.exit(1);
    }
}
run();
