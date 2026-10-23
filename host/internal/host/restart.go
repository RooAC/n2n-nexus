package host

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// RestartRequestFile in the data directory asks a supervised serve to exit, so
// that its supervisor starts it again with the current settings. A file works
// across logon sessions: the tray cannot end a service process that runs under
// the scheduled task's S4U logon (OpenProcess is denied), but it can write here.
const RestartRequestFile = "restart-request"

// RequestRestart asks the supervised serve for dataDir to restart.
func RequestRestart(dataDir string) error {
	return os.WriteFile(filepath.Join(dataDir, RestartRequestFile), []byte("restart\n"), 0o600)
}

// WatchRestart polls for a restart request every interval until done closes;
// it removes the request and calls onRequest once.
func WatchRestart(dataDir string, interval time.Duration, done <-chan struct{}, onRequest func()) {
	path := filepath.Join(dataDir, RestartRequestFile)
	_ = os.Remove(path) // a request left from before this start is already served
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) || err != nil {
					continue
				}
				_ = os.Remove(path)
				onRequest()
				return
			}
		}
	}()
}
