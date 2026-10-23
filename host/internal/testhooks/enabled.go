//go:build testclock

package testhooks

import (
	"encoding/json"
	"flag"
	"net/http"
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
