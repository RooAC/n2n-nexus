-- Conversation identity for chat and meetings (owned by internal/agents).

-- Adapter instances that make chat or meeting calls as a hooked conversation:
-- a call from such an instance whose conversation cannot be resolved fails
-- instead of acting as the instance, until the instance has resolved no
-- conversation for the stale-session window (its hooks were removed).
CREATE TABLE hooked_instances (
    instance_id TEXT PRIMARY KEY,
    last_seen_at TEXT NOT NULL
);
