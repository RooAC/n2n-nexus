//go:build testclock

package testhooks

import (
	"encoding/json"
	"flag"
	"net/http"
	"sync"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/clock"
)

// Enabled reports whether this is the conformance-test build.
const Enabled = true

// NewClock returns the settable clock the tests drive.
func NewClock() clock.Clock { return &clock.Settable{} }

// RegisterFlags adds the test-only serve flags.
func RegisterFlags(fs *flag.FlagSet, o *Options) {
	fs.Int64Var(&o.ListenWaitMs, "test-listen-wait-ms", 0, "test build: listening wait in ms")
}

var (
	shutdown     = make(chan struct{})
	shutdownOnce sync.Once
)

// Shutdown is closed when a test asks the host to stop gracefully (POST /test/shutdown),
// as SIGTERM does; Windows has no SIGTERM a test could send.
func Shutdown() <-chan struct{} { return shutdown }

// ShutdownHandler serves POST /test/shutdown.
func ShutdownHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"ok":false,"error":"POST"}`, http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
		shutdownOnce.Do(func() { close(shutdown) })
	})
}

// Handler serves POST /test/clock {"now": <ms>} (pin the clock) or {"now": null} (release it).
func Handler(c clock.Clock) http.Handler {
	settable := c.(*clock.Settable)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Now *int64 `json:"now"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, `{"ok":false,"error":"POST {\"now\": <ms> | null}"}`, http.StatusBadRequest)
			return
		}
		if body.Now == nil {
			settable.Reset()
		} else {
			settable.Set(time.UnixMilli(*body.Now))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
}
