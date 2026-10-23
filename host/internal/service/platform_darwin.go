package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

const launchdTarget = "system/" + DaemonLabel

func checkTarget(target) error { return nil }

func daemonLoaded() bool {
	_, err := run("launchctl", "print", launchdTarget)
	return err == nil
}

func stopService(_ target, out io.Writer) error {
	if !daemonLoaded() {
		return nil
	}
	if _, err := run("launchctl", "bootout", launchdTarget); err != nil {
		return err
	}
	fmt.Fprintf(out, "Stopped LaunchDaemon %s.\n", DaemonLabel)
	return nil
}

func register(t target, out io.Writer) error {
	if err := writeRootFile(DaemonPlistPath, LaunchDaemonPlist(t.exe, t.dataDir, t.logDir, t.user, t.home), out); err != nil {
		return err
	}
	if _, err := run("launchctl", "bootstrap", "system", DaemonPlistPath); err != nil {
		return err
	}
	fmt.Fprintf(out, "Loaded LaunchDaemon %s (starts at boot, runs as %s).\n", DaemonLabel, t.user)
	return nil
}

func unregister(t target, out io.Writer) error {
	if err := stopService(t, out); err != nil {
		return err
	}
	err := os.Remove(DaemonPlistPath)
	if errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(out, "LaunchDaemon %s is not installed.\n", DaemonLabel)
		return nil
	}
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "Removed %s.\n", DaemonPlistPath)
	return nil
}

func serviceState(target) string {
	if _, err := os.Stat(DaemonPlistPath); err != nil {
		return fmt.Sprintf("LaunchDaemon %s not installed", DaemonLabel)
	}
	if daemonLoaded() {
		return fmt.Sprintf("LaunchDaemon %s installed and loaded", DaemonLabel)
	}
	return fmt.Sprintf("LaunchDaemon %s installed, not loaded", DaemonLabel)
}

func portOwner(port int) string {
	out, _ := run("lsof", "-nP", fmt.Sprintf("-iTCP:%d", port), "-sTCP:LISTEN")
	return out
}
