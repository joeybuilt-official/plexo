import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import path from 'path'
import { logger } from '../lib/logger'

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL
  })
  const db = drizzle(pool)
  
  const migrationsFolder = path.join(__dirname, 'migrations')
  
  logger.info(`Running migrations from ${migrationsFolder}`)
  try {
    await migrate(db, { migrationsFolder })
    logger.info('Migrations complete')
  } catch (error) {
    logger.error({ error }, 'Migrations failed')
    process.exit(1)
  }
  process.exit(0)
}

main()
