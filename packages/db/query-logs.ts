import { db, sessionLogs } from './src/index.js';
import { desc } from 'drizzle-orm';

async function run() {
    try {
        const logs = await db.select().from(sessionLogs).orderBy(desc(sessionLogs.createdAt)).limit(20);
        console.log(JSON.stringify(logs, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('Logs query failed', e);
        process.exit(1);
    }
}
run();
