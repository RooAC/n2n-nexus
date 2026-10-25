-- Conversation identity for chat and meetings (owned by internal/agents).

-- Adapter instances that have made a chat or meeting call as a hooked
-- conversation: a later call from such an instance whose conversation cannot
-- be resolved fails instead of acting as the instance.
CREATE TABLE hooked_instances (
    instance_id TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL
);
