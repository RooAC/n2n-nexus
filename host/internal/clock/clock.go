// Package clock is the host's time source: the system clock, or under the
// testclock build tag a clock the conformance tests set (see testhooks).
package clock

import (
	"sync"
	"time"
)

// Clock returns the current time.
type Clock interface {
	Now() time.Time
}

// System is the real clock.
type System struct{}

func (System) Now() time.Time { return time.Now() }

// Settable starts on the system clock; Set pins it to a fixed instant, Reset releases it.
type Settable struct {
	mu    sync.Mutex
	fixed *time.Time
}

func (c *Settable) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fixed != nil {
		return *c.fixed
	}
	return time.Now()
}

func (c *Settable) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fixed = &t
}

func (c *Settable) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fixed = nil
}
