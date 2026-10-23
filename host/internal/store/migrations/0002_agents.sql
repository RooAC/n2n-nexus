-- Agent sessions and direct messages between conversations (owned by internal/agents).

-- One session per Claude Code / Codex conversation, created by the client hooks.
CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL CHECK(client IN ('claude', 'codex')),
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('working', 'idle', 'listening', 'offline')),
    listening INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);
CREATE INDEX idx_agent_sessions_name ON agent_sessions(name);

-- Direct messages between agent sessions.
CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL REFERENCES agent_sessions(id),
    to_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    reply_to TEXT REFERENCES agent_messages(id),
    status TEXT NOT NULL CHECK(status IN ('unread', 'read', 'expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    notified_at TEXT,
    read_at TEXT
);
CREATE INDEX idx_agent_messages_inbox ON agent_messages(to_id, status);
CREATE INDEX idx_agent_messages_expiry ON agent_messages(status, expires_at);

-- Notices for a session (idle subscriptions, expired messages), delivered by hooks.
CREATE TABLE agent_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    notified_at TEXT
);
CREATE INDEX idx_agent_notices_pending ON agent_notices(session_id, notified_at);

-- One-shot "tell me when the target finishes its turn" subscriptions.
CREATE TABLE agent_idle_subscriptions (
    subscriber_id TEXT NOT NULL REFERENCES agent_sessions(id),
    target_id TEXT NOT NULL REFERENCES agent_sessions(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, target_id)
);
CREATE INDEX idx_agent_idle_target ON agent_idle_subscriptions(target_id);

-- Claude toolUseId -> session, written by the PreToolUse hook.
CREATE TABLE tool_use_bindings (
    tool_use_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id),
    created_at TEXT NOT NULL
);
CREATE INDEX idx_tool_use_bindings_created ON tool_use_bindings(created_at);
