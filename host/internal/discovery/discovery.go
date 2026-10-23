// Package discovery answers LAN discovery queries ("n2n-nexus/discover" on the
// discovery UDP port) when the host listens on a non-loopback address.
package discovery

import (
	"context"
	"log"
)

// Options configure the responder.
type Options struct {
	Host          string // the address the HTTP server listens on
	HTTPPort      int
	DiscoveryPort int
	Version       string
	Logger        *log.Logger
}

// Start answers queries until ctx ends; it does nothing for a loopback host.
func Start(ctx context.Context, o Options) error {
	// TODO(platform): UDP responder compatible with src/client/discovery.ts.
	return nil
}
