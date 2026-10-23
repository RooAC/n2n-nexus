package tray

import "golang.org/x/sys/windows"

var getUserDefaultUILanguage = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetUserDefaultUILanguage")

// systemChinese reports whether the Windows display language is Chinese.
func systemChinese() bool {
	if getUserDefaultUILanguage.Find() != nil {
		return false
	}
	id, _, _ := getUserDefaultUILanguage.Call()
	return isChineseLangID(uint16(id))
}
