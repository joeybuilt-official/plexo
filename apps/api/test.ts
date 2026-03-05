import { db, eq } from '@plexo/db'
import { users } from '@plexo/db'

async function main() {
    const res = await db.select().from(users).where(eq(users.email, 'admin@plexo.dev'))
    console.log(JSON.stringify(res, null, 2))
    process.exit(0)
}
main()
