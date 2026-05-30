import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync('data/memory.db')
const rows = db.prepare("SELECT session_id, role, substr(content,1,100) as snippet, created_at FROM conversations ORDER BY created_at DESC LIMIT 30").all()
console.log(`Total recent rows: ${rows.length}`)
const sessions = [...new Set(rows.map(r => r.session_id))]
console.log(`Sessions: ${sessions.slice(0,10).join(', ')}`)
rows.forEach(r => console.log(`[${r.session_id?.slice(0,12)}] ${r.role}: ${r.snippet}`))
const count = db.prepare("SELECT COUNT(*) as n FROM conversations").get()
console.log(`\nTotal rows in DB: ${count.n}`)
