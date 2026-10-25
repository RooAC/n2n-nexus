-- Store resolved identity kinds; a custom adapter ID may look like a session ID.
ALTER TABLE meeting_members ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'instance'
    CHECK (identity_kind IN ('session', 'instance'));
ALTER TABLE meeting_stances ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'instance'
    CHECK (identity_kind IN ('session', 'instance'));
UPDATE meeting_members SET identity_kind = 'session'
    WHERE EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = meeting_members.member_id);
UPDATE meeting_stances SET identity_kind = 'session'
    WHERE EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = meeting_stances.member_id);

-- A draft's membership snapshot includes optional members that may opt in later.
-- Legacy rows lack an ordering within a millisecond. Keep listed approvers;
-- otherwise only a strictly earlier join establishes eligibility. Ambiguous
-- same-millisecond optional joins become eligible with the next draft.
ALTER TABLE meeting_members ADD COLUMN draft_eligible INTEGER NOT NULL DEFAULT 0
    CHECK (draft_eligible IN (0, 1));
UPDATE meeting_members SET draft_eligible = 1
    WHERE identity_kind = 'session' AND left_at IS NULL
      AND EXISTS (SELECT 1 FROM meetings m JOIN meeting_messages p ON p.id = m.current_proposal_id
          WHERE m.id = meeting_members.meeting_id AND m.status = 'active'
            AND (meeting_members.joined_at < p.timestamp OR EXISTS (
                SELECT 1 FROM meeting_approvers a WHERE a.meeting_id = m.id AND a.member_id = meeting_members.member_id)));

-- Correct active approver lists without rewriting settled decisions or closing a meeting.
UPDATE meetings SET approvers_version = approvers_version + 1
    WHERE status = 'active' AND EXISTS (
        SELECT 1 FROM meeting_approvers a JOIN meeting_members mm
            ON mm.meeting_id = a.meeting_id AND mm.member_id = a.member_id
        WHERE a.meeting_id = meetings.id AND mm.identity_kind = 'instance');
DELETE FROM meeting_approvers
    WHERE EXISTS (SELECT 1 FROM meetings m WHERE m.id = meeting_approvers.meeting_id AND m.status = 'active')
      AND EXISTS (SELECT 1 FROM meeting_members mm WHERE mm.meeting_id = meeting_approvers.meeting_id
          AND mm.member_id = meeting_approvers.member_id AND mm.identity_kind = 'instance');
