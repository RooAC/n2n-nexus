-- Conversation titles of agent sessions (owned by internal/agents).

-- title: what the conversation is called, for display only (name stays the
-- handle send takes). title_source: 'client' when the client's hook reported
-- it, 'self' when the session set it with set_profile (the client's title no
-- longer replaces it), '' when there is none.
ALTER TABLE agent_sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT '' CHECK (title_source IN ('', 'client', 'self'));
