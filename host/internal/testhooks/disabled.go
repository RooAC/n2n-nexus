//go:build !testclock

package testhooks

import (
	"flag"
	"net/http"

	"github.com/n2ns/n2n-nexus/host/internal/clock"
)

// Enabled reports whether this is the conformance-test build.
const Enabled = false

// NewClock returns the system clock.
func NewClock() clock.Clock { return clock.System{} }

// RegisterFlags adds nothing in a release build.
func RegisterFlags(*flag.FlagSet, *Options) {}

// Handler is never routed in a release build.
func Handler(clock.Clock) http.Handler { return http.NotFoundHandler() }
