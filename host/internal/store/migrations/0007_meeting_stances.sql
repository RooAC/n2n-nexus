-- Drafts, approvers and stances of meetings (owned by internal/core).

-- current_proposal_id: the table id (meeting_messages.id) of the draft that
-- waits for approval, set only by publishing a draft (send_message draft);
-- approvers_version counts the changes of its approver list. end_reason:
-- 'consensus' when every required approver endorsed the draft, 'manual' when
-- end_meeting closed it. draft_reminded_at: when the draft's author was told
-- who has not taken a stance yet (once per draft).
ALTER TABLE meetings ADD COLUMN current_proposal_id INTEGER;
ALTER TABLE meetings ADD COLUMN approvers_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE meetings ADD COLUMN end_reason TEXT CHECK (end_reason IN ('manual', 'consensus'));
ALTER TABLE meetings ADD COLUMN draft_reminded_at TEXT;

-- The required approvers of a meeting's current draft: the conversation
-- sessions that were required members when it was published, changed only by
-- an explicit leave or approver change. reminded_at: when the approver was
-- reminded of its missing stance (once per draft).
CREATE TABLE meeting_approvers (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL,
    reminded_at TEXT,
    PRIMARY KEY (meeting_id, member_id)
);

-- Stances on proposals (message_id: the table id of a PROPOSAL message). A
-- member has one stance per proposal and may change or withdraw it.
CREATE TABLE meeting_stances (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    member_id TEXT NOT NULL,
    stance TEXT NOT NULL CHECK (stance IN ('endorse', 'object')),
    note TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (meeting_id, message_id, member_id)
);
