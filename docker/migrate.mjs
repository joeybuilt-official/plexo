import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error('[migrate] DATABASE_URL not set');
    process.exit(1);
}

const migrationsFolder = process.env.MIGRATIONS_DIR ?? '/app/drizzle';

console.log('[migrate] Running Drizzle migrations...');
const pool = new Pool({ connectionString });
const db = drizzle(pool);
await migrate(db, { migrationsFolder });
await pool.end();
console.log('[migrate] Done.');
