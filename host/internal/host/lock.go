package host

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/gofrs/flock"
)

// SupervisorEnv names the variable `serve --supervise` sets for its child: the
// supervisor's PID, which the child records in host.lock next to its own.
const SupervisorEnv = "N2N_NEXUS_HOST_SUPERVISOR"

// Roles of a lock holder, recorded in host.lock.
const (
	RoleTray       = "tray"       // a tray running the host in-process
	RoleServe      = "serve"      // serve in the foreground
	RoleSupervised = "supervised" // serve started by `serve --supervise` (the service)
)

// LockFile is the single-instance lock of a data directory.
func LockFile(dataDir string) string { return filepath.Join(dataDir, "host.lock") }

// The PID record starts at this offset: on Windows the lock is a mandatory
// byte-range lock on byte 0, so other processes can read only what follows it.
const lockRecordOffset = 1

// Lock is a held host.lock.
type Lock struct {
	fl *flock.Flock
}

// LockInfo describes a data directory's lock.
type LockInfo struct {
	Held       bool   // a running host holds it
	PID        int    // the holder's PID (0 if not recorded)
	Supervisor int    // the PID of its `serve --supervise`, 0 if none
	Role       string // RoleTray, RoleServe or RoleSupervised ("" if not recorded)
}

// AcquireLock takes host.lock in dataDir and records pid, supervisor and role in it.
func AcquireLock(dataDir string, pid, supervisor int, role string) (*Lock, error) {
	fl := flock.New(LockFile(dataDir))
	ok, err := fl.TryLock()
	if err != nil {
		return nil, fmt.Errorf("lock %s: %w", LockFile(dataDir), err)
	}
	if !ok {
		msg := fmt.Sprintf("another n2n-nexus-host is running for %s", dataDir)
		if info, _ := ReadLock(dataDir); info.PID > 0 {
			msg += fmt.Sprintf(" (PID %d)", info.PID)
		}
		return nil, errors.New(msg)
	}
	if err := writeRecord(dataDir, pid, supervisor, role); err != nil {
		_ = fl.Unlock()
		return nil, err
	}
	return &Lock{fl: fl}, nil
}

func writeRecord(dataDir string, pid, supervisor int, role string) error {
	f, err := os.OpenFile(LockFile(dataDir), os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := f.Truncate(lockRecordOffset); err != nil {
		return err
	}
	_, err = f.WriteAt([]byte(fmt.Sprintf("pid=%d supervisor=%d role=%s\n", pid, supervisor, role)), lockRecordOffset)
	return err
}

// Release unlocks host.lock (the file stays).
func (l *Lock) Release() {
	if l != nil {
		_ = l.fl.Unlock()
	}
}

// ReadLock tells whether a host holds dataDir's lock and which PIDs and role it recorded.
func ReadLock(dataDir string) (LockInfo, error) {
	var info LockInfo
	f, err := os.Open(LockFile(dataDir))
	if errors.Is(err, fs.ErrNotExist) {
		return info, nil
	}
	if err != nil {
		return info, err
	}
	buf := make([]byte, 128)
	n, _ := f.ReadAt(buf, lockRecordOffset)
	f.Close()
	info.PID, info.Supervisor, info.Role = parseRecord(string(buf[:n]))

	fl := flock.New(LockFile(dataDir))
	ok, err := fl.TryLock()
	if err != nil {
		return info, err
	}
	if ok {
		_ = fl.Unlock()
	}
	info.Held = !ok
	return info, nil
}

func parseRecord(s string) (pid, supervisor int, role string) {
	for _, field := range strings.Fields(s) {
		k, v, _ := strings.Cut(field, "=")
		n, _ := strconv.Atoi(v)
		switch k {
		case "pid":
			pid = n
		case "supervisor":
			supervisor = n
		case "role":
			role = v
		}
	}
	return pid, supervisor, role
}
