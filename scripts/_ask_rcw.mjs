// scripts/_ask_rcw.mjs — test RCW retrieval via broker
async function ask(q) {
  const res = await fetch('http://127.0.0.1:3000/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: q, sessionId: 'rcw-test' })
  })
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = '', text = '', domains = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split(/\r?\n/); buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const e = JSON.parse(line.slice(6).trim())
        if (e.type === 'ticket') domains = e.data?.domains
        if (e.type === 'token') text += e.token ?? ''
      } catch {}
    }
  }
  return { domains, response: text.trim() }
}

const questions = [
  'What does RCW 9A.36.011 say? What is assault in the first degree?',
  'What does Washington state law say about landlord entry into a rental unit? What notice is required?',
  'Under Washington law, what are the degrees of murder and how are they defined?',
  'What does Washington state law say about driving under the influence — what is the legal BAC limit and what are the penalties?',
  'What is the Washington state law on wrongful termination and at-will employment?',
]

for (const q of questions) {
  console.log('\n' + '='.repeat(70))
  console.log('Q:', q)
  const r = await ask(q)
  console.log('Domain:', r.domains)
  console.log('A:', r.response.slice(0, 800))
}
