-- 003_create_user_context.sql
-- The living profile of the user. Single row, upserted any time context changes.
-- Injected into EVERY inference call across ALL domains.
-- This is what makes the system feel like it knows who it's talking to.

CREATE TABLE IF NOT EXISTS user_context (
  id                  integer        PRIMARY KEY DEFAULT 1,  -- always one row
  display_name        text,          -- how JARVIS refers to the user ("the boss", "David", etc.)
  company             text,
  role                text,
  current_priorities  text[],        -- free-form list: ["close Henderson deal", "Q2 budget review"]
  active_deals        jsonb,         -- [{ name, stage, value, counterparty }]
  key_contacts        jsonb,         -- [{ name, company, relationship, notes }]
  tone_preferences    text,          -- free-form: "direct, no filler, bullet points preferred"
  context_notes       text,          -- catch-all freeform field for anything else
  updated_at          timestamptz    NOT NULL DEFAULT NOW(),
  -- Constraint ensures we never accidentally have more than one row
  CONSTRAINT single_user CHECK (id = 1)
);

-- Seed with an empty row so the Context Assembler never gets a null result.
-- Update this with real data via scripts/seed-context.js
INSERT INTO user_context (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE user_context IS
  'Single-row living profile. Injected into every inference call. Update via seed-context.js.';
