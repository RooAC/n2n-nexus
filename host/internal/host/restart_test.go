package host

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRestartRequest(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, RestartRequestFile)
	// A request older than this serve's start was served by an earlier one: ignored and removed.
	if err := RequestRestart(dir); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	since := time.Now()
	got := make(chan struct{}, 2)
	done := make(chan struct{})
	defer close(done)
	WatchRestart(dir, since, 20*time.Millisecond, done, func() { got <- struct{}{} })
	select {
	case <-got:
		t.Fatal("acted on a stale request")
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("stale request not removed")
	}
	if err := RequestRestart(dir); err != nil {
		t.Fatal(err)
	}
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("restart request not seen")
	}
}

// A request written while this serve was starting (after since, before the
// watch began) is served, not removed as stale: it carries settings the serve
// may not have loaded.
func TestRestartRequestDuringStartup(t *testing.T) {
	dir := t.TempDir()
	since := time.Now().Add(-time.Second)
	if err := RequestRestart(dir); err != nil {
		t.Fatal(err)
	}
	got := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)
	WatchRestart(dir, since, 20*time.Millisecond, done, func() { got <- struct{}{} })
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("a request from the startup window was dropped")
	}
}
