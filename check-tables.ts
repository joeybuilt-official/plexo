
import postgres from 'postgres'

async function main() {
    const url = 'postgresql://plexo:plexo-dev-local-only@localhost:5432/plexo'
    const sql = postgres(url)
    try {
        const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`
        console.log('Tables:', tables)
        for (const table of tables) {
            const count = await sql`SELECT count(*) FROM ${sql(table.table_name)};`
            console.log(`Table ${table.table_name}: ${count[0].count}`)
        }
    } catch (err) {
        console.error('Failed:', err)
    } finally {
        await sql.end()
    }
}

main()
