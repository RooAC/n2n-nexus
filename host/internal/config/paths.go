// Package config resolves the host's data and log directories and loads
// settings.json, the one place the tray, the service and the command line
// read the daemon settings from.
package config

import (
	"os"
	"path/filepath"
	"runtime"
)

const appDir = "n2n-nexus"

// DataDir is NEXUS_ROOT when set, else the platform's per-user data directory.
func DataDir() string {
	if root := os.Getenv("NEXUS_ROOT"); root != "" {
		return root
	}
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, appDir)
		}
		return filepath.Join(home, "AppData", "Local", appDir)
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", appDir)
	default:
		if dir := os.Getenv("XDG_DATA_HOME"); dir != "" {
			return filepath.Join(dir, appDir)
		}
		return filepath.Join(home, ".local", "share", appDir)
	}
}

// LogDir is the platform's per-user log directory.
func LogDir() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			return filepath.Join(dir, appDir, "logs")
		}
		return filepath.Join(home, "AppData", "Local", appDir, "logs")
	case "darwin":
		return filepath.Join(home, "Library", "Logs", appDir)
	default:
		if dir := os.Getenv("XDG_STATE_HOME"); dir != "" {
			return filepath.Join(dir, appDir)
		}
		return filepath.Join(home, ".local", "state", appDir)
	}
}
