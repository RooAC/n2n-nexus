package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

func checkTarget(target) error { return nil }

func unitInstalled() bool {
	_, err := os.Stat(SystemdUnitPath)
	return err == nil
}

func stopService(_ target, out io.Writer) error {
	if !unitInstalled() {
		return nil
	}
	if _, err := run("systemctl", "stop", SystemdUnit); err != nil {
		return err
	}
	fmt.Fprintf(out, "Stopped %s.\n", SystemdUnit)
	return nil
}

func register(t target, out io.Writer) error {
	if err := writeRootFile(SystemdUnitPath, SystemdUnitFile(t.exe, t.dataDir, t.user), out); err != nil {
		return err
	}
	if _, err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	if _, err := run("systemctl", "enable", "--now", SystemdUnit); err != nil {
		return err
	}
	fmt.Fprintf(out, "Enabled and started %s (starts at boot, runs as %s).\n", SystemdUnit, t.user)
	return nil
}

func unregister(_ target, out io.Writer) error {
	if !unitInstalled() {
		fmt.Fprintf(out, "%s is not installed.\n", SystemdUnit)
		return nil
	}
	if _, err := run("systemctl", "disable", "--now", SystemdUnit); err != nil {
		return err
	}
	if err := os.Remove(SystemdUnitPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if _, err := run("systemctl", "daemon-reload"); err != nil {
		return err
	}
	fmt.Fprintf(out, "Removed %s.\n", SystemdUnitPath)
	return nil
}

func serviceState(target) string {
	if !unitInstalled() {
		return SystemdUnit + " not installed"
	}
	enabled, _ := run("systemctl", "is-enabled", SystemdUnit)
	active, _ := run("systemctl", "is-active", SystemdUnit)
	return fmt.Sprintf("%s installed, %s, %s", SystemdUnit, enabled, active)
}

func portOwner(port int) string {
	out, _ := run("ss", "-Hltnp", fmt.Sprintf("sport = :%d", port))
	return out
}
