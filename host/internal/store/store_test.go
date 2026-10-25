package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The database lands in the data directory whatever characters its path holds.
func TestOpenPathWithURICharacters(t *testing.T) {
	names := []string{"hash#dir", "pct%41dir", "space dir"}
	if runtime.GOOS != "windows" { // Windows file names cannot hold '?'
		names = append(names, "q?dir")
	}
	for _, name := range names {
		dir := filepath.Join(t.TempDir(), name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		s, err := Open(dir)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		s.Close()
		if _, err := os.Stat(filepath.Join(dir, FileName)); err != nil {
			t.Fatalf("%s: database not in the data directory: %v", name, err)
		}
	}
}

func TestMeetingIdentityMigration(t *testing.T) {
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, FileName))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(query string) {
		t.Helper()
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() >= "0009_" {
			break
		}
		raw, err := migrations.ReadFile("migrations/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		exec(string(raw))
	}
	exec(`PRAGMA user_version = 8;
		INSERT INTO agent_sessions (id, client, name, cwd, status, listening, created_at, last_active_at) VALUES
		('codex:required', 'codex', 'required', '', 'idle', 0, 't', 't'),
		('codex:before', 'codex', 'before', '', 'idle', 0, 't', 't'),
		('codex:same', 'codex', 'same', '', 'idle', 0, 't', 't'),
		('codex:after', 'codex', 'after', '', 'idle', 0, 't', 't');
		INSERT INTO meetings (id, topic, status, active_order, initiator, participants, created_at, current_proposal_id, approvers_version) VALUES
		('active', 'a', 'active', 1, 'codex:required', '[]', 't', 1, 4),
		('closed', 'c', 'closed', 2, 'codex:buildbot', '[]', 't', 2, 7),
		('archived', 'x', 'archived', 3, 'codex:buildbot', '[]', 't', 3, 8);
		INSERT INTO meeting_messages (id, meeting_id, seq, sender, text, category, timestamp) VALUES
		(1, 'active', 1, 'codex:required', 'draft', 'PROPOSAL', '2026-10-26T12:00:00.001Z'),
		(2, 'closed', 1, 'codex:buildbot', 'old', 'PROPOSAL', '2026-10-26T12:00:00.001Z'),
		(3, 'archived', 1, 'codex:buildbot', 'old', 'PROPOSAL', '2026-10-26T12:00:00.001Z');
		INSERT INTO meeting_members (meeting_id, member_id, mode, approver, joined_at) VALUES
		('active', 'codex:required', 'active', 'required', '2026-10-26T12:00:00.001Z'),
		('active', 'codex:before', 'async', 'optional', '2026-10-26T12:00:00.000Z'),
		('active', 'codex:same', 'async', 'optional', '2026-10-26T12:00:00.001Z'),
		('active', 'codex:after', 'async', 'optional', '2026-10-26T12:00:00.002Z'),
		('active', 'codex:buildbot', 'active', 'required', '2026-10-26T12:00:00.000Z'),
		('closed', 'codex:buildbot', 'active', 'required', '2026-10-26T12:00:00.000Z'),
		('archived', 'codex:buildbot', 'active', 'required', '2026-10-26T12:00:00.000Z');
		INSERT INTO meeting_approvers (meeting_id, member_id) VALUES
		('active', 'codex:required'), ('active', 'codex:buildbot'), ('closed', 'codex:buildbot'), ('archived', 'codex:buildbot');
		INSERT INTO meeting_stances (meeting_id, message_id, member_id, stance, at) VALUES
		('active', 1, 'codex:required', 'endorse', 't'), ('active', 1, 'codex:buildbot', 'object', 't');`)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for range 2 { // Opening the already migrated database must preserve the same state.
		s, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		check := func(query string, want int) {
			t.Helper()
			var got int
			if err := s.DB.QueryRow(query).Scan(&got); err != nil || got != want {
				t.Fatalf("%s: got %d, want %d, error %v", query, got, want, err)
			}
		}
		check(`PRAGMA user_version`, 9)
		check(`SELECT COUNT(*) FROM meeting_members WHERE identity_kind = 'session'`, 4)
		check(`SELECT COUNT(*) FROM meeting_members WHERE draft_eligible = 1 AND member_id IN ('codex:required', 'codex:before')`, 2)
		check(`SELECT COUNT(*) FROM meeting_members WHERE draft_eligible = 1`, 2)
		check(`SELECT COUNT(*) FROM meeting_approvers WHERE meeting_id = 'active'`, 1)
		check(`SELECT approvers_version FROM meetings WHERE id = 'active'`, 5)
		check(`SELECT COUNT(*) FROM meetings WHERE id = 'active' AND status = 'active'`, 1)
		check(`SELECT COUNT(*) FROM meeting_approvers WHERE meeting_id IN ('closed', 'archived')`, 2)
		check(`SELECT approvers_version FROM meetings WHERE id = 'closed'`, 7)
		check(`SELECT approvers_version FROM meetings WHERE id = 'archived'`, 8)
		check(`SELECT COUNT(*) FROM meeting_stances WHERE identity_kind = 'session' AND stance = 'endorse'`, 1)
		check(`SELECT COUNT(*) FROM meeting_stances WHERE identity_kind = 'instance' AND stance = 'object'`, 1)
		check(`SELECT COUNT(*) FROM meeting_messages`, 3)
		s.Close()
	}
}
