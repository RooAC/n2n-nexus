// Package agents implements the conversations: agent sessions created by the
// client hooks (POST /api/hook), the direct-message tools (peers, send, read,
// reply, listen, set_profile), the listening / background-wait state machine
// and their tables (store/migrations/0002_agents.sql).
package agents

import (
	"context"
	"log"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// Options configure the agents.
type Options struct {
	Store    *store.Store
	Clock    clock.Clock
	Contract *protocol.Contract
	Logger   *log.Logger
	// ListenWait is how long a listening Stop hook and one background-wait round are held open.
	ListenWait time.Duration
	// MaxAutoTurns limits automatic turns between user prompts; 0 = no limit.
	MaxAutoTurns int
}

// Agents is the conversation state of one host.
type Agents struct {
	o Options
}

// New returns the agents of a host whose database was just opened (it resets
// sessions a previous host left listening).
func New(o Options) (*Agents, error) {
	return &Agents{o: o}, nil
}

// Register adds the direct-message tools and the hook handler to srv.
func (a *Agents) Register(srv *api.Server) {
	// TODO(agents): register peers, send, read, reply, listen, set_profile and srv.SetHook.
}

// Maintain expires and purges old rows (read or expired direct messages and
// delivered notices after 30 days, expired tool-use bindings); it returns a log line or "".
func (a *Agents) Maintain(ctx context.Context) (string, error) {
	return "", nil
}

// Close ends every held wait (host shutting down).
func (a *Agents) Close() {}
