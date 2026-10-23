// Package testhooks holds what only the conformance-test build (go build
// -tags testclock) exposes: a settable clock behind POST /test/clock and a
// shorter listening wait. Release builds compile none of it.
package testhooks

// Options are the test-build settings, read from serve's test-only flags.
type Options struct {
	// ListenWaitMs overrides the listening wait of contract/hook.json when > 0.
	ListenWaitMs int64
}
