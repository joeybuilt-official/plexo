
import postgres from 'postgres'

async function main() {
    const url = 'postgresql://plexo:plexo-dev-local-only@localhost:5432/postgres' // Connect to postgres default DB
    const sql = postgres(url)
    try {
        const dbs = await sql`SELECT datname FROM pg_database WHERE datistemplate = false;`
        console.log('Databases:', dbs)
    } catch (err) {
        console.error('Failed:', err)
    } finally {
        await sql.end()
    }
}

main()
