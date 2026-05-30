const SID = 'tree-v5'

async function q(msg) {
  const res = await fetch('http://127.0.0.1:3000/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, sessionId: SID }),
  })
  let out = '', len = ''
  for await (const chunk of res.body) {
    for (const line of Buffer.from(chunk).toString().split('\n').filter(l => l.startsWith('data:'))) {
      try {
        const d = JSON.parse(line.slice(5))
        if (d.token) out += d.token
        if (d.jobTicket?.responseLength) len = d.jobTicket.responseLength
        if (d.traceId && !len) len = '(done-no-length)'
      } catch {}
    }
  }
  return { out, len }
}

const msgs = [
  'hey can you tell me what I need to be aware of before cutting down this tree on my property line',
  'Biiiig old cedar. Getting a company out tomorrow to take it down carefully as it could hit either house',
  'They take the lumber as a cost reduction for us apparently its valuable. Any worries legally?',
]

for (const msg of msgs) {
  const { out, len } = await q(msg)
  console.log('\n--- [' + len + '] ' + msg.slice(0, 70))
  console.log(out)
}
