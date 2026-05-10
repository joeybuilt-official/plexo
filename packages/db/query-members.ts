import { db, workspaceMembers } from './src/index';
async function run() {
    const rows = await db.select().from(workspaceMembers);
    console.log(JSON.stringify(rows, null, 2));
}
run();
