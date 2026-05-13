import { db, sessionLogs, eq } from './src/index';
async function run() {
    const logs = await db.select().from(sessionLogs).where(eq(sessionLogs.eventType, 'fail')).limit(10);
    console.log(JSON.stringify(logs, null, 2));
}
run();
