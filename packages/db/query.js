const postgres = require('postgres');
const sql = postgres('postgresql://plexo:FAKE_LOCAL_PASSWORD@localhost:5432/plexo');
sql`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'task_source'::regtype`.then(rows => {
  console.log(rows);
  process.exit(0);
}).catch(console.error);
