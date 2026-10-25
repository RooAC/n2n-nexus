-- What a direct message asks of its recipient, and notices from meetings (owned by internal/agents).

-- expects_reply = 0: the notification says no reply is needed. wake = 0: the
-- message never wakes the recipient or holds its Stop; it is announced at the
-- recipient's next prompt or tool call.
ALTER TABLE agent_messages ADD COLUMN expects_reply INTEGER NOT NULL DEFAULT 1 CHECK (expects_reply IN (0, 1));
ALTER TABLE agent_messages ADD COLUMN wake INTEGER NOT NULL DEFAULT 1 CHECK (wake IN (0, 1));

-- The meeting a notice comes from (a meeting that ended), or NULL: a meeting
-- notice is no direct message and does not count as an automatic turn.
ALTER TABLE agent_notices ADD COLUMN meeting_id TEXT;
