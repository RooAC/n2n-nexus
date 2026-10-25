package core

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func (h *harness) startMeeting(topic, instance string) string {
	h.t.Helper()
	return h.ok("start_meeting", map[string]any{"topic": topic}, instance)["meetingId"].(string)
}

func (h *harness) activeMeeting() any {
	h.t.Helper()
	return h.ok("list_meetings", map[string]any{}, "")["activeMeetingId"]
}

func TestMeetingIDs(t *testing.T) {
	for topic, pattern := range map[string]string{
		"Release plan!":                         `^20261023120000-release-plan-[0-9a-z]{4}$`,
		"发布计划":                                  `^20261023120000-5yr5bid6-[0-9a-z]{4}$`,
		"--Hi--":                                `^20261023120000-hi-[0-9a-z]{4}$`,
		"a very long topic that goes on and on": `^20261023120000-a-very-long-topic-that-goes-on-[0-9a-z]{4}$`,
	} {
		if id := meetingID(topic, start); !regexp.MustCompile(pattern).MatchString(id) {
			t.Errorf("%q: %s does not match %s", topic, id, pattern)
		}
	}
}

func TestMeetingLifecycle(t *testing.T) {
	h := newHarness(t)
	h.fails(400, "No active meeting found to end.", "end_meeting", map[string]any{}, "ide-a")
	id := h.startMeeting("Release plan", "ide-a")
	if h.activeMeeting() != id {
		t.Fatal("new meeting is not the active one")
	}

	h.fails(400, "is still active. End it first.", "archive_meeting", map[string]any{"meetingId": id}, "ide-a")
	h.fails(400, "is already active.", "reopen_meeting", map[string]any{"meetingId": id}, "ide-a")

	// Any instance may end, archive and reopen a meeting, not only the one that started it
	res := h.ok("end_meeting", map[string]any{"summary": "shipped"}, "ide-b")
	if res["meetingId"] != id || res["status"] != "closed" || res["summary"] != "shipped" {
		t.Fatalf("end %v", res)
	}
	if h.activeMeeting() != nil {
		t.Fatal("ended meeting still active")
	}
	h.fails(400, "is already closed.", "end_meeting", map[string]any{"meetingId": id}, "ide-a")

	if res := h.ok("archive_meeting", map[string]any{"meetingId": id}, "ide-b"); res["status"] != "archived" {
		t.Fatalf("archive %v", res)
	}
	if res := h.ok("reopen_meeting", map[string]any{"meetingId": id}, "ide-b"); res["status"] != "active" {
		t.Fatalf("reopen %v", res)
	}
	if h.activeMeeting() != id {
		t.Fatal("reopened meeting is not the active one")
	}
	for _, tool := range []string{"end_meeting", "archive_meeting", "reopen_meeting"} {
		h.fails(400, "Meeting 'nope' not found.", tool, map[string]any{"meetingId": "nope"}, "ide-a")
	}

	// Anonymous callers act as "unknown".
	anon := h.startMeeting("anon", "")
	h.ok("end_meeting", map[string]any{"meetingId": anon}, "ide-a")

	got := h.eventActions("meeting")
	want := []string{"meeting.end", "meeting.start", "meeting.reopen", "meeting.archive", "meeting.end", "meeting.start"}
	if !slices.Equal(got, want) {
		t.Fatalf("events %v", got)
	}
	ev := h.ok("list_events", map[string]any{"action": "meeting.end"}, "")["events"].([]any)
	// summary is in the detail only when one was given; end_meeting without one returns none.
	if d := ev[0].(map[string]any)["detail"].(map[string]any); len(d) != 1 || d["topic"] != "anon" {
		t.Fatalf("detail %v", d)
	}
	if d := ev[1].(map[string]any)["detail"].(map[string]any); d["summary"] != "shipped" {
		t.Fatalf("detail %v", d)
	}
}

func TestDefaultMeetingFollowsActivation(t *testing.T) {
	h := newHarness(t)
	a := h.startMeeting("a", "x")
	b := h.startMeeting("b", "x")
	c := h.startMeeting("c", "x")
	// Ending a meeting that is not the default hands the role to the latest activated one.
	h.ok("end_meeting", map[string]any{"meetingId": a}, "x")
	if h.activeMeeting() != c {
		t.Fatal("want c")
	}
	h.ok("end_meeting", map[string]any{}, "x") // ends c
	if h.activeMeeting() != b {
		t.Fatal("want b after ending c")
	}
	h.ok("reopen_meeting", map[string]any{"meetingId": a}, "x")
	if h.activeMeeting() != a {
		t.Fatal("want reopened a")
	}
	h.ok("end_meeting", map[string]any{}, "x") // ends a
	if h.activeMeeting() != b {
		t.Fatal("want b again")
	}
	if n := h.count(`SELECT COUNT(*) FROM meetings WHERE is_default = 1`); n != 1 {
		t.Fatalf("%d default meetings", n)
	}
}

func TestMeetingMessagesAndList(t *testing.T) {
	h := newHarness(t)
	a := h.startMeeting("First", "ide-a")
	res := h.ok("send_message", map[string]any{"message": "p", "category": "PROPOSAL"}, "ide-b")
	if res["sentTo"] != "meeting" || res["meetingId"] != a {
		t.Fatalf("send %v", res)
	}
	if res["messageId"] != float64(h.count(`SELECT MAX(id) FROM meeting_messages`)) || res["identity"] != "instance" {
		t.Fatalf("send %v", res)
	}
	h.ok("send_message", map[string]any{"message": "d", "category": "DECISION"}, "ide-a")
	h.ok("send_message", map[string]any{"message": "plain"}, "ide-b")

	// Cursors per instance and meeting.
	if got := h.texts(map[string]any{"meetingId": a, "count": 2}, "reader"); !slices.Equal(got, []string{"p", "d"}) {
		t.Fatalf("read %v", got)
	}
	r := h.call("read_messages", map[string]any{"meetingId": a}, "reader")
	var raw struct {
		Source    string                       `json:"source"`
		MeetingID string                       `json:"meetingId"`
		Messages  []map[string]json.RawMessage `json:"messages"`
	}
	json.Unmarshal(r.result, &raw)
	// A meeting message without a category reads as category null.
	if raw.Source != "meeting" || raw.MeetingID != a || len(raw.Messages) != 1 || string(raw.Messages[0]["category"]) != "null" {
		t.Fatalf("read %s", r.result)
	}
	if got := h.texts(map[string]any{"meetingId": a}, "reader"); len(got) != 0 {
		t.Fatalf("re-read %v", got)
	}
	if got := h.texts(map[string]any{"meetingId": a}, "other"); len(got) != 3 {
		t.Fatalf("other reader %v", got)
	}
	// Meeting messages do not appear in global chat.
	if got := h.texts(map[string]any{}, "reader"); len(got) != 0 {
		t.Fatalf("global %v", got)
	}
	h.fails(400, "Meeting 'nope' not found.", "read_messages", map[string]any{"meetingId": "nope"}, "reader")
	h.fails(400, "Meeting 'nope' not found.", "send_message", map[string]any{"message": "x", "meetingId": "nope"}, "reader")

	h.ok("end_meeting", map[string]any{"meetingId": a, "summary": "agreed"}, "ide-a")
	if res := h.ok("send_message", map[string]any{"message": "after"}, "ide-b"); res["sentTo"] != "global" {
		t.Fatalf("after end %v", res)
	}
	h.fails(400, "is closed, cannot add messages.", "send_message", map[string]any{"message": "late", "meetingId": a}, "ide-b")
	h.clock.Set(start.Add(1e9))
	b := h.startMeeting("Second", "ide-b")

	type listed struct {
		Count           int     `json:"count"`
		ActiveMeetingID *string `json:"activeMeetingId"`
		Meetings        []struct {
			ID            string   `json:"id"`
			Status        string   `json:"status"`
			Initiator     string   `json:"initiator"`
			EndTime       *string  `json:"endTime"`
			Participants  []string `json:"participants"`
			MessageCount  int      `json:"messageCount"`
			DecisionCount int      `json:"decisionCount"`
			Summary       *string  `json:"summary"`
		} `json:"meetings"`
	}
	var all listed
	json.Unmarshal(h.call("list_meetings", map[string]any{}, "").result, &all)
	if all.Count != 2 || *all.ActiveMeetingID != b || all.Meetings[0].ID != b || all.Meetings[1].ID != a {
		t.Fatalf("list %+v", all)
	}
	first, second := all.Meetings[1], all.Meetings[0]
	if first.Status != "closed" || first.MessageCount != 3 || first.DecisionCount != 1 || *first.Summary != "agreed" ||
		first.EndTime == nil || !slices.Equal(first.Participants, []string{"ide-a", "ide-b"}) || first.Initiator != "ide-a" {
		t.Fatalf("first %+v", first)
	}
	if second.EndTime != nil || second.Summary != nil || !slices.Equal(second.Participants, []string{"ide-b"}) {
		t.Fatalf("second %+v", second)
	}
	var active listed
	json.Unmarshal(h.call("list_meetings", map[string]any{"status": "active", "limit": 5}, "").result, &active)
	if active.Count != 1 || active.Meetings[0].ID != b {
		t.Fatalf("active %+v", active)
	}
	var limited listed
	json.Unmarshal(h.call("list_meetings", map[string]any{"limit": 1}, "").result, &limited)
	if limited.Count != 1 {
		t.Fatalf("limit %+v", limited)
	}
}

func TestMeetingsPerSession(t *testing.T) {
	h := newHarnessWith(t, fakeIdentities{})
	id := h.as("a", "start_meeting", map[string]any{"topic": "Plan"})["meetingId"].(string)
	h.ok("send_message", map[string]any{"message": "m1"}, "mcp-0")
	sent := h.as("c", "send_message", map[string]any{"message": "m2"})
	if sent["sentTo"] != "meeting" || sent["identity"] != "session" ||
		sent["messageId"] != float64(h.count(`SELECT MAX(id) FROM meeting_messages`)) {
		t.Fatalf("send %v", sent)
	}
	// Two sessions on the same instance each read every meeting message, from the start.
	for _, s := range []string{"a", "b"} {
		res := h.as(s, "read_messages", map[string]any{"meetingId": id})
		if got := messageTexts(res); !slices.Equal(got, []string{"m1", "m2"}) || res["note"] != nil || res["source"] != "meeting" {
			t.Fatalf("%s: %v", s, res)
		}
	}
	h.as("b", "send_message", map[string]any{"message": "m3"})
	if got := messageTexts(h.as("a", "read_messages", map[string]any{"meetingId": id})); !slices.Equal(got, []string{"m3"}) {
		t.Fatalf("a again %v", got)
	}
	if got := messageTexts(h.as("b", "read_messages", map[string]any{"meetingId": id})); len(got) != 0 {
		t.Fatalf("b again %v", got)
	}

	var listed struct {
		Meetings []struct {
			Initiator    string   `json:"initiator"`
			Participants []string `json:"participants"`
		} `json:"meetings"`
	}
	json.Unmarshal(h.call("list_meetings", map[string]any{}, "").result, &listed)
	m := listed.Meetings[0]
	if m.Initiator != "codex:a" || !slices.Equal(m.Participants, []string{"codex:a", "mcp-0", "codex:c", "codex:b"}) {
		t.Fatalf("meeting %+v", m)
	}

	// Meeting events name the acting identity.
	h.as("a", "end_meeting", map[string]any{"meetingId": id})
	h.as("b", "archive_meeting", map[string]any{"meetingId": id})
	h.ok("reopen_meeting", map[string]any{"meetingId": id}, "mcp-0")
	var actors []string
	for _, e := range h.ok("list_events", map[string]any{"action": "meeting"}, "")["events"].([]any) {
		ev := e.(map[string]any)
		actors = append(actors, ev["action"].(string)+" "+ev["actor"].(string))
	}
	if want := []string{"meeting.reopen mcp-0", "meeting.archive codex:b", "meeting.end codex:a", "meeting.start codex:a"}; !slices.Equal(actors, want) {
		t.Fatalf("events %v", actors)
	}

	// An unresolved session cannot start a meeting or read one by cursor; history still works.
	if r := h.callAs("start_meeting", map[string]any{"topic": "x"}, "mcp-1", codex("lost")); r.status != 400 {
		t.Fatalf("start: %d", r.status)
	}
	if r := h.callAs("read_messages", map[string]any{"meetingId": id}, "mcp-1", codex("lost")); r.status != 400 {
		t.Fatalf("read: %d", r.status)
	}
	r := h.callAs("read_messages", map[string]any{"meetingId": id, "afterId": 0}, "mcp-1", codex("lost"))
	if r.status != 200 || !strings.Contains(string(r.result), `"text":"m3"`) {
		t.Fatalf("history: %d %s", r.status, r.err)
	}
}
