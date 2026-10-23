//go:build !windows

package tray

import (
	"os/exec"
	"runtime"
	"strings"
)

// appleScriptString is an AppleScript string literal.
func appleScriptString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s) + `"`
}

// notice shows a dialog on macOS and a desktop notification elsewhere (when notify-send exists).
func notice(title, msg string) {
	if runtime.GOOS == "darwin" {
		_ = exec.Command("osascript", "-e",
			"display dialog "+appleScriptString(msg)+" with title "+appleScriptString(title)+` buttons {"OK"} default button 1`).Run()
		return
	}
	_ = exec.Command("notify-send", title, msg).Run()
}

// allowLAN does not change the firewall outside Windows; the user is told the ports instead.
func allowLAN(int, int) error { return nil }

// lanNeedsNotice reports whether turning LAN on should tell the user which ports to open.
const lanNeedsNotice = true
