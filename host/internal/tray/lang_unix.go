//go:build !windows

package tray

import (
	"os/exec"
	"runtime"
	"strings"
)

// systemChinese reports whether the locale (LC_ALL, LC_MESSAGES, LANG) is
// Chinese. On macOS a tray started by its LaunchAgent has none of them set, so
// the system language is read from the user defaults then.
func systemChinese() bool {
	locale := envLocale()
	if locale == "" && runtime.GOOS == "darwin" {
		locale = macLanguage()
	}
	return isChineseLocale(locale)
}

// macLanguage is the first of the user's preferred languages (AppleLanguages),
// else the region format (AppleLocale).
func macLanguage() string {
	if out, err := exec.Command("defaults", "read", "-g", "AppleLanguages").Output(); err == nil {
		if lang := firstAppleLanguage(string(out)); lang != "" {
			return lang
		}
	}
	out, _ := exec.Command("defaults", "read", "-g", "AppleLocale").Output()
	return strings.TrimSpace(string(out))
}
