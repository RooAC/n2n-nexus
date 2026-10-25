-- Message numbers per meeting (owned by internal/core).

-- seq numbers a meeting's messages from 1; tools show and take it as the
-- message id, while the table id still orders messages and keeps read cursors.
ALTER TABLE meeting_messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
UPDATE meeting_messages SET seq = (
    SELECT COUNT(*) FROM meeting_messages p WHERE p.meeting_id = meeting_messages.meeting_id AND p.id <= meeting_messages.id
);
CREATE UNIQUE INDEX idx_meeting_messages_seq ON meeting_messages(meeting_id, seq);
