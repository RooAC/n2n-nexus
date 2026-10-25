-- Meeting members (written by internal/core, notified by internal/agents).

-- Who takes part in a meeting: a conversation session key (claude:<id> /
-- codex:<id>), or an adapter instance id for a client without hooks, which
-- cannot be notified. mode: active members are woken by new messages of
-- others, async members see them at their next hook. approver: whether the
-- member's approval is required for a decision. notified_id is the table id of
-- the newest meeting message announced to the member (at join: the newest
-- message then); wakes and last_woken_at count the wakes the meeting caused.
-- left_at is set by leave_meeting; a member that left is not notified.
CREATE TABLE meeting_members (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('active', 'async')),
    approver TEXT NOT NULL CHECK (approver IN ('required', 'optional')),
    joined_at TEXT NOT NULL,
    left_at TEXT,
    notified_id INTEGER NOT NULL DEFAULT 0,
    wakes INTEGER NOT NULL DEFAULT 0,
    last_woken_at TEXT,
    PRIMARY KEY (meeting_id, member_id)
);
CREATE INDEX idx_meeting_members_member ON meeting_members(member_id, left_at);
