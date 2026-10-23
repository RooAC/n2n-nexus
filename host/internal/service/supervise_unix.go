//go:build !windows

package service

import (
	"os"
	"syscall"
	"time"
)

type childJobs struct{}

func newChildJobs() (*childJobs, error) { return &childJobs{}, nil }
func (*childJobs) add(int)              {}
func (*childJobs) close()               {}

// terminate asks the child to shut down cleanly.
func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

// WatchSupervisor calls gone once the process is no longer a child of
// supervisor (the supervisor ended), so a supervised serve never outlives it.
func WatchSupervisor(supervisor int, gone func()) {
	go func() {
		for os.Getppid() == supervisor {
			time.Sleep(time.Second)
		}
		gone()
	}()
}
