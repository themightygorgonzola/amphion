const SID = 'pool-test-' + Date.now()

async function q(msg) {
  const res = await fetch('http://127.0.0.1:3000/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: msg, sessionId: SID }),
  })
  let out = '', intent = '', domains = [], len = ''
  for await (const chunk of res.body) {
    for (const line of Buffer.from(chunk).toString().split('\n').filter(l => l.startsWith('data:'))) {
      try {
        const d = JSON.parse(line.slice(5))
        if (d.token) out += d.token
        if (d.data?.intent) { intent = d.data.intent; domains = d.data.domains; len = d.data.responseLength }
      } catch {}
    }
  }
  return { out, intent, domains, len }
}

const msgs = [
  "how's it going",
  "I want to put in a swimming pool. Any problems with that legally?",
  "It's like 70 x 30 x 6 what would that look like",
]

for (const msg of msgs) {
  const { out, intent, domains, len } = await q(msg)
  console.log('\n--- Q:', msg)
  console.log('    intent:', intent, '| domains:', domains, '| length:', len)
  console.log(out)
}
