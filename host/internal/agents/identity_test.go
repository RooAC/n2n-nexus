package agents

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
)

func (h *harness) identity(instance string, caller *api.Caller) (api.Identity, error) {
	h.t.Helper()
	return h.ag.Identity(api.Call{Ctx: context.Background(), InstanceID: instance, Caller: caller})
}

func TestIdentityResolvesClaudeAndCodexSessions(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "c1")
	h.hook("claude", "PreToolUse", "c1", map[string]any{"tool_use_id": "toolu_a", "tool_name": "mcp__n2n-nexus__send_message"})
	id, err := h.identity("mcp-1", &api.Caller{Client: "claude", ToolUseID: "toolu_a"})
	if err != nil {
		t.Fatal(err)
	}
	want := api.Identity{Kind: api.IdentitySession, ID: "claude:c1", Name: h.session("claude:c1").Name, Instance: "mcp-1"}
	if id != want {
		t.Fatalf("got %+v want %+v", id, want)
	}

	h.hook("codex", "SessionStart", "x1")
	id, err = h.identity("mcp-2", &api.Caller{Client: "codex", SessionID: "x1"})
	if err != nil || id.Kind != api.IdentitySession || id.ID != "codex:x1" || id.Name == "" || id.Instance != "mcp-2" {
		t.Fatalf("codex: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM hooked_instances WHERE instance_id IN ('mcp-1', 'mcp-2')"), 2)

	// Without an instance: the session, and nothing recorded.
	id, err = h.identity("", &api.Caller{Client: "codex", SessionID: "x1"})
	if err != nil || id.ID != "codex:x1" || id.Instance != api.UnknownInstance {
		t.Fatalf("no instance: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM hooked_instances"), 2)
}

func TestIdentityFallsBackToTheInstanceWithoutHooks(t *testing.T) {
	h := start(t)
	// A caller is sent without hooks too: an unknown session falls back while the instance never resolved one.
	for _, caller := range []*api.Caller{nil, {Client: "claude", ToolUseID: "toolu_none"}, {Client: "codex", SessionID: "nobody"}} {
		id, err := h.identity("mcp-plain", caller)
		want := api.Identity{Kind: api.IdentityInstance, ID: "mcp-plain", Instance: "mcp-plain"}
		if err != nil || id != want {
			t.Fatalf("%+v: got %+v %v", caller, id, err)
		}
	}
	id, err := h.identity("", nil)
	if err != nil || id.ID != api.UnknownInstance || id.Kind != api.IdentityInstance {
		t.Fatalf("anonymous: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM hooked_instances"), 0)
}

func TestIdentityFailsForAHookedInstanceThatCannotResolve(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "x1")
	if _, err := h.identity("mcp-1", &api.Caller{Client: "codex", SessionID: "x1"}); err != nil {
		t.Fatal(err)
	}
	for _, caller := range []*api.Caller{nil, {Client: "claude", ToolUseID: "toolu_unbound"}, {Client: "codex", SessionID: "unknown"}} {
		_, err := h.identity("mcp-1", caller)
		var te *api.ToolError
		if !errors.As(err, &te) || te.Message != identityRetryError {
			t.Fatalf("%+v: got %v", caller, err)
		}
	}
	// Other instances are not affected.
	if id, err := h.identity("mcp-2", nil); err != nil || id.Kind != api.IdentityInstance {
		t.Fatalf("other instance: %+v %v", id, err)
	}
}

func TestIdentityLeavesExpiredBindings(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "c1")
	h.hook("claude", "PreToolUse", "c1", map[string]any{"tool_use_id": "toolu_old", "tool_name": "mcp__n2n-nexus__read_messages"})
	h.at(time.Duration(testContract.Hook.Timing.ToolUseBindingTtlMs+1) * time.Millisecond)
	id, err := h.identity("mcp-new", &api.Caller{Client: "claude", ToolUseID: "toolu_old"})
	if err != nil || id.Kind != api.IdentityInstance {
		t.Fatalf("expired binding: %+v %v", id, err)
	}
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings WHERE tool_use_id = 'toolu_old'"), 1)
	// Nor does it refresh the session.
	eq(t, h.session("claude:c1").LastActiveAt, h.ag.iso(h.t0))
}
