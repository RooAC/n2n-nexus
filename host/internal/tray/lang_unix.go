//go:build !windows

package tray

// systemChinese reports whether the locale (LC_ALL, LC_MESSAGES, LANG) is Chinese.
func systemChinese() bool { return isChineseLocale(envLocale()) }
