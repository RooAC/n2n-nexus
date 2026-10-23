package agents

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/store"
)

var (
	stopInactive = map[string]any{"stop_hook_active": false}
	stopActive   = map[string]any{"stop_hook_active": true}
)

func TestSessionNames(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "a")
	h.hook("claude", "SessionStart", "b")
	h.hook("claude", "UserPromptSubmit", "c") // any event creates the session
	a := h.session("claude:a")
	if a.Client != "claude" || a.Name != "claude@proj" || a.Cwd != "/work/proj" || a.Status != "idle" || a.Note != "" || a.Listening {
		t.Fatalf("claude:a = %+v", a)
	}
	eq(t, h.session("claude:b").Name, "claude@proj#2")
	eq(t, h.session("claude:c").Name, "claude@proj#3")
	eq(t, h.status("claude:c"), "working")

	// No cwd: name falls back to "session", cwd is "".
	h.hook("codex", "SessionStart", "x", map[string]any{"cwd": nil})
	eq(t, h.session("codex:x").Name, "codex@session")
	eq(t, h.session("codex:x").Cwd, "")
	// A Windows working directory, trailing separator included.
	h.hook("codex", "SessionStart", "w", map[string]any{"cwd": `C:\work\winproj\`})
	eq(t, h.session("codex:w").Name, "codex@winproj")

	// An offline session's name is free again; when it comes back the name is taken, so it gets a new #N.
	h.hook("claude", "SessionEnd", "a", map[string]any{"reason": "clear"})
	h.hook("claude", "SessionStart", "d")
	eq(t, h.session("claude:d").Name, "claude@proj")
	h.hook("claude", "SessionStart", "a", map[string]any{"source": "resume"})
	eq(t, h.session("claude:a").Name, "claude@proj#4")
	eq(t, h.status("claude:a"), "idle")

	// A session coming back whose name is still free keeps it.
	h.hook("claude", "SessionEnd", "b")
	h.hook("claude", "SessionStart", "b")
	eq(t, h.session("claude:b").Name, "claude@proj#2")
}

func TestHookInputAndActivity(t *testing.T) {
	h := start(t)
	for _, input := range []map[string]any{
		{"hook_event_name": "SessionStart"},
		{"hook_event_name": "SessionStart", "session_id": ""},
		{"hook_event_name": "Stop", "session_id": 7},
	} {
		status, payload, err := h.post(context.Background(), "/api/hook", map[string]any{"client": "claude", "input": input})
		if err != nil || status != 200 || payload["output"] != nil {
			t.Fatalf("%v: %d %v %v", input, status, payload, err)
		}
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_sessions"), 0)
	status, _, _ := h.post(context.Background(), "/api/hook", map[string]any{"client": "cursor", "input": map[string]any{"session_id": "a"}})
	eq(t, status, 400)
	status, _, _ = h.post(context.Background(), "/api/hook", map[string]any{"client": "claude"})
	eq(t, status, 400)

	h.hook("claude", "SessionStart", "a")
	eq(t, h.session("claude:a").LastActiveAt, store.ISO(h.t0))
	h.at(5 * time.Second)
	h.hook("claude", "PreToolUse", "a", map[string]any{"tool_use_id": "toolu_x"})
	eq(t, h.session("claude:a").LastActiveAt, store.ISO(h.t0.Add(5*time.Second)))
	eq(t, h.status("claude:a"), "idle") // PreToolUse does not change the status
	if out := h.hook("claude", "UnknownEvent", "a"); out != nil {
		t.Fatalf("unknown event printed %v", out)
	}
}

func TestSessionEnd(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "a")
	eq(t, h.codex("a", "listen", map[string]any{"on": true}).result["listening"], any(true))
	if out := h.hook("codex", "SessionEnd", "a", map[string]any{"reason": "exit"}); out != nil {
		t.Fatalf("SessionEnd printed %v", out)
	}
	eq(t, h.status("codex:a"), "offline")
	eq(t, h.session("codex:a").Listening, false)
}

func TestSessionStartIntroduction(t *testing.T) {
	h := start(t)
	alone := h.hook("claude", "SessionStart", "a").context()
	if !strings.HasPrefix(alone, prefix+" This conversation is claude@proj (claude:a) on n2n-nexus") {
		t.Fatal(alone)
	}
	contains(t, alone, "No other AI sessions are online.")
	contains(t, alone, texts.SessionStartClosing)

	h.hook("codex", "SessionStart", "b")
	h.codex("b", "set_profile", map[string]any{"note": "fixing login"})
	for _, id := range []string{"c", "d", "e", "f", "g"} {
		h.hook("codex", "SessionStart", id)
	}
	h.hook("codex", "SessionEnd", "g") // offline sessions are not listed

	text := h.hook("claude", "SessionStart", "h").context()
	contains(t, text, "6 other AI sessions are online:")
	contains(t, text, "- codex@proj (codex:b), codex, idle, /work/proj: fixing login")
	notContains(t, text, "(codex:g)")
	contains(t, text, "This conversation is claude@proj#2 (claude:h)")
	notContains(t, text, "- claude@proj#2 (claude:h)")
	contains(t, text, "...and 1 more")
	contains(t, text, texts.StatusNote)
	if !strings.HasSuffix(text, texts.SessionStartClosing) {
		t.Fatal(text)
	}
	eq(t, h.status("claude:h"), "idle")

	// One other session: singular.
	h2 := start(t)
	h2.hook("codex", "SessionStart", "x")
	contains(t, h2.hook("codex", "SessionStart", "y").context(), "1 other AI session is online:")
}

func TestStaleSessionsGoOfflineAndComeBack(t *testing.T) {
	h := start(t, listenWait(10*time.Second))
	stale := ms(timing.StaleSessionMs)
	h.hook("codex", "SessionStart", "idle")
	h.hook("codex", "UserPromptSubmit", "busy")
	h.hook("codex", "SessionStart", "waiting")
	eq(t, h.codex("waiting", "listen", map[string]any{"on": true}).status, 200)
	waiting := h.openHook("codex", "Stop", "waiting", stopActive) // a Stop hook is waiting for messages
	h.untilStatus("codex:waiting", "listening")

	h.at(stale + time.Second)
	text := h.hook("claude", "SessionStart", "new").context()
	eq(t, h.status("codex:idle"), "offline")
	eq(t, h.status("codex:busy"), "offline")
	eq(t, h.status("codex:waiting"), "listening")
	contains(t, text, "1 other AI session is online:")
	contains(t, text, "(codex:waiting)")

	// Any event brings a session back, a direct-message tool call or Claude's PreToolUse included.
	h.hook("codex", "UserPromptSubmit", "idle")
	eq(t, h.status("codex:idle"), "working")
	self := h.codex("busy", "peers", nil).result["self"].(map[string]any)
	eq(t, self["status"], any("working"))
	h.hook("claude", "SessionStart", "quiet")
	h.at(2*stale + 2*time.Second)
	h.hook("codex", "UserPromptSubmit", "idle") // expires claude:quiet
	eq(t, h.status("claude:quiet"), "offline")
	h.hook("claude", "PreToolUse", "quiet", map[string]any{"tool_use_id": "toolu_quiet"})
	eq(t, h.status("claude:quiet"), "working")

	h.codex("waiting", "listen", map[string]any{"on": false})
	if out := waiting.wait(t); out != nil {
		t.Fatalf("listening Stop printed %v", out)
	}
}

func TestUserPromptSubmitNotification(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "sender")
	h.hook("claude", "SessionStart", "rcv")
	if out := h.hook("claude", "UserPromptSubmit", "rcv"); out != nil {
		t.Fatalf("nothing to tell, got %v", out)
	}
	previewChars := testContract.Hook.Limits.PreviewChars
	long := strings.Repeat("x", previewChars+50)
	h.send("sender", "claude:rcv", long+"\r\nsecond line", false)
	for i := 2; i <= 7; i++ {
		h.send("sender", "claude:rcv", "message "+string(rune('0'+i)), false)
	}
	out := h.hook("claude", "UserPromptSubmit", "rcv")
	eq(t, out["hookSpecificOutput"].(map[string]any)["hookEventName"], any("UserPromptSubmit"))
	text := out.context()
	if !strings.HasPrefix(text, prefix+" 7 unread direct messages:") {
		t.Fatal(text)
	}
	contains(t, text, "From codex@proj (codex:sender) at ")
	contains(t, text, ": "+strings.Repeat("x", previewChars)+"\n")
	notContains(t, text, strings.Repeat("x", previewChars+1))
	notContains(t, text, "second line")
	contains(t, text, "message 5")
	notContains(t, text, "message 6")
	contains(t, text, "...and 2 more")
	contains(t, text, texts.MessageTrustNote+" "+texts.NotifyClosing)
	eq(t, h.status("claude:rcv"), "working")

	// Every unread message was marked notified, so a tool call adds nothing.
	if out := h.hook("claude", "PostToolUse", "rcv"); out != nil {
		t.Fatalf("PostToolUse repeated %v", out)
	}
	// The next prompt still lists them while they are unread.
	contains(t, h.hook("claude", "UserPromptSubmit", "rcv").context(), "7 unread direct messages")
}

func TestPreviewCountsUTF16Units(t *testing.T) {
	h := start(t)
	n := testContract.Hook.Limits.PreviewChars
	emoji := "\U0001F600" // two UTF-16 units
	eq(t, h.ag.preview(strings.Repeat(emoji, n)), strings.Repeat(emoji, n/2))
	eq(t, h.ag.preview("x"+strings.Repeat(emoji, n)), "x"+strings.Repeat(emoji, (n-1)/2))
	eq(t, h.ag.preview("a\rb\nc"), "a\rb")
}

func TestNoticesAlone(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "watcher")
	h.hook("codex", "SessionStart", "target")
	h.send("watcher", "codex:target", "ping", true)
	h.codex("target", "read", nil)
	h.hook("codex", "Stop", "target")
	eq(t, h.hook("codex", "UserPromptSubmit", "watcher").context(), prefix+" Notices:\n- codex@proj#2 (codex:target) finished its turn.")
	if out := h.hook("codex", "UserPromptSubmit", "watcher"); out != nil {
		t.Fatalf("notices are delivered once, got %v", out)
	}
}

func TestPostToolUseOnlyNew(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.send("s", "claude:r", "first", false)
	first := h.hook("claude", "PostToolUse", "r", map[string]any{"tool_use_id": "t1", "tool_name": "Bash"})
	eq(t, first["hookSpecificOutput"].(map[string]any)["hookEventName"], any("PostToolUse"))
	contains(t, first.context(), prefix+" 1 new direct message:")
	contains(t, first.context(), "first")
	eq(t, h.status("claude:r"), "working")
	if out := h.hook("claude", "PostToolUse", "r"); out != nil {
		t.Fatalf("repeated %v", out)
	}
	h.send("s", "claude:r", "second", false)
	second := h.hook("claude", "PostToolUse", "r").context()
	contains(t, second, "second")
	notContains(t, second, "first")
}

func TestStopBlocksOnce(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	if out := h.hook("claude", "Stop", "r", stopInactive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "idle")

	h.send("s", "claude:r", "please look", false)
	h.hook("claude", "UserPromptSubmit", "r") // already notified: Stop still blocks
	blocked := h.hook("claude", "Stop", "r", stopInactive)
	eq(t, blocked.str("decision"), "block")
	if !strings.HasPrefix(blocked.str("reason"), prefix+" 1 unread direct message:") {
		t.Fatal(blocked)
	}
	contains(t, blocked.str("reason"), "please look")
	contains(t, blocked.str("reason"), texts.MessageTrustNote+" "+texts.StopClosing)
	if strings.Contains(blocked.str("reason"), "Automatic turn") { // no limit by default, so no count
		t.Fatal(blocked)
	}
	eq(t, h.status("claude:r"), "working")

	if out := h.hook("claude", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "idle")
}

// ---------------------------------------------------------------------------
// Background wait
// ---------------------------------------------------------------------------

func TestBackgroundWaitWakes(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r", stopInactive)
	waiting := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "wake up", false)
	out := waiting.wait(t)
	contains(t, out.str("wake"), prefix+" 1 new direct message:")
	contains(t, out.str("wake"), "wake up")
	eq(t, h.status("claude:r"), "working")
	if h.hook("claude", "UserPromptSubmit", "r") == nil { // still unread until read
		t.Fatal("expected the unread message on the prompt")
	}
}

func texts0BackgroundWait() string { return testContract.Hook.BackgroundWaitEvent }

func TestBackgroundWaitWhileTurnEnds(t *testing.T) {
	h := start(t, listenWait(5*time.Second))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.send("s", "codex:r", "before the turn ended", false)
	waiting := h.openHook("codex", texts0BackgroundWait(), "r") // started alongside Stop
	h.until("wait registered", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return len(h.ag.backgroundWaits["codex:r"]) == 1 })
	eq(t, h.status("codex:r"), "working")

	// Stop announces the unread message itself; the wait must not repeat it.
	eq(t, h.hook("codex", "Stop", "r", stopInactive).str("decision"), "block")
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "listening")
	h.send("s", "codex:r", "after", false)
	out := waiting.wait(t)
	contains(t, out.str("wake"), "after")
	notContains(t, out.str("wake"), "before the turn ended")
}

func TestBackgroundWaitEnds(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r")

	cancelled := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.hook("claude", "UserPromptSubmit", "r")
	if out := cancelled.wait(t); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "working")

	h.hook("claude", "Stop", "r")
	timedOut := h.openHook("claude", texts0BackgroundWait(), "r")
	eq(t, timedOut.wait(t)["timeout"], any(true))
	eq(t, h.status("claude:r"), "idle")

	gone := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	gone.cancel()
	h.untilStatus("claude:r", "idle")
}

func TestListeningStopDeliversBeforeBackgroundWait(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	background := h.openHook("codex", texts0BackgroundWait(), "r") // registered first
	h.until("wait registered", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return len(h.ag.backgroundWaits["codex:r"]) == 1 })
	listening := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.until("listening stop held", func() bool { h.ag.mu.Lock(); defer h.ag.mu.Unlock(); return h.ag.listeningStops["codex:r"] })
	h.send("s", "codex:r", "for the listening stop", false)
	stop := listening.wait(t)
	eq(t, stop.str("decision"), "block")
	contains(t, stop.str("reason"), "for the listening stop")
	eq(t, background.wait(t)["timeout"], any(true)) // it did not take the message

	// The next listening Stop times out; the client's next background wait delivers what arrives then.
	h.hook("codex", "Stop", "r", stopActive)
	again := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "for the background wait", false)
	out := again.wait(t)
	contains(t, out.str("wake"), "for the background wait")
	notContains(t, out.str("wake"), "for the listening stop")
}

func TestListenOnLeavesListeningWhenNothingWaits(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil { // listening Stop times out
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")
	background := h.openHook("codex", texts0BackgroundWait(), "r")
	h.untilStatus("codex:r", "listening")
	eq(t, background.wait(t)["timeout"], any(true))
	eq(t, h.status("codex:r"), "idle") // the client asks no more: it can go stale
}

func TestBackgroundWaitCountsAsActivity(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "r")
	h.hook("codex", "Stop", "r", stopInactive)
	later := ms(timing.StaleSessionMs) + time.Second
	h.at(later)
	background := h.openHook("codex", texts0BackgroundWait(), "r")
	eq(t, background.wait(t)["timeout"], any(true))
	eq(t, h.session("codex:r").LastActiveAt, store.ISO(h.t0.Add(later)))
	eq(t, h.status("codex:r"), "idle")
	h.hook("claude", "SessionStart", "other") // any event expires stale sessions before the next wait
	eq(t, h.status("codex:r"), "idle")
}

func TestBackgroundWaitUnknownSession(t *testing.T) {
	h := start(t)
	if out := h.hook("claude", texts0BackgroundWait(), "nobody"); out != nil {
		t.Fatal(out)
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_sessions"), 0)
}

// ---------------------------------------------------------------------------
// Automatic turn limit
// ---------------------------------------------------------------------------

func TestAutoTurnLimitWakes(t *testing.T) {
	h := start(t, listenWait(2*time.Second), maxTurns(2))
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r", stopInactive)

	for _, n := range []string{"1", "2"} {
		waiting := h.openHook("claude", texts0BackgroundWait(), "r")
		h.untilStatus("claude:r", "listening")
		h.send("s", "claude:r", "ping "+n, false)
		wake := waiting.wait(t).str("wake")
		contains(t, wake, "ping "+n)
		contains(t, wake, "Automatic turn "+n+" of 2 since your user's last prompt; after turn 2, messages wait until your user prompts again.")
		h.claude("r", "read", nil)
		// The woken turn as the client runs it: its prompt (within the wake window), then the end of the turn.
		h.at(ms(timing.WakePromptWindowMs) / 2)
		h.hook("claude", "UserPromptSubmit", "r")
		h.hook("claude", "Stop", "r", stopInactive)
	}

	// The limit is reached: the wait ends at once and the message only waits, unread and not announced.
	if out := h.openHook("claude", texts0BackgroundWait(), "r").wait(t); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("claude:r"), "idle")
	h.send("s", "claude:r", "ping 3", false)
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'claude:r' AND status = 'unread' AND notified_at IS NULL"), 1)

	// A real prompt (no wake just before it) starts counting again and announces the message.
	contains(t, h.hook("claude", "UserPromptSubmit", "r").context(), "ping 3")
	h.claude("r", "read", nil)
	h.hook("claude", "Stop", "r", stopInactive)
	again := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "ping 4", false)
	contains(t, again.wait(t).str("wake"), "Automatic turn 1 of 2")
}

func TestAutoTurnPromptAfterWakeWindowResets(t *testing.T) {
	h := start(t, listenWait(2*time.Second), maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	h.hook("claude", "Stop", "r", stopInactive)
	waiting := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "ping", false)
	contains(t, waiting.wait(t).str("wake"), "Automatic turn 1 of 1")
	h.claude("r", "read", nil)
	// A prompt later than the wake window is the user's: the count starts again.
	h.at(ms(timing.WakePromptWindowMs) + time.Second)
	h.hook("claude", "UserPromptSubmit", "r")
	h.hook("claude", "Stop", "r", stopInactive)
	again := h.openHook("claude", texts0BackgroundWait(), "r")
	h.untilStatus("claude:r", "listening")
	h.send("s", "claude:r", "pong", false)
	contains(t, again.wait(t).str("wake"), "Automatic turn 1 of 1")
}

func TestAutoTurnLimitStop(t *testing.T) {
	h := start(t, maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	h.send("s", "codex:r", "first", false)
	blocked := h.hook("codex", "Stop", "r", stopInactive)
	eq(t, blocked.str("decision"), "block")
	contains(t, blocked.str("reason"), "Automatic turn 1 of 1")
	h.send("s", "codex:r", "second", false)
	if out := h.hook("codex", "Stop", "r", stopInactive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")
}

func TestAutoTurnLimitListeningStop(t *testing.T) {
	h := start(t, maxTurns(1))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	first := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "one", false)
	contains(t, first.wait(t).str("reason"), "Automatic turn 1 of 1")
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")
}

func TestNoAutoTurnLimit(t *testing.T) {
	h := start(t, maxTurns(0))
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "UserPromptSubmit", "r")
	for i := 0; i < 3; i++ {
		h.send("s", "codex:r", "m", false)
		out := h.hook("codex", "Stop", "r", stopInactive)
		eq(t, out.str("decision"), "block")
		notContains(t, out.str("reason"), "Automatic turn")
		h.codex("r", "read", nil)
	}
}

// ---------------------------------------------------------------------------
// Listen mode
// ---------------------------------------------------------------------------

func TestListeningStopWakes(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	started := time.Now()
	waiting := h.openHook("codex", "Stop", "r", stopInactive)
	h.untilStatus("codex:r", "listening")
	h.send("s", "codex:r", "wake up", false)
	out := waiting.wait(t)
	if time.Since(started) >= listenMS*time.Millisecond {
		t.Fatalf("took %v", time.Since(started))
	}
	eq(t, out.str("decision"), "block")
	contains(t, out.str("reason"), prefix+" 1 new direct message:")
	contains(t, out.str("reason"), "wake up")
	eq(t, h.status("codex:r"), "working")
}

func TestListeningStopTimesOut(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	if out := h.hook("codex", "Stop", "r"); out != nil {
		t.Fatal(out)
	}
	eq(t, h.status("codex:r"), "idle")

	h.send("s", "codex:r", "old news", false)
	h.hook("codex", "UserPromptSubmit", "r")
	started := time.Now()
	if out := h.hook("codex", "Stop", "r", stopActive); out != nil {
		t.Fatal(out)
	}
	if time.Since(started) < (listenMS-20)*time.Millisecond {
		t.Fatalf("returned after %v", time.Since(started))
	}
	eq(t, h.status("codex:r"), "idle")
}

func TestListeningStopReturnsPendingAtOnce(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.send("s", "codex:r", "during continuation", false)
	out := h.hook("codex", "Stop", "r", stopActive)
	contains(t, out.str("reason"), "during continuation")
	eq(t, h.status("codex:r"), "working")
}

func TestListeningStopWokenByNotice(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "watcher")
	h.hook("codex", "SessionStart", "target")
	h.send("watcher", "codex:target", "do it", true)
	h.codex("watcher", "listen", map[string]any{"on": true})
	waiting := h.openHook("codex", "Stop", "watcher")
	h.untilStatus("codex:watcher", "listening")
	h.codex("target", "read", nil)
	if out := h.hook("codex", "Stop", "target"); out != nil {
		t.Fatal(out)
	}
	out := waiting.wait(t)
	eq(t, out.str("decision"), "block")
	if out.str("reason") != prefix+" Notices:\n- codex@proj#2 (codex:target) finished its turn." {
		t.Fatal(out.str("reason"))
	}
}

func TestListeningStopClientDisconnects(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("claude", "SessionStart", "r")
	h.claude("r", "listen", map[string]any{"on": true})
	waiting := h.openHook("claude", "Stop", "r")
	h.untilStatus("claude:r", "listening")
	waiting.cancel()
	h.untilStatus("claude:r", "idle")
}

func TestListeningStopEndsOnSessionEnd(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("claude", "SessionStart", "se")
	h.hook("codex", "SessionStart", "sender")
	h.claude("se", "listen", map[string]any{"on": true})
	waiting := h.openHook("claude", "Stop", "se")
	h.untilStatus("claude:se", "listening")
	if out := h.hook("claude", "SessionEnd", "se"); out != nil {
		t.Fatal(out)
	}
	if out := waiting.wait(t); out != nil {
		t.Fatal(out)
	}
	h.send("sender", "claude:se", "after the end", false)
	eq(t, h.status("claude:se"), "offline")
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE to_id = 'claude:se' AND notified_at IS NULL"), 1)
}

func TestListenOffEndsWait(t *testing.T) {
	h := start(t, listenWait(30*time.Second))
	h.hook("claude", "SessionStart", "off")
	h.claude("off", "listen", map[string]any{"on": true})
	waiting := h.openHook("claude", "Stop", "off")
	h.untilStatus("claude:off", "listening")
	started := time.Now()
	eq(t, h.claude("off", "listen", map[string]any{"on": false}).result["listening"], any(false))
	if out := waiting.wait(t); out != nil {
		t.Fatal(out)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
	eq(t, h.status("claude:off"), "idle")
}

func TestRestartResetsListening(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "r")
	h.codex("r", "listen", map[string]any{"on": true})
	h.stop()
	// Leave the row listening, as a host that crashed during a wait would.
	st, err := store.Open(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.DB.Exec("UPDATE agent_sessions SET status = 'listening' WHERE id = 'codex:r'"); err != nil {
		t.Fatal(err)
	}
	st.Close()
	h.open()
	eq(t, h.status("codex:r"), "idle")
	eq(t, h.session("codex:r").Listening, true)
	// Idle again, it can go stale.
	h.at(ms(timing.StaleSessionMs) + time.Second)
	h.hook("codex", "SessionStart", "other")
	eq(t, h.status("codex:r"), "offline")
}

func TestCloseEndsHeldWaits(t *testing.T) {
	h := start(t, listenWait(time.Minute))
	h.hook("claude", "SessionStart", "sd")
	h.claude("sd", "listen", map[string]any{"on": true})
	h.hook("codex", "SessionStart", "bw")
	h.hook("codex", "Stop", "bw")
	listening := h.openHook("claude", "Stop", "sd")
	background := h.openHook("codex", texts0BackgroundWait(), "bw")
	h.untilStatus("claude:sd", "listening")
	h.untilStatus("codex:bw", "listening")
	started := time.Now()
	h.ag.Close()
	if out := listening.wait(t); out != nil {
		t.Fatal(out)
	}
	if out := background.wait(t); out != nil {
		t.Fatal(out)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
	// A wait asked for after Close ends at once.
	started = time.Now()
	if out := h.hook("codex", texts0BackgroundWait(), "bw"); out != nil {
		t.Fatal(out)
	}
	if time.Since(started) > time.Second {
		t.Fatalf("took %v", time.Since(started))
	}
}

// ---------------------------------------------------------------------------
// Idle subscriptions and expiry
// ---------------------------------------------------------------------------

func TestIdleSubscriptions(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "w")
	h.hook("claude", "SessionStart", "t")

	h.send("w", "claude:t", "task", true)
	h.claude("t", "read", nil)
	h.hook("claude", "Stop", "t")
	contains(t, h.hook("codex", "UserPromptSubmit", "w").context(), "claude@proj (claude:t) finished its turn.")
	h.hook("claude", "Stop", "t") // the subscription was one-shot
	if out := h.hook("codex", "UserPromptSubmit", "w"); out != nil {
		t.Fatal(out)
	}

	// Entering listen mode counts as finishing the turn.
	h.send("w", "claude:t", "task 2", true)
	h.claude("t", "read", nil)
	h.claude("t", "listen", map[string]any{"on": true})
	if out := h.hook("claude", "Stop", "t"); out != nil { // waits, then idle
		t.Fatal(out)
	}
	contains(t, h.hook("codex", "UserPromptSubmit", "w").context(), "finished its turn.")

	h.send("w", "claude:t", "task 3", true)
	h.hook("claude", "SessionEnd", "t")
	contains(t, h.hook("codex", "UserPromptSubmit", "w").context(), "claude@proj (claude:t) went offline.")
}

func TestIdleSubscriptionTTL(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "w")
	h.hook("codex", "SessionStart", "t")
	h.send("w", "codex:t", "task", true)
	h.codex("t", "read", nil)
	h.at(ms(timing.IdleSubscriptionTtlMs) + time.Second)
	h.hook("codex", "Stop", "t")
	if out := h.hook("codex", "UserPromptSubmit", "w"); out != nil {
		t.Fatal(out)
	}
	eq(t, h.count("SELECT COUNT(*) FROM agent_idle_subscriptions"), 0)
}

func TestMessageExpiry(t *testing.T) {
	h := start(t)
	h.hook("codex", "SessionStart", "s")
	h.hook("claude", "SessionStart", "r")
	id := h.send("s", "claude:r", "stale request\nmore", false)
	h.at(ms(timing.MessageTtlMs) + time.Second)
	h.hook("codex", "SessionStart", "other") // any hook runs the expiry check
	eq(t, h.count("SELECT COUNT(*) FROM agent_messages WHERE id = ? AND status = 'expired'", id), 1)
	eq(t, h.hook("codex", "UserPromptSubmit", "s").context(), prefix+" Notices:\n- Your message to claude@proj (claude:r) expired unread: \"stale request\"")
	if out := h.hook("claude", "UserPromptSubmit", "r"); out != nil {
		t.Fatal(out)
	}
	eq(t, len(h.claude("r", "read", nil).result["messages"].([]any)), 0)
}

func TestToolUseBinding(t *testing.T) {
	h := start(t)
	h.hook("claude", "SessionStart", "a")
	if out := h.hook("claude", "PreToolUse", "a", map[string]any{"tool_use_id": "toolu_1"}); out != nil {
		t.Fatal(out)
	}
	call := func(id string) toolReply {
		return h.call(map[string]any{"client": "claude", "toolUseId": id}, "peers", nil)
	}
	eq(t, call("toolu_1").result["self"].(map[string]any)["id"], any("claude:a"))
	r := call("toolu_unknown")
	eq(t, r.status, 400)
	eq(t, r.error, texts.NoAgentSessionError)

	// A PreToolUse without tool_use_id binds nothing.
	h.hook("claude", "PreToolUse", "a")
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings"), 1)

	h.at(ms(timing.ToolUseBindingTtlMs) + time.Second)
	r = call("toolu_1")
	eq(t, r.status, 400)
	eq(t, r.error, texts.NoAgentSessionError)
	eq(t, h.count("SELECT COUNT(*) FROM tool_use_bindings"), 0)
}

func TestSeveralHostsAtOnce(t *testing.T) {
	// The coordinators share nothing: a wait on one host is not woken by another.
	h1 := start(t, listenWait(time.Minute))
	h2 := start(t)
	for _, h := range []*harness{h1, h2} {
		h.hook("codex", "SessionStart", "s")
		h.hook("codex", "SessionStart", "r")
		h.codex("r", "listen", map[string]any{"on": true})
	}
	waiting := h1.openHook("codex", "Stop", "r")
	h1.untilStatus("codex:r", "listening")
	h2.send("s", "codex:r", "on host 2", false)
	select {
	case <-waiting.done:
		t.Fatal("host 1 woke for a message on host 2")
	case <-time.After(100 * time.Millisecond):
	}
	h1.send("s", "codex:r", "on host 1", false)
	contains(t, waiting.wait(t).str("reason"), "on host 1")
}
