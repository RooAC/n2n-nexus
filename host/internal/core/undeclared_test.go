package core

import "testing"

// Keys the input schema does not declare are dropped, as zod strips them: an
// undeclared "Category" or "NewId" must not reach a field through Go's
// case-insensitive JSON decoding.
func TestUndeclaredKeysAreIgnored(t *testing.T) {
	h := newHarness(t)
	if r := h.call("send_message", map[string]any{"message": "hi", "Category": "BOGUS"}, "i"); r.status != 200 {
		t.Fatalf("send_message with an undeclared Category: %d %s", r.status, r.err)
	}
	if r := h.call("create_task", map[string]any{"Metadata": "str"}, "i"); r.status != 200 {
		t.Fatalf("create_task with an undeclared Metadata: %d %s", r.status, r.err)
	}
	if r := h.call("list_tasks", map[string]any{}, "i"); r.status != 200 {
		t.Fatalf("list_tasks: %d %s", r.status, r.err)
	}
	if r := h.call("read_messages", map[string]any{"Count": -1}, "i"); r.status != 200 {
		t.Fatalf("read_messages with an undeclared Count: %d %s", r.status, r.err)
	}

	m := manifest("web_a", "A", "storefront")
	m["TechStack"] = nil
	m["Feature_Tier"] = "bogus"
	h.sync(m)
	if r := h.call("get_project", map[string]any{"projectId": "web_a"}, "i"); r.status != 200 {
		t.Fatalf("get_project after undeclared manifest keys: %d %s", r.status, r.err)
	}
	if r := h.call("rename_project", map[string]any{"oldId": "web_a", "newId": "web_b", "NewId": "../evil id"}, "i"); r.status != 200 {
		t.Fatalf("rename_project: %d %s", r.status, r.err)
	}
	if r := h.call("get_project", map[string]any{"projectId": "web_b"}, "i"); r.status != 200 {
		t.Fatalf("renamed project is not web_b: %d %s", r.status, r.err)
	}
}
