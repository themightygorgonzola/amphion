import pg from 'pg'

const pool = new pg.Pool({ host: 'localhost', port: 5432, database: 'amphion', user: 'amphion', password: 'changeme' })

const terms = ['16.52', '16.30', '16.70', '16.', 'exotic', 'animal control']
for (const t of terms) {
  const r = await pool.query('SELECT id, title FROM resources WHERE title ILIKE $1 LIMIT 5', [`%${t}%`])
  console.log(`=== ${t} ===`, r.rows.map(x => x.title))
}

await pool.end()
