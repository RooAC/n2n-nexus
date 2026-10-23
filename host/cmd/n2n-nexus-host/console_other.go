//go:build !windows

package main

// attachConsole is needed only for the windowsgui build.
func attachConsole() {}

// trayExecutable: only Windows ships a separate tray build.
func trayExecutable(self string) string { return self }

// launchTray: only Windows ships a separate tray build.
func launchTray(string) bool { return false }
