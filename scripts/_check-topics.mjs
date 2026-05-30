import pg from 'pg'
const p = new pg.Pool({ host: 'localhost', port: 5432, database: 'amphion', user: 'amphion', password: 'changeme' })

// 1. Check what titles exist for the failing topics
const { rows: titleRows } = await p.query(`
  SELECT DISTINCT r.title
  FROM resources r
  JOIN corpora co ON co.id = r.corpus_id
  WHERE co.domain = 'legal'
  AND (
    r.title ILIKE '%title 69%'
    OR r.title ILIKE '%title 77%'
    OR r.title ILIKE '%77.%'
    OR r.title ILIKE '%69.%'
    OR r.title ILIKE '%49.%'
    OR r.title ILIKE '%drug test%'
    OR r.title ILIKE '%fishing%'
    OR r.title ILIKE '%28A.150%'
    OR r.title ILIKE '%28A.165%'
    OR r.title ILIKE '%28A.500%'
    OR r.title ILIKE '%school fund%'
  )
  ORDER BY r.title
  LIMIT 40
`)
console.log('=== Relevant RCW chapters in DB ===')
console.log(titleRows.map(r => r.title).join('\n') || '(none found)')

// 2. Check if there are ANY chunks mentioning employer drug testing
const { rows: drugRows } = await p.query(`
  SELECT c.chunk_id, r.title, c.section_header, LEFT(c.content, 200) as preview
  FROM chunks c
  JOIN resources r ON r.id = c.resource_id
  JOIN corpora co ON co.id = r.corpus_id
  WHERE co.domain = 'legal'
  AND c.content ILIKE '%drug test%'
  LIMIT 10
`)
console.log('\n=== Chunks mentioning drug test ===')
console.log(JSON.stringify(drugRows, null, 2))

// 3. Check recreational fishing / catch limits
const { rows: fishRows } = await p.query(`
  SELECT c.chunk_id, r.title, c.section_header, LEFT(c.content, 200) as preview
  FROM chunks c
  JOIN resources r ON r.id = c.resource_id
  JOIN corpora co ON co.id = r.corpus_id
  WHERE co.domain = 'legal'
  AND (c.content ILIKE '%recreational%fishing%' OR c.content ILIKE '%catch limit%' OR c.section_header ILIKE '%77.15%')
  LIMIT 10
`)
console.log('\n=== Chunks mentioning recreational fishing / catch limits ===')
console.log(JSON.stringify(fishRows, null, 2))

// 4. Check school funding
const { rows: schoolRows } = await p.query(`
  SELECT c.chunk_id, r.title, c.section_header, LEFT(c.content, 200) as preview
  FROM chunks c
  JOIN resources r ON r.id = c.resource_id
  JOIN corpora co ON co.id = r.corpus_id
  WHERE co.domain = 'legal'
  AND (c.section_header ILIKE '%28A.150%' OR c.content ILIKE '%per-pupil%' OR c.content ILIKE '%basic education funding%')
  LIMIT 10
`)
console.log('\n=== Chunks mentioning school funding ===')
console.log(JSON.stringify(schoolRows, null, 2))

await p.end()
