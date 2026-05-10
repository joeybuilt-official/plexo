import { db, users } from './src/index.js';
import { eq } from 'drizzle-orm';

async function check() {
    try {
        const u = await db.select().from(users).where(eq(users.email, 'test@example.com'));
        console.log('User check result:', JSON.stringify(u, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('Check failed', e);
        process.exit(1);
    }
}
check();
