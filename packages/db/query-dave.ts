import { db, sessionLogs, eq } from './src/index';
async function run() {
    const logs = await db.select().from(sessionLogs).where(eq(sessionLogs.personaId, 'dark-mode-dave')).orderBy(sessionLogs.createdAt).limit(50);
    console.log(JSON.stringify(logs, null, 2));
}
run();
