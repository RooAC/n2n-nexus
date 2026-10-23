package main

import (
	"os"

	"golang.org/x/sys/windows"
)

var procAttachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

const attachParentProcess = ^uintptr(0) // ATTACH_PARENT_PROCESS, (DWORD)-1

// attachConsole connects a windowsgui build's standard output and error to
// the console of the terminal that started it. Handles that are already set
// (redirected to a file or pipe) are kept.
func attachConsole() {
	stdout, _ := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE)
	stderr, _ := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	unset := func(h windows.Handle) bool { return h == 0 || h == windows.InvalidHandle }
	if !unset(stdout) && !unset(stderr) {
		return
	}
	if r, _, _ := procAttachConsole.Call(attachParentProcess); r == 0 {
		return
	}
	con, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0)
	if err != nil {
		return
	}
	if unset(stdout) {
		os.Stdout = con
		_ = windows.SetStdHandle(windows.STD_OUTPUT_HANDLE, windows.Handle(con.Fd()))
	}
	if unset(stderr) {
		os.Stderr = con
		_ = windows.SetStdHandle(windows.STD_ERROR_HANDLE, windows.Handle(con.Fd()))
	}
}
