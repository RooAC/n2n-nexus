package host

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRestartRequest(t *testing.T) {
	dir := t.TempDir()
	// A request left over from before the start is not acted on.
	if err := RequestRestart(dir); err != nil {
		t.Fatal(err)
	}
	got := make(chan struct{}, 2)
	done := make(chan struct{})
	defer close(done)
	WatchRestart(dir, 20*time.Millisecond, done, func() { got <- struct{}{} })
	select {
	case <-got:
		t.Fatal("acted on a stale request")
	case <-time.After(100 * time.Millisecond):
	}
	if err := RequestRestart(dir); err != nil {
		t.Fatal(err)
	}
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("restart request not seen")
	}
	if _, err := os.Stat(filepath.Join(dir, RestartRequestFile)); !os.IsNotExist(err) {
		t.Fatal("request not removed")
	}
}
