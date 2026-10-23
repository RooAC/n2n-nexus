package agents

import (
	"testing"
	"time"
)

// A hook whose client is already gone when the coordinator gets to it ends
// without its first check: nothing is marked delivered that nobody received.
func TestAbortedBeforeFirstCheckListening(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.send("s", "codex:r", "pending", false)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NULL"), 1)

	h.ag.mu.Lock() // the coordinator is busy
	held := h.openHook("codex", "Stop", "r", stopActive) // continuing a stop: it waits for messages
	time.Sleep(100 * time.Millisecond) // request arrives, blocks on mu
	held.cancel()                      // client killed
	time.Sleep(100 * time.Millisecond) // server notices the closed connection
	h.ag.mu.Unlock()
	res := <-held.done
	time.Sleep(300 * time.Millisecond) // let the handler run
	_ = res
	notified := h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NOT NULL")
	if notified != 0 {
		t.Errorf("message marked notified though nobody received the block output")
	}
}

func TestAbortedBeforeFirstCheckBackground(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopActive)
	eq(t, h.status("codex:r"), "idle")
	h.send("s", "codex:r", "pending", false)

	h.ag.mu.Lock()
	held := h.openHook("codex", testContract.Hook.BackgroundWaitEvent, "r")
	time.Sleep(100 * time.Millisecond)
	held.cancel()
	time.Sleep(100 * time.Millisecond)
	h.ag.mu.Unlock()
	res := <-held.done
	time.Sleep(300 * time.Millisecond) // let the handler run
	_ = res
	notified := h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'codex:r' AND notified_at IS NOT NULL")
	if notified != 0 || h.status("codex:r") != "idle" {
		t.Errorf("wake delivered to a gone client: notified=%d status=%s", notified, h.status("codex:r"))
	}
}
