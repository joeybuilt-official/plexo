
import postgres from 'postgres'

async function main() {
    const url = 'postgresql://plexo:plexo-dev-local-only@localhost:5432/plexo'
    const sql = postgres(url)
    try {
        const rows = await sql`SELECT * FROM session_logs LIMIT 5;`
        console.log('Session Logs:', rows)
    } catch (err) {
        console.error('Failed:', err)
    } finally {
        await sql.end()
    }
}

main()
