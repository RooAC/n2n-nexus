//go:build !windows

package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

// HideWindow does nothing outside Windows.
func HideWindow(*exec.Cmd) {}

// currentTarget is the invoking user: under sudo the user in SUDO_USER, whose
// default data and log directories are used, else the current user.
func currentTarget(exe string) (target, error) {
	t := target{exe: exe, dataDir: config.DataDir(), logDir: config.LogDir(), uid: -1, gid: -1}
	if name := os.Getenv("SUDO_USER"); os.Geteuid() == 0 && name != "" && name != "root" {
		u, err := user.Lookup(name)
		if err != nil {
			return t, fmt.Errorf("SUDO_USER %s: %w", name, err)
		}
		uid, _ := strconv.Atoi(u.Uid)
		gid, _ := strconv.Atoi(u.Gid)
		t.user, t.home, t.uid, t.gid = u.Username, u.HomeDir, uid, gid
		t.dataDir, t.logDir = config.DataDirIn(u.HomeDir), config.LogDirIn(u.HomeDir)
		return t, nil
	}
	u, err := user.Current()
	if err != nil {
		return t, err
	}
	t.user, t.home = u.Username, u.HomeDir
	return t, nil
}

func requireAdmin() error {
	if os.Geteuid() != 0 {
		return ErrNotElevated
	}
	return nil
}

// mkdirOwned creates dir and its missing parents, owned by the target user.
func mkdirOwned(t target, dir string) error {
	var missing []string
	for d := dir; ; d = filepath.Dir(d) {
		if _, err := os.Stat(d); !errors.Is(err, fs.ErrNotExist) {
			break
		}
		missing = append(missing, d)
		if filepath.Dir(d) == d {
			break
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	for _, d := range missing {
		if err := chownTo(t, d); err != nil {
			return err
		}
	}
	return nil
}

func chownTo(t target, path string) error {
	if t.uid < 0 {
		return nil
	}
	return os.Chown(path, t.uid, t.gid)
}

// StopPID asks process pid to end (SIGTERM).
func StopPID(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// KillPID ends process pid at once (SIGKILL).
func KillPID(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }

// run runs a command and returns its trimmed combined output.
func run(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	text := strings.TrimSpace(string(out))
	if err != nil && text != "" {
		err = fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), text)
	}
	return text, err
}

// writeRootFile writes a root-owned file readable by everyone (a unit or plist).
func writeRootFile(path, content string, out io.Writer) error {
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(out, "Wrote %s.\n", path)
	return nil
}
