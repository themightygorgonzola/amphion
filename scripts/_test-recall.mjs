// Quick test to reproduce the text = text[] error
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Simulate what the agent does
process.env.PGHOST = 'localhost'
process.env.PGPORT = '5432'
process.env.PGDATABASE = 'amphion'
process.env.PGUSER = 'amphion'
process.env.PGPASSWORD = 'changeme'
process.env.OLLAMA_HOST = 'http://localhost:11434'
process.env.OLLAMA_MODEL_EMBED = 'nomic-embed-text'
process.env.SQLITE_PATH = path.resolve(__dirname, '../data/memory.db')

const mod = await import(new URL('../agents/knowledge/index.js', import.meta.url))
const KnowledgeAgent = mod.KnowledgeAgent

const agent = new KnowledgeAgent()

try {
  const result = await agent._recall({ 
    topic: 'Washington State laws on exotic pets large cats wolves venomous reptiles',
    corpus: null,
    k: 8
  })
  console.log('SUCCESS')
  const parsed = JSON.parse(result)
  console.log('Items:', parsed.results?.length)
  for (const r of (parsed.results ?? []).slice(0, 3)) {
    console.log(' -', r.title, '|', r.section_header)
  }
} catch (err) {
  console.error('ERROR:', err.message)
  console.error('Stack:', err.stack?.split('\n').slice(0, 10).join('\n'))
  if (err.position) console.error('SQL position:', err.position)
}
