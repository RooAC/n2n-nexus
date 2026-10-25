package service

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// DefaultInstallDir is where `install` puts the programs: %LOCALAPPDATA%\Programs\n2n-nexus-host.
func DefaultInstallDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "n2n-nexus-host")
}

// SelfInstall installs or upgrades the host from the folder of o.Exe (a
// release's n2n-nexus-host.exe and n2n-nexus-host-tray.exe) into o.Dir: it
// ends the trays running from o.Dir, replaces the programs, restarts the
// background service when it runs o.Dir's program (as administrator, after a
// UAC prompt), keeps or turns on start at login, and starts the tray.
func SelfInstall(o SelfInstallOptions) error {
	srcDir := filepath.Dir(o.Exe)
	dir := o.Dir
	if dir == "" {
		dir = DefaultInstallDir()
	}
	dir, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	for _, name := range installedPrograms {
		if _, err := os.Stat(filepath.Join(srcDir, name)); err != nil {
			return fmt.Errorf("%s is not next to %s: run install from the folder of an extracted release", name, o.Exe)
		}
	}
	program, tray := filepath.Join(dir, installedPrograms[0]), filepath.Join(dir, installedPrograms[1])
	same := strings.EqualFold(filepath.Clean(srcDir), filepath.Clean(dir))

	// The service, when it runs this folder's program, is restarted on the new one.
	service := false
	if _, out, err := RunPowerShell(WindowsTaskExeScript()); err == nil {
		service = strings.EqualFold(filepath.Clean(strings.TrimSpace(out)), program)
	}

	if !same {
		for _, pid := range processesRunning(tray) {
			if err := KillPID(pid); err != nil {
				return fmt.Errorf("end the n2n-nexus-host tray (PID %d): %w", pid, err)
			}
			fmt.Fprintf(o.Out, "Ended the n2n-nexus-host tray (PID %d).\n", pid)
		}
		for i := 0; i < 50 && len(processesRunning(tray)) > 0; i++ {
			time.Sleep(100 * time.Millisecond)
		}
		if err := ReplacePrograms(srcDir, dir, installedPrograms); err != nil {
			return err
		}
		fmt.Fprintf(o.Out, "Installed n2n-nexus-host into %s.\n", dir)
		if service {
			if err := restartServiceElevated(program, o); err != nil {
				fmt.Fprintf(o.Out, "The background service still runs the previous version: %v. Run \"%s\" service install from an administrator terminal.\n", err, program)
			}
		}
	} else {
		fmt.Fprintf(o.Out, "n2n-nexus-host is installed in %s.\n", dir)
	}

	// Start at login: on for a first install, kept as the user left it, refreshed when it runs this folder's tray.
	current := strings.Trim(runValue(), `"`)
	switch {
	case current == "":
		if err := EnsureAutostartDefault(tray); err != nil {
			return err
		}
		if runValue() != "" {
			fmt.Fprintln(o.Out, "The tray starts at login (tray menu: Start at login).")
		}
	case strings.EqualFold(filepath.Dir(filepath.Clean(current)), dir):
		if _, err := SetAutostart(tray, true); err != nil {
			return err
		}
		fmt.Fprintln(o.Out, "The tray starts at login (tray menu: Start at login).")
	default:
		fmt.Fprintf(o.Out, "Start at login runs %s, not this installation; turn it off there and on in this tray's menu to switch.\n", current)
	}

	if len(processesRunning(tray)) == 0 {
		cmd := exec.Command(tray)
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.DETACHED_PROCESS | windows.CREATE_NEW_PROCESS_GROUP}
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start the tray: %w", err)
		}
		_ = cmd.Process.Release()
		fmt.Fprintln(o.Out, "Started the n2n-nexus-host tray.")
	}
	removeLeftovers(dir)
	fmt.Fprintf(o.Out, "Commands: \"%s\" (or add %s to PATH). To upgrade, run install again from a newer release.\n", program, dir)
	return nil
}

// restartServiceElevated re-registers the service on program (`service
// install`, which keeps settings.json) as administrator and prints its output.
func restartServiceElevated(program string, o SelfInstallOptions) error {
	out, err := os.CreateTemp("", "n2n-nexus-host-install-*.log")
	if err != nil {
		return err
	}
	out.Close()
	defer os.Remove(out.Name())
	fmt.Fprintln(o.Out, "Restarting the background service on the new version (confirm the administrator prompt).")
	code, output, err := RunPowerShell(WindowsElevatedScript(program, []string{"service", "install"}, out.Name()))
	if text, readErr := os.ReadFile(out.Name()); readErr == nil {
		// Out-File writes UTF-8 with a byte order mark.
		if s := strings.TrimSpace(strings.TrimPrefix(string(text), "\uFEFF")); s != "" {
			fmt.Fprintln(o.Out, s)
		}
	}
	if err != nil {
		return err
	}
	if code != 0 {
		if s := strings.TrimSpace(output); s != "" {
			return errors.New(s)
		}
		return fmt.Errorf("service install exited with %d", code)
	}
	return nil
}

// processesRunning lists the processes whose program is exe (other than this one).
func processesRunning(exe string) []int {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snapshot)
	var pids []int
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	self := uint32(os.Getpid())
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if entry.ProcessID == self || !strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(exe)) {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
		if err != nil {
			continue
		}
		buf := make([]uint16, windows.MAX_LONG_PATH)
		size := uint32(len(buf))
		err = windows.QueryFullProcessImageName(h, 0, &buf[0], &size)
		windows.CloseHandle(h)
		if err == nil && strings.EqualFold(filepath.Clean(windows.UTF16ToString(buf[:size])), filepath.Clean(exe)) {
			pids = append(pids, int(entry.ProcessID))
		}
	}
	return pids
}
