// Comprehensive RCW retrieval validation
async function ask(q) {
  const res = await fetch('http://127.0.0.1:3000/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: q, sessionId: 'rcw-validation' })
  })
  const reader = res.body.getReader(), dec = new TextDecoder()
  let buf = '', text = '', domains = null, ticket = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split(/\r?\n/); buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const e = JSON.parse(line.slice(6).trim())
        if (e.type === 'ticket') { domains = e.data?.domains; ticket = e.data }
        if (e.type === 'token') text += e.token ?? ''
      } catch {}
    }
  }
  return { domains, response: text.trim().slice(0, 900), ticket }
}

const tests = [
  // Exact citations
  ['RCW 9A.36.011', 'Exact statute: assault first degree'],
  ['RCW 46.61.502', 'Exact statute: DUI legal BAC limit'],
  ['RCW 59.18.150', 'Exact statute: landlord access to rental'],
  
  // Topic searches across titles
  ['What is the maximum jail time for vehicular assault?', 'Criminal liability for car accidents'],
  ['What notice must a landlord give before entering a rental unit?', 'Tenant privacy/landlord rights (Title 59)'],
  ['What are the minimum wage requirements in Washington?', 'Labor law (Title 49)'],
  ['What constitutes unlawful discrimination in housing?', 'Fair housing (Title 49)'],
  ['What are the elements of theft in Washington state?', 'Criminal theft definition (Title 9A)'],
  ['What are the discovery rules in civil litigation?', 'Civil procedure (Title 4)'],
]

console.log('COMPREHENSIVE RCW RETRIEVAL VALIDATION\n' + '='.repeat(80))
console.log(`Total test queries: ${tests.length}\n`)

let passed = 0
for (const [q, desc] of tests) {
  console.log(`\n[TEST] ${desc}`)
  console.log(`Q: "${q}"`)
  try {
    const r = await ask(q)
    console.log(`Domain: ${r.domains?.join(', ') || 'N/A'}`)
    if (r.response.includes('not find') || r.response.includes('no information') || r.response.length < 100) {
      console.log(`RESULT: ✗ NO MATCH\nResponse: ${r.response.slice(0, 400)}`)
    } else {
      console.log(`RESULT: ✓ MATCH`)
      console.log(`Response preview: ${r.response.slice(0, 400)}...`)
      passed++
    }
  } catch (e) {
    console.log(`RESULT: ✗ ERROR: ${e.message}`)
  }
}

console.log(`\n${'='.repeat(80)}`)
console.log(`PASSED: ${passed}/${tests.length}`)
console.log(`STATUS: ${passed === tests.length ? '✓ ALL TESTS PASSED' : `⚠ ${tests.length - passed} FAILURES`}`)
