-- 014_private_records_corpus.sql
-- Seed a first-class private-records corpus for enterprise and other
-- user-provided confidential archives. This keeps non-public document sets out
-- of the general research corpus while still using the same document agent.

INSERT INTO corpora (
  domain,
  slug,
  display_name,
  agent_type,
  resource_type,
  dispatcher_description,
  scope_notes,
  not_in_corpus,
  access_mode,
  schema_hint,
  is_active
)
VALUES (
  'private-records',
  'private-records',
  'Private Records',
  'documents',
  'documents',
  'Private uploaded records, company archives, internal operational files, and other non-public document collections explicitly provided by the user.',
  'Confidential or non-public files intentionally provided by the user for local retention. Use this corpus for company archives, payroll, taxes, insurance, asset records, HR files, and similar internal document collections that should stay separate from general research.',
  'Open-web research, public reference material, legal statutes, conversation history, and any source not explicitly provided or approved by the user for private retention.',
  'managed',
  '{"visibility":"private","source_policy":"user-provided-only"}'::jsonb,
  true
)
ON CONFLICT (domain) DO UPDATE SET
  slug                   = EXCLUDED.slug,
  display_name           = EXCLUDED.display_name,
  agent_type             = EXCLUDED.agent_type,
  resource_type          = EXCLUDED.resource_type,
  dispatcher_description = EXCLUDED.dispatcher_description,
  scope_notes            = EXCLUDED.scope_notes,
  not_in_corpus          = EXCLUDED.not_in_corpus,
  access_mode            = EXCLUDED.access_mode,
  schema_hint            = EXCLUDED.schema_hint,
  is_active              = EXCLUDED.is_active,
  updated_at             = NOW();