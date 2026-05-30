-- 006_corpora.sql
-- Corpus registry — the single source of truth for what knowledge domains exist,
-- what type of agent handles them, and what they contain (and don't contain).
--
-- The broker reads this table at startup to:
--   1. Build the dispatcher's domain list and description block
--   2. Inject per-corpus scope notes into the ReAct system prompt
--   3. Parameterize agent archetypes (no per-domain agent files needed)
--
-- agent_type controls which agent archetype handles the domain:
--   statutes   → agents/_archetypes/statutes-agent.js  (search_statutes, get_section, get_chapter)
--   documents  → agents/_archetypes/documents-agent.js (search_hybrid, get_document, search_documents)
--   finance    → agents/finance/index.js               (kept as bespoke — different tool shape)
--   comms      → agents/comms/index.js                 (kept as bespoke — output-oriented)
--   proposals  → agents/proposals/index.js             (kept as bespoke — output-oriented)
--   recall     → agents/recall/index.js                (kept as bespoke — SQLite, not PG)
--   artifacts  → agents/artifacts/index.js             (kept as bespoke — file management)

CREATE TABLE IF NOT EXISTS corpora (
  id              serial        PRIMARY KEY,
  domain          text          NOT NULL UNIQUE,      -- matches documents.domain
  display_name    text          NOT NULL,             -- human label for UI/prompts
  agent_type      text          NOT NULL,             -- see comment above
  dispatcher_description text  NOT NULL,             -- shown in dispatcher prompt
  scope_notes     text          NOT NULL,             -- injected into ReAct scope block
  not_in_corpus   text          NOT NULL DEFAULT '',  -- explicit absence guidance for model
  is_active       boolean       NOT NULL DEFAULT true,
  created_at      timestamptz   NOT NULL DEFAULT NOW(),
  updated_at      timestamptz   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE corpora IS
  'Registry of all knowledge domains. Single source of truth for dispatcher prompts, '
  'agent archetype selection, and ReAct scope injection.';

-- ---------------------------------------------------------------------------
-- Seed: current domains
-- ---------------------------------------------------------------------------

INSERT INTO corpora (domain, display_name, agent_type, dispatcher_description, scope_notes, not_in_corpus)
VALUES
  (
    'legal',
    'Washington State Law',
    'statutes',
    'ANYTHING about law, statutes, regulations, legal codes, RCW citations, what is legal/illegal, penalties, criminal charges, tenant rights, DUI, assault, murder, contracts, NDAs, compliance, risk, liability, clauses, legal review. Use legal for any question that asks "what does the law say", "is it legal", "what are the penalties", "what does RCW say", "under Washington law", "what are my rights as a tenant/employee/landlord"',
    'Washington state RCW statutes (full text). ~500 chapters covering state criminal law, civil law, property, environmental, business, taxation, public works, healthcare. Organized by RCW chapter number (e.g. 46.63 = traffic infractions, 9A.36 = assault).',
    'Federal law, US Code, CFR, case law / court decisions, regulations from other states, import/export regulations, international law, municipal codes, UCC.'
  ),
  (
    'research',
    'Research & Documents',
    'documents',
    'finding information, market data, industry trends, reports, analysis, technical documentation, "what do we know", "what does the knowledge base say", "summarize the docs", "what is X" (factual/technical questions about topics, tools, specs, or ingested documents)',
    'Personal research files, project reports, technical notes, and documents ingested by the user. Corpus: notespace. Content varies by what has been uploaded.',
    'Any content not explicitly ingested. Does not contain legal statutes, financial records, or external databases unless those files were uploaded.'
  )
ON CONFLICT (domain) DO UPDATE SET
  display_name           = EXCLUDED.display_name,
  agent_type             = EXCLUDED.agent_type,
  dispatcher_description = EXCLUDED.dispatcher_description,
  scope_notes            = EXCLUDED.scope_notes,
  not_in_corpus          = EXCLUDED.not_in_corpus,
  updated_at             = NOW();
