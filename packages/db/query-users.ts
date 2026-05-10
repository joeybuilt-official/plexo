import { db, users } from './src/index.js';
async function run() {
    const allUsers = await db.select().from(users);
    console.log(JSON.stringify(allUsers, null, 2));
}
run();
