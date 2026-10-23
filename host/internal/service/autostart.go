package service

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// autostartFile is the per-user file that starts the tray at login, with its
// content; "" on Windows, where it is a registry value.
func autostartFile(exe string) (path, content string, err error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", "", err
	}
	return autostartFileIn(goos, home, exe)
}

func autostartFileIn(goos, home, exe string) (path, content string, err error) {
	switch goos {
	case "windows":
		return "", "", nil
	case "darwin":
		return filepath.Join(home, "Library", "LaunchAgents", TrayLabel+".plist"), TrayLaunchAgentPlist(exe), nil
	default:
		dir := os.Getenv("XDG_CONFIG_HOME")
		if dir == "" {
			dir = filepath.Join(home, ".config")
		}
		return filepath.Join(dir, "autostart", DesktopEntryName), DesktopEntry(exe), nil
	}
}

// SetAutostart registers (on) or removes the tray's start at login; it returns where.
func SetAutostart(exe string, on bool) (string, error) {
	if goos == "windows" {
		return setRunValue(exe, on)
	}
	path, content, err := autostartFile(exe)
	if err != nil {
		return "", err
	}
	if !on {
		if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return path, err
		}
		return path, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return path, err
	}
	return path, os.WriteFile(path, []byte(content), 0o644)
}

// AutostartEnabled reports whether the tray starts at login.
func AutostartEnabled(exe string) bool {
	if goos == "windows" {
		return runValueSet()
	}
	path, _, err := autostartFile(exe)
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return err == nil
}

// autostartDefaultMarker records in the data directory that the first run has
// applied the default, so a user who turns start at login off keeps it off.
const autostartDefaultMarker = "tray-autostart-default"

// EnsureAutostartDefault turns the tray's start at login on the first time the
// tray runs for dataDir; later runs leave the setting as the user left it.
func EnsureAutostartDefault(dataDir, exe string) error {
	marker := filepath.Join(dataDir, autostartDefaultMarker)
	if _, err := os.Stat(marker); err == nil {
		return nil
	}
	if _, err := SetAutostart(exe, true); err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(marker, []byte("start at login turned on by the first tray run\n"), 0o600)
}

// SetAutostartChoice is an explicit `autostart on|off`: it sets the tray's
// start at login and records the choice, so a later first tray run keeps it.
func SetAutostartChoice(dataDir, exe string, on bool) (string, error) {
	where, err := SetAutostart(exe, on)
	if err != nil {
		return where, err
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return where, err
	}
	return where, os.WriteFile(filepath.Join(dataDir, autostartDefaultMarker), []byte("start at login set by autostart on|off\n"), 0o600)
}
