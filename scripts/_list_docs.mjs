import pg from 'pg'
const p = new pg.Pool({host:'localhost',port:5432,database:'amphion',user:'amphion',password:'changeme'})
const r = await p.query(`
	SELECT r.title, co.domain, COALESCE(co.slug, co.domain) AS corpus
	FROM resources r
	LEFT JOIN corpora co ON co.id = r.corpus_id
	ORDER BY co.domain, r.title
`)
for (const row of r.rows) console.log(`[${row.domain}] ${row.corpus} :: ${row.title}`)
await p.end()
