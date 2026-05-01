/**
 * scripts/migrate.js
 *
 * Applies all SQL migration files in infra/db/migrations/ to pgvector.
 * Files are applied in filename order (001_, 002_, 003_, ...) and are
 * idempotent — all migrations use CREATE TABLE IF NOT EXISTS.
 *
 * Usage:
 *   node scripts/migrate.js
 *
 * Requires:
 *   - Docker dev stack running: docker compose -f infra/docker-compose.dev.yml up -d
 *   - .env file at repo root (copy from .env.example)
 */

import 'dotenv/config'
import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const { Client } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const client = new Client({
  host:     process.env.PGHOST     ?? 'localhost',
  port:     parseInt(process.env.PGPORT ?? '5432', 10),
  database: process.env.PGDATABASE ?? 'amphion',
  user:     process.env.PGUSER     ?? 'amphion',
  password: process.env.PGPASSWORD ?? 'changeme',
})

async function run () {
  await client.connect()
  console.log('[migrate] connected to pgvector')

  const migrationsDir = path.join(__dirname, '..', 'infra', 'db', 'migrations')
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  if (files.length === 0) {
    console.log('[migrate] no migration files found')
    return
  }

  for (const file of files) {
    const filePath = path.join(migrationsDir, file)
    const sql = fs.readFileSync(filePath, 'utf8')
    console.log(`[migrate] applying ${file}...`)
    try {
      await client.query(sql)
      console.log(`[migrate] ✓ ${file}`)
    } catch (err) {
      console.error(`[migrate] ✗ ${file}: ${err.message}`)
      throw err
    }
  }

  console.log('[migrate] all migrations applied')
}

run()
  .catch(err => {
    console.error('[migrate] fatal:', err.message)
    process.exit(1)
  })
  .finally(() => client.end())
