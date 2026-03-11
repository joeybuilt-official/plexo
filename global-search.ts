
import postgres from 'postgres'

async function main() {
    const url = 'postgresql://plexo:plexo-dev-local-only@localhost:5432/plexo'
    const sql = postgres(url)
    const search = "Let's plan a marketing campaign"
    try {
        const conversationsCount = await sql`SELECT count(*) FROM conversations;`
        console.log('Conversations count:', conversationsCount)
        
        const matches = await sql`SELECT table_name, column_name 
                                  FROM information_schema.columns 
                                  WHERE table_schema = 'public' 
                                  AND data_type IN ('text', 'character varying');`
        
        for (const m of matches) {
            try {
                const results = await sql.unsafe(`SELECT count(*) FROM ${m.table_name} WHERE ${m.column_name} ILIKE '%${search}%'`)
                if (results[0].count > 0) {
                    console.log(`Found in table ${m.table_name}, column ${m.column_name}: ${results[0].count} matches`)
                    const data = await sql.unsafe(`SELECT ${m.column_name} FROM ${m.table_name} WHERE ${m.column_name} ILIKE '%${search}%' LIMIT 1`)
                    console.log('Sample:', data[0][m.column_name])
                }
            } catch (e) {}
        }
    } catch (err) {
        console.error('Failed:', err)
    } finally {
        await sql.end()
    }
}

main()
