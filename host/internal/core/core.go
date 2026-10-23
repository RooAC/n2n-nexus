// Package core implements the project, document, meeting, chat, event and
// task tools and their tables (store/migrations/0001_core.sql).
package core

import (
	"context"
	"log"

	"github.com/n2ns/n2n-nexus/host/internal/api"
	"github.com/n2ns/n2n-nexus/host/internal/clock"
	"github.com/n2ns/n2n-nexus/host/internal/protocol"
	"github.com/n2ns/n2n-nexus/host/internal/store"
)

// Deps are what the core tools need.
type Deps struct {
	Store    *store.Store
	Clock    clock.Clock
	Contract *protocol.Contract
	Logger   *log.Logger
}

// Core holds the core tools.
type Core struct {
	d Deps
}

// New returns the core tools.
func New(d Deps) *Core { return &Core{d: d} }

// Register adds every core tool to srv.
func (c *Core) Register(srv *api.Server) {
	// TODO(core): register sync_project_assets ... host_delete_project, update_task.
}

// Maintain expires and purges old core rows (events after 30 days, tasks per
// their TTL and 7 days after they finish); it returns a log line or "".
func (c *Core) Maintain(ctx context.Context) (string, error) {
	return "", nil
}
