import http from 'node:http'

const SESSION = 'test-quality-' + Date.now()

function query (message) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: 'localhost', port: 3000, path: '/query', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }
    }, res => {
      let tokens = '', steps = [], ticket = null
      let buf = ''
      res.on('data', chunk => {
        buf += chunk.toString()
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const e = JSON.parse(line.slice(6))
              if (e.type === 'token') tokens += e.token
              if (e.type === 'agent_step') steps.push(`  step${e.data?.step ?? e.step} ${e.data?.tool ?? e.tool}(${JSON.stringify(e.data?.args ?? e.args)}) -> ${e.data?.resultCount ?? e.resultCount ?? 0} results  [${(e.data?.reasoning ?? e.reasoning ?? '').slice(0, 80)}]`)
              if (e.type === 'ticket') ticket = e.data
            } catch {}
          }
        }
      })
      res.on('end', () => resolve({ tokens: tokens.trim(), steps, ticket }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(JSON.stringify({ message, sessionId: SESSION, userId: 'default' }))
    req.end()
  })
}

const queries = [
  'hey can you search for files about something called amphion and tell me its root directory?',
  'nice can you tell me what the project is about',
  'wow okay can you tell me where the source code lives',
  'Yes please look through that folder we found for the source',
  'Search deeper please tell me when you have found it all',
]

for (const q of queries) {
  process.stdout.write('\n' + '='.repeat(70) + '\n')
  process.stdout.write('Q: ' + q + '\n')
  const start = Date.now()
  try {
    const r = await query(q)
    const ms = Date.now() - start
    const mode = r.ticket?.tool_mode ?? '?'
    const domains = JSON.stringify(r.ticket?.domains ?? [])
    process.stdout.write(`tool_mode=${mode}  domains=${domains}  ${ms}ms\n`)
    if (r.steps.length) process.stdout.write('Steps:\n' + r.steps.join('\n') + '\n')
    const resp = r.tokens.slice(0, 500)
    process.stdout.write('Response: ' + resp + (r.tokens.length > 500 ? '...' : '') + '\n')
  } catch (e) {
    process.stdout.write('ERROR: ' + e.message + '\n')
  }
}
process.stdout.write('\nDONE\n')
