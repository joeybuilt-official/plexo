import { db, sessionLogs } from './src/index.js';
import { desc, ne } from 'drizzle-orm';

async function run() {
    try {
        const logs = await db.select()
            .from(sessionLogs)
            .where(ne(sessionLogs.eventType, 'page_view'))
            .orderBy(desc(sessionLogs.createdAt))
            .limit(50);
        console.log(JSON.stringify(logs, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('Logs query failed', e);
        process.exit(1);
    }
}
run();
