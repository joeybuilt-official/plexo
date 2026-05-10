import { db, sessionLogs, eq, and } from './src/index';

async function run() {
    const logs = await db.select().from(sessionLogs).where(eq(sessionLogs.personaId, 'new-user')).orderBy(sessionLogs.createdAt);
    console.log(JSON.stringify(logs, null, 2));
}
run();
