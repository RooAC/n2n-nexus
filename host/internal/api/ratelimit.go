package api

import (
	"math"
	"sync"
	"time"
)

// RateLimiter is a token bucket per key: `burst` calls at once, refilled at
// `perSecond`. perSecond 0 disables it; burst is at least 1.
type RateLimiter struct {
	mu        sync.Mutex
	perSecond float64
	burst     float64
	now       func() time.Time
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens  float64
	updated time.Time
}

// NewRateLimiter returns a limiter reading the time from now.
func NewRateLimiter(perSecond, burst float64, now func() time.Time) *RateLimiter {
	return &RateLimiter{perSecond: perSecond, burst: math.Max(1, burst), now: now, buckets: map[string]*bucket{}}
}

// Take takes one token for key: 0 when allowed, else whole seconds until a token is available.
func (l *RateLimiter) Take(key string) int {
	if l.perSecond <= 0 {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	t := l.now()
	l.sweep(t)
	b := l.buckets[key]
	if b == nil {
		b = &bucket{tokens: l.burst, updated: t}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.burst, b.tokens+t.Sub(b.updated).Seconds()*l.perSecond)
	b.updated = t
	if b.tokens >= 1 {
		b.tokens--
		return 0
	}
	return int(math.Max(1, math.Ceil((1-b.tokens)/l.perSecond)))
}

// sweep drops buckets that have refilled completely, so keys that stop calling do not accumulate.
func (l *RateLimiter) sweep(t time.Time) {
	if t.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = t
	full := time.Duration(l.burst / l.perSecond * float64(time.Second))
	for k, b := range l.buckets {
		if t.Sub(b.updated) >= full {
			delete(l.buckets, k)
		}
	}
}
