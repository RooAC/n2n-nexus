package host

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

// A listening Stop hook held open when the host stops gets {"output": null}, like any ended wait.
func TestStopAnswersHeldHooks(t *testing.T) {
	settings := config.Defaults()
	settings.Port = 0
	h, err := Start(Options{Version: "test", DataDir: t.TempDir(), Settings: settings, Logger: log.New(io.Discard, "", 0)})
	if err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("http://%s", h.Addr)
	post := func(path string, body any) (*http.Response, error) {
		raw, _ := json.Marshal(body)
		return http.Post(base+path, "application/json", bytes.NewReader(raw))
	}
	hook := func(event string, extra map[string]any) map[string]any {
		input := map[string]any{"hook_event_name": event, "session_id": "s", "cwd": "/tmp/x"}
		for k, v := range extra {
			input[k] = v
		}
		return map[string]any{"client": "codex", "input": input}
	}
	for _, step := range []map[string]any{hook("SessionStart", nil)} {
		if res, err := post("/api/hook", step); err != nil || res.StatusCode != 200 {
			t.Fatalf("SessionStart: %v %v", res, err)
		}
	}
	if res, err := post("/api/tools/call", map[string]any{"tool": "listen", "args": map[string]any{"on": true}, "instanceId": "i", "caller": map[string]any{"client": "codex", "sessionId": "s"}}); err != nil || res.StatusCode != 200 {
		t.Fatalf("listen: %v %v", res, err)
	}
	type result struct {
		status int
		body   string
		err    error
	}
	done := make(chan result, 1)
	go func() {
		res, err := post("/api/hook", hook("Stop", map[string]any{"stop_hook_active": true}))
		if err != nil {
			done <- result{err: err}
			return
		}
		b, _ := io.ReadAll(res.Body)
		done <- result{status: res.StatusCode, body: string(b)}
	}()
	time.Sleep(300 * time.Millisecond) // the Stop hook is now held open
	h.Stop()
	select {
	case r := <-done:
		if r.err != nil || r.status != 200 || r.body != `{"output":null}` {
			t.Fatalf("held Stop hook got %d %q %v; want 200 {\"output\":null}", r.status, r.body, r.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("held Stop hook did not return")
	}
}
