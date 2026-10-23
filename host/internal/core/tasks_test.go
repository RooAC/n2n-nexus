package core

import (
	"encoding/json"
	"reflect"
	"regexp"
	"testing"
)

func TestTaskLifecycle(t *testing.T) {
	h := newHarness(t)
	created := h.ok("create_task", map[string]any{"metadata": map[string]any{"kind": "review", "n": 1}, "ttl": 5000}, "")
	id := created["task_id"].(string)
	if !regexp.MustCompile(`^task_20261023120000_[0-9a-z]{4}$`).MatchString(id) || created["status"] != "pending" || created["message"] != "Task created." {
		t.Fatalf("create %v", created)
	}
	want := map[string]any{
		"id": id, "status": "pending", "progress": 0.0, "source_meeting_id": nil, "metadata": map[string]any{"kind": "review", "n": 1.0},
		"result_uri": nil, "error_message": nil, "created_at": "2026-10-23T12:00:00.000Z", "updated_at": "2026-10-23T12:00:00.000Z", "ttl": 5000.0,
	}
	if !reflect.DeepEqual(created["task"], want) {
		t.Fatalf("task\n got %v\nwant %v", created["task"], want)
	}
	if got := h.ok("get_task", map[string]any{"taskId": id}, ""); !reflect.DeepEqual(got, want) {
		t.Fatalf("get_task %v", got)
	}

	// Without metadata and ttl: metadata {} and ttl null. A source meeting must exist.
	plain := h.ok("create_task", map[string]any{}, "")["task"].(map[string]any)
	if !reflect.DeepEqual(plain["metadata"], map[string]any{}) || plain["ttl"] != nil {
		t.Fatalf("plain %v", plain)
	}
	h.fails(400, "Meeting 'nope' not found.", "create_task", map[string]any{"source_meeting_id": "nope"}, "")
	m := h.startMeeting("m", "x")
	linked := h.ok("create_task", map[string]any{"source_meeting_id": m}, "")["task"].(map[string]any)
	if linked["source_meeting_id"] != m {
		t.Fatalf("linked %v", linked)
	}

	h.clock.Set(start.Add(2e9))
	updated := h.ok("update_task", map[string]any{"taskId": id, "status": "running", "progress": 0.5, "result_uri": "", "error_message": "warn"}, "")
	want["status"], want["progress"], want["error_message"], want["updated_at"] = "running", 0.5, "warn", "2026-10-23T12:00:02.000Z"
	// An empty result_uri reads as null.
	if !reflect.DeepEqual(updated, want) {
		t.Fatalf("update\n got %v\nwant %v", updated, want)
	}
	updated = h.ok("update_task", map[string]any{"taskId": id, "metadata": map[string]any{"done": true}, "result_uri": "file:///r"}, "")
	if updated["status"] != "running" || updated["result_uri"] != "file:///r" || !reflect.DeepEqual(updated["metadata"], map[string]any{"done": true}) {
		t.Fatalf("update 2 %v", updated)
	}
	h.fails(400, "Task 'nope' not found.", "update_task", map[string]any{"taskId": "nope", "progress": 1}, "")
	h.fails(400, "Invalid arguments for update_task: at '/progress': maximum: got 1.5, want 1", "update_task", map[string]any{"taskId": id, "progress": 1.5}, "")
	h.fails(400, "Invalid arguments", "update_task", map[string]any{"taskId": id, "bogus": 1}, "")

	// list_tasks: newest first, status filter, limit.
	var list struct {
		Count int `json:"count"`
		Tasks []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"tasks"`
	}
	json.Unmarshal(h.call("list_tasks", map[string]any{}, "").result, &list)
	if list.Count != 3 || list.Tasks[0].ID == id {
		t.Fatalf("list %+v", list)
	}
	json.Unmarshal(h.call("list_tasks", map[string]any{"status": "running"}, "").result, &list)
	if list.Count != 1 || list.Tasks[0].ID != id {
		t.Fatalf("running %+v", list)
	}
	json.Unmarshal(h.call("list_tasks", map[string]any{"limit": 2}, "").result, &list)
	if list.Count != 2 {
		t.Fatalf("limit %+v", list)
	}

	res := h.ok("cancel_task", map[string]any{"taskId": id}, "")
	if res["ok"] != true || res["taskId"] != id {
		t.Fatalf("cancel %v", res)
	}
	if got := h.ok("get_task", map[string]any{"taskId": id}, "")["status"]; got != "cancelled" {
		t.Fatalf("status %v", got)
	}
	h.fails(400, "Task '"+id+"' is already cancelled and cannot be cancelled.", "cancel_task", map[string]any{"taskId": id}, "")
	h.fails(400, "Task 'missing' not found.", "cancel_task", map[string]any{"taskId": "missing"}, "")
	h.fails(400, "Task 'missing' not found.", "get_task", map[string]any{"taskId": "missing"}, "")
}
