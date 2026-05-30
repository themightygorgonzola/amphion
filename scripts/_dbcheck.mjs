import pg from 'pg'
const p = new pg.Pool({host:'localhost',port:5432,database:'amphion',user:'amphion',password:'changeme'})
const [d,c,dom] = await Promise.all([
  p.query('SELECT COUNT(*) FROM resources'),
  p.query('SELECT COUNT(*) FROM chunks'),
  p.query(`
    SELECT co.domain, COALESCE(co.slug, co.domain) AS corpus, COUNT(*) AS resources
    FROM resources r
    LEFT JOIN corpora co ON co.id = r.corpus_id
    GROUP BY co.domain, co.slug
    ORDER BY co.domain, COALESCE(co.slug, co.domain)
  `),
])
console.log('Resources:', d.rows[0].count)
console.log('Chunks:   ', c.rows[0].count)
console.log('By corpus:', dom.rows)
await p.end()
