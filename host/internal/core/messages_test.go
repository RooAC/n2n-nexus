package core

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"testing"
)

func (h *harness) texts(args map[string]any, instance string) []string {
	h.t.Helper()
	res := h.ok("read_messages", args, instance)
	texts := []string{}
	for _, m := range res["messages"].([]any) {
		texts = append(texts, m.(map[string]any)["text"].(string))
	}
	if int(res["count"].(float64)) != len(texts) {
		h.t.Fatalf("count %v for %d messages", res["count"], len(texts))
	}
	return texts
}

func TestGlobalChatCursorsPerInstance(t *testing.T) {
	h := newHarness(t)
	res := h.ok("send_message", map[string]any{"message": "one", "category": "UPDATE"}, "A")
	if res["sentTo"] != "global" || res["messageId"] != 1.0 {
		t.Fatalf("send: %v", res)
	}
	h.ok("send_message", map[string]any{"message": "two"}, "")

	if got := h.texts(map[string]any{}, "reader"); !slices.Equal(got, []string{"one", "two"}) {
		t.Fatalf("first read %v", got)
	}
	if got := h.texts(map[string]any{}, "reader"); len(got) != 0 {
		t.Fatalf("second read %v", got)
	}
	if got := h.texts(map[string]any{}, "other"); len(got) != 2 {
		t.Fatalf("other reader %v", got)
	}
	h.ok("send_message", map[string]any{"message": "three"}, "A")
	if got := h.texts(map[string]any{}, "reader"); !slices.Equal(got, []string{"three"}) {
		t.Fatalf("after new message %v", got)
	}

	// count limits a batch without skipping messages.
	for i := range 5 {
		h.ok("send_message", map[string]any{"message": fmt.Sprintf("m%d", i)}, "A")
	}
	for _, want := range [][]string{{"m0", "m1"}, {"m2", "m3"}, {"m4"}} {
		if got := h.texts(map[string]any{"count": 2}, "reader"); !slices.Equal(got, want) {
			t.Fatalf("got %v want %v", got, want)
		}
	}

	// A global message without a category has no category field; the sender is "unknown" without an instance.
	r := h.call("read_messages", map[string]any{"count": 2}, "fresh")
	var raw struct {
		Messages []map[string]json.RawMessage `json:"messages"`
	}
	json.Unmarshal(r.result, &raw)
	if string(raw.Messages[0]["category"]) != `"UPDATE"` || raw.Messages[1]["category"] != nil || string(raw.Messages[1]["from"]) != `"unknown"` {
		t.Fatalf("messages %s", r.result)
	}
}

func TestReadMessagesNeedsAnInstance(t *testing.T) {
	h := newHarness(t)
	h.ok("send_message", map[string]any{"message": "x"}, "A")
	h.fails(400, "needs an instanceId", "read_messages", map[string]any{}, "")
	id := h.ok("start_meeting", map[string]any{"topic": "t"}, "A")["meetingId"]
	h.fails(400, "needs an instanceId", "read_messages", map[string]any{"meetingId": id}, "")
	if n := h.count(`SELECT COUNT(*) FROM read_cursors`); n != 0 {
		t.Fatalf("%d cursors", n)
	}
}

func TestHostMaintenance(t *testing.T) {
	h := newHarness(t)
	for i := range 3 {
		h.ok("send_message", map[string]any{"message": fmt.Sprintf("m%d", i)}, "A")
	}
	h.texts(map[string]any{}, "reader")

	res := h.ok("host_maintenance", map[string]any{"action": "prune", "count": 1}, "ops")
	if res["removed"] != 1.0 || res["remaining"] != 2.0 || res["message"] != "Removed 1 global messages." {
		t.Fatalf("prune %v", res)
	}
	if res := h.ok("host_maintenance", map[string]any{"action": "prune"}, "ops"); res["removed"] != 0.0 {
		t.Fatalf("prune without count %v", res)
	}
	if res := h.ok("host_maintenance", map[string]any{"action": "clear"}, "ops"); res["removed"] != 2.0 || res["remaining"] != 0.0 {
		t.Fatalf("clear %v", res)
	}
	// Ids are not reused: a reader's cursor still sees new messages.
	h.ok("send_message", map[string]any{"message": "new"}, "A")
	if got := h.texts(map[string]any{}, "reader"); !slices.Equal(got, []string{"new"}) {
		t.Fatalf("after clear %v", got)
	}
	ev := h.ok("list_events", map[string]any{"action": "maintenance"}, "")["events"].([]any)
	first := ev[0].(map[string]any)
	if len(ev) != 3 || first["action"] != "maintenance.clear" || first["actor"] != "ops" ||
		!reflect.DeepEqual(first["detail"], map[string]any{"removed": 2.0}) {
		t.Fatalf("events %v", ev)
	}
	if _, ok := first["target"]; ok {
		t.Fatal("maintenance event has a target")
	}
}

func TestListEventsFilter(t *testing.T) {
	h := newHarness(t)
	h.sync(manifest("web_x", "X", ""))
	h.ok("update_global_strategy", map[string]any{"content": "s"}, "")
	h.ok("rename_project", map[string]any{"oldId": "web_x", "newId": "web_y"}, "ide-b")
	for _, tc := range []struct {
		action string
		want   []string
	}{
		{"", []string{"project.rename", "strategy.update", "project.sync"}},
		{"project", []string{"project.rename", "project.sync"}},
		{"project.sync", []string{"project.sync"}},
		{"Project", nil},
		{"%", nil},
		{"proj_ct", nil},
		{"project.", nil},
		{"strategy", []string{"strategy.update"}},
	} {
		if got := h.eventActions(tc.action); !slices.Equal(got, tc.want) {
			t.Errorf("%q: got %v want %v", tc.action, got, tc.want)
		}
	}
	if res := h.ok("list_events", map[string]any{"limit": 1}, ""); res["count"] != 1.0 {
		t.Fatalf("limit %v", res)
	}
	// strategy.update has neither target nor detail.
	r := h.call("list_events", map[string]any{"action": "strategy"}, "")
	var raw struct {
		Events []map[string]json.RawMessage `json:"events"`
	}
	json.Unmarshal(r.result, &raw)
	if _, ok := raw.Events[0]["target"]; ok {
		t.Fatalf("target present: %s", r.result)
	}
	if _, ok := raw.Events[0]["detail"]; ok {
		t.Fatalf("detail present: %s", r.result)
	}
	if string(raw.Events[0]["actor"]) != `"unknown"` {
		t.Fatalf("actor %s", raw.Events[0]["actor"])
	}
}

func TestStrategyAndGlobalDocs(t *testing.T) {
	h := newHarness(t)
	if got := h.ok("get_global_strategy", map[string]any{}, "")["content"]; got != "# Global Coordination Blueprint\n\nShared meeting space." {
		t.Fatalf("fresh strategy %q", got)
	}
	h.ok("update_global_strategy", map[string]any{"content": "# Strategy"}, "ide-a")
	if got := h.ok("get_global_strategy", map[string]any{}, "")["content"]; got != "# Strategy" {
		t.Fatalf("strategy %q", got)
	}
	h.fails(400, "Invalid arguments", "get_global_strategy", map[string]any{"extra": 1}, "")

	h.ok("sync_global_doc", map[string]any{"docId": "protocol", "title": "Sync Protocol", "content": "# v1"}, "ide-a")
	h.ok("sync_global_doc", map[string]any{"docId": "same-time", "title": "Same", "content": "x"}, "")
	h.clock.Set(start.Add(1e9))
	h.ok("sync_global_doc", map[string]any{"docId": "glossary", "title": "Glossary", "content": "# terms"}, "ide-b")

	list := h.ok("list_global_docs", map[string]any{}, "")
	var ids []string
	for _, d := range list["docs"].([]any) {
		ids = append(ids, d.(map[string]any)["docId"].(string))
	}
	if !slices.Equal(ids, []string{"glossary", "protocol", "same-time"}) || list["count"] != 3.0 {
		t.Fatalf("list %v", list)
	}
	doc := h.ok("get_global_doc", map[string]any{"docId": "protocol"}, "")
	want := map[string]any{"docId": "protocol", "title": "Sync Protocol", "content": "# v1", "updatedBy": "ide-a", "lastUpdated": "2026-10-23T12:00:00.000Z"}
	if !reflect.DeepEqual(doc, want) {
		t.Fatalf("doc %v", doc)
	}
	if got := h.ok("get_global_doc", map[string]any{"docId": "same-time"}, "")["updatedBy"]; got != "unknown" {
		t.Fatalf("updatedBy %v", got)
	}
	// Re-syncing replaces title, content and author.
	h.ok("sync_global_doc", map[string]any{"docId": "protocol", "title": "P2", "content": "# v2"}, "ide-c")
	if doc := h.ok("get_global_doc", map[string]any{"docId": "protocol"}, ""); doc["title"] != "P2" || doc["content"] != "# v2" || doc["updatedBy"] != "ide-c" {
		t.Fatalf("resynced %v", doc)
	}
	h.fails(400, "Document 'nope' not found.", "get_global_doc", map[string]any{"docId": "nope"}, "")
	if got := h.eventActions("doc"); len(got) != 4 {
		t.Fatalf("doc events %v", got)
	}
}
