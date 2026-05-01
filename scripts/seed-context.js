/**
 * seed-context.js — Populate user_context in SQLite
 *
 * Run this once to set up the living context profile for the boss.
 * Re-run anytime to update priorities, active deals, key contacts, etc.
 *
 * Usage:
 *   node scripts/seed-context.js
 *
 * Edit the PROFILE object below to match your actual situation.
 */

import { DatabaseSync } from 'node:sqlite'
import fs   from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------
function loadEnv () {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

// ---------------------------------------------------------------------------
// EDIT THIS PROFILE to match reality
// ---------------------------------------------------------------------------
const PROFILE = {
  display_name: 'David',
  company:      'Apex Group',
  role:         'Managing Director',

  current_priorities: JSON.stringify([
    'Close Henderson Capital Tower deal by June 30',
    'Win Westfield Development proposal',
    'Q2 revenue target: $6.1M',
    'Hire senior associate for deal execution',
  ]),

  active_deals: JSON.stringify([
    { name: 'Henderson Capital Tower', stage: 'negotiation',   value: '$4.2M fee / $210M asset', counterparty: 'Greenbridge Equity Group' },
    { name: 'Westfield Mixed-Use',     stage: 'proposal sent', value: '$180K fee / $75M asset',  counterparty: 'Westfield Development Partners' },
  ]),

  key_contacts: JSON.stringify([
    { name: 'Robert Henderson', company: 'Henderson Capital Partners', relationship: 'repeat client', notes: 'CEO, direct line only, prefers phone for issues' },
    { name: 'Sarah Chen',       company: 'Westfield Development',      relationship: 'prospect',      notes: 'VP Development, met at ULI conference' },
    { name: 'Marcus Webb',      company: 'First National Bank',        relationship: 'deal source',   notes: 'Referred both Henderson and Westfield; keep warm' },
    { name: 'James Meridian',   company: 'Meridian Construction',      relationship: 'active client', notes: 'Current engagement Phase 1, wants weekly updates' },
  ]),

  tone_preferences: 'Direct, no filler words. Bullet points over paragraphs. Get to the point fast. Numbers over adjectives.',

  context_notes: 'David runs a lean advisory shop — 8 people. Every deal matters. He wants Atlas to surface the key fact, not summarize everything. Flag risks proactively. He hates being surprised.',
}

// ---------------------------------------------------------------------------
// Write to SQLite
// ---------------------------------------------------------------------------
const dbPath = path.resolve(process.env.SQLITE_PATH ?? './data/memory.db')

// Ensure data directory exists
const dir = path.dirname(dbPath)
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

const db = new DatabaseSync(dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS user_context (
    id                  INTEGER PRIMARY KEY DEFAULT 1,
    display_name        TEXT,
    company             TEXT,
    role                TEXT,
    current_priorities  TEXT,
    active_deals        TEXT,
    key_contacts        TEXT,
    tone_preferences    TEXT,
    context_notes       TEXT,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (id = 1)
  );
  INSERT OR IGNORE INTO user_context (id) VALUES (1);
`)

db.prepare(`
  UPDATE user_context SET
    display_name       = ?,
    company            = ?,
    role               = ?,
    current_priorities = ?,
    active_deals       = ?,
    key_contacts       = ?,
    tone_preferences   = ?,
    context_notes      = ?,
    updated_at         = datetime('now')
  WHERE id = 1
`).run(
  PROFILE.display_name,
  PROFILE.company,
  PROFILE.role,
  PROFILE.current_priorities,
  PROFILE.active_deals,
  PROFILE.key_contacts,
  PROFILE.tone_preferences,
  PROFILE.context_notes,
)

console.log('[seed] user_context updated:')
console.log(`  display_name: ${PROFILE.display_name}`)
console.log(`  company:      ${PROFILE.company}`)
console.log(`  role:         ${PROFILE.role}`)
console.log(`  priorities:   ${JSON.parse(PROFILE.current_priorities).length} items`)
console.log(`  active_deals: ${JSON.parse(PROFILE.active_deals).length} deals`)
console.log(`  key_contacts: ${JSON.parse(PROFILE.key_contacts).length} contacts`)
console.log(`  saved to:     ${dbPath}`)
