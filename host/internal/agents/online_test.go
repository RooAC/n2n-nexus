package agents

import (
	"testing"
	"time"
)

// GET /health's count: sessions that are not offline, a stale one counted as offline before any hook marks it.
func TestOnlineSessions(t *testing.T) {
	h := start(t)
	online := func() int {
		n, err := h.ag.OnlineSessions()
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	eq(t, online(), 0)
	h.hook("codex", "SessionStart", "a")
	h.hook("claude", "SessionStart", "b")
	eq(t, online(), 2)
	h.hook("claude", "SessionEnd", "b")
	eq(t, online(), 1)
	h.at(ms(timing.StaleSessionMs) + time.Second)
	eq(t, online(), 0)
}
