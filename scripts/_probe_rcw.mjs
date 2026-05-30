// Temp probe script
const r = await fetch("https://apps.leg.wa.gov/RCW/default.aspx?cite=9A.36.011", { signal: AbortSignal.timeout(10000) })
const html = await r.text()
const plain = html
  .replace(/<script[\s\S]*?<\/script>/gi, "")
  .replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")

const idx = plain.toLowerCase().indexOf("assault")
console.log("STATUTE TEXT:", plain.slice(Math.max(0,idx-50), idx+1500))

const apiRefs = [...html.matchAll(/app\.leg\.wa\.gov\/api[^"'<\s]*/g)].map(m=>m[0])
const rcwApiRefs = [...html.matchAll(/rcwService|RCWService|\/rcw\//gi)].map(m=>m[0])
console.log("\nAPI refs:", [...new Set(apiRefs)].slice(0,10))
console.log("RCW svc refs:", [...new Set(rcwApiRefs)].slice(0,10))

// Check main RCW index for title list
const r2 = await fetch("https://apps.leg.wa.gov/rcw/", { signal: AbortSignal.timeout(10000) })
const html2 = await r2.text()

// Try to find all links like cite=1, cite=2A, etc.
const titleLinks = [...html2.matchAll(/cite=(\d+[A-Z]?)(?!\.\d)/g)].map(m => m[1])
const unique = [...new Set(titleLinks)]
console.log("\nALL TITLE CITES:", unique.join(", "))

// Fetch one title page to see chapter structure
const r3 = await fetch("https://apps.leg.wa.gov/rcw/default.aspx?cite=9A", { signal: AbortSignal.timeout(10000) })
const html3 = await r3.text()
const chapters = [...html3.matchAll(/cite=(9A\.\d+)/g)].map(m => m[1])
console.log("\nCHAPTERS IN TITLE 9A:", [...new Set(chapters)].join(", "))

// Fetch one chapter page to see section links
const r4 = await fetch("https://apps.leg.wa.gov/rcw/default.aspx?cite=9A.36", { signal: AbortSignal.timeout(10000) })
const html4 = await r4.text()
const sections = [...html4.matchAll(/cite=(9A\.36\.\d+)/g)].map(m => m[1])
const plain4 = html4.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<[^>]+>/g," ").replace(/\s+/g," ")
console.log("\nSECTIONS IN 9A.36:", [...new Set(sections)].join(", "))
console.log("\nCHAPTER PAGE TEXT (first 1500):", plain4.slice(plain4.indexOf("9A.36"),plain4.indexOf("9A.36")+1500))

