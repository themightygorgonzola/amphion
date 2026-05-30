-- 007_add_user_id.sql
-- Adds user_id to conversations so sessions are scoped per person.
--
-- Default 'default' means existing rows stay queryable with the old code paths.
-- The broker writes the user_id from the POST /query body (defaults to 'default'
-- if not supplied — zero breaking change for single-user deploys).
--
-- This is the prerequisite for multi-user context isolation:
--   - assembleContext() scopes history to one user
--   - recall agent searches only that user's conversations
--   - copilot-notes, homework sessions, etc. stay separated

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS user_id text NOT NULL DEFAULT 'default';

-- Fast per-user lookup (replaces the old session-only index for history queries)
CREATE INDEX IF NOT EXISTS conversations_user_idx
  ON conversations (user_id, created_at DESC);

-- Combined index for the common pattern: user + session
CREATE INDEX IF NOT EXISTS conversations_user_session_idx
  ON conversations (user_id, session_id, created_at DESC);

COMMENT ON COLUMN conversations.user_id IS
  'Who was talking. Defaults to ''default'' for single-user installs. '
  'Set per POST /query request to scope history to one person.';
