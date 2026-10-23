package service

import (
	"runtime"
	"testing"
)

// The tray starts at login by default: the first run turns it on, later runs
// leave the user's choice alone.
func TestAutostartDefaultsOnOnce(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("uses the Linux autostart file under a temporary HOME")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	data := t.TempDir()
	if err := EnsureAutostartDefault(data, "/x/n2n-nexus-host"); err != nil {
		t.Fatal(err)
	}
	if !AutostartEnabled("/x/n2n-nexus-host") {
		t.Fatal("first run did not turn on start at login")
	}
	if _, err := SetAutostart("/x/n2n-nexus-host", false); err != nil {
		t.Fatal(err)
	}
	if err := EnsureAutostartDefault(data, "/x/n2n-nexus-host"); err != nil {
		t.Fatal(err)
	}
	if AutostartEnabled("/x/n2n-nexus-host") {
		t.Fatal("a later run turned start at login back on after the user turned it off")
	}
}

// An explicit `autostart on|off` before the first tray run is the user's choice: the tray keeps it.
func TestAutostartChoiceBeforeFirstTrayRun(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("uses the Linux autostart file under a temporary HOME")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", "")
	data := t.TempDir()
	if _, err := SetAutostartChoice(data, "/x/n2n-nexus-host", false); err != nil {
		t.Fatal(err)
	}
	if err := EnsureAutostartDefault(data, "/x/n2n-nexus-host"); err != nil {
		t.Fatal(err)
	}
	if AutostartEnabled("/x/n2n-nexus-host") {
		t.Fatal("the first tray run overrode autostart off")
	}
}
