package service

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"syscall"

	"github.com/n2ns/n2n-nexus/host/internal/config"
)

const createNoWindow = 0x08000000

// HideWindow keeps a console child (powershell.exe, netsh) of this GUI program from opening a window.
func HideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// RunPowerShell runs script with Windows PowerShell and returns its exit code and combined output.
func RunPowerShell(script string) (int, string, error) {
	cmd := exec.Command("powershell.exe", PowerShellArgs(script)...)
	HideWindow(cmd)
	out, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode(), string(out), nil
	}
	if err != nil {
		return -1, string(out), err
	}
	return 0, string(out), nil
}

// runScript runs script, prints its output and turns a failure into an error.
func runScript(script string, out io.Writer) error {
	code, output, err := RunPowerShell(script)
	if err != nil {
		return err
	}
	if code == NotElevatedExit {
		return ErrNotElevated
	}
	output = strings.TrimSpace(output)
	if code != 0 {
		if output == "" {
			output = fmt.Sprintf("PowerShell exited with %d", code)
		}
		return errors.New(output)
	}
	if output != "" {
		fmt.Fprintln(out, output)
	}
	return nil
}

func currentTarget(exe string) (target, error) {
	u, err := user.Current()
	if err != nil {
		return target{}, err
	}
	return target{exe: exe, dataDir: config.DataDir(), logDir: config.LogDir(), user: u.Username, uid: -1, gid: -1}, nil
}

func requireAdmin() error { return runScript(WindowsCheckAdminScript(), io.Discard) }

func checkTarget(t target) error {
	if err := CheckWindowsPath("--root", t.dataDir); err != nil {
		return err
	}
	return CheckWindowsPath("executable", t.exe)
}

func stopService(_ target, out io.Writer) error { return runScript(WindowsStopTaskScript(), out) }

func register(t target, out io.Writer) error {
	return runScript(WindowsRegisterScript(t.exe, t.dataDir), out)
}

func unregister(_ target, out io.Writer) error { return runScript(WindowsUninstallScript(), out) }

func serviceState(target) string {
	code, output, err := RunPowerShell(WindowsStatusScript())
	output = strings.TrimSpace(output)
	switch {
	case err != nil:
		return "unknown (" + err.Error() + ")"
	case code != 0:
		return "unknown (" + output + ")"
	case strings.HasPrefix(output, "installed "):
		return fmt.Sprintf("scheduled task %q installed, state %s", TaskName, strings.TrimPrefix(output, "installed "))
	default:
		return fmt.Sprintf("scheduled task %q not installed", TaskName)
	}
}

func portOwner(port int) string {
	_, output, err := RunPowerShell(WindowsPortOwnerScript(port))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(output)
}

func mkdirOwned(_ target, dir string) error { return os.MkdirAll(dir, 0o700) }

func chownTo(target, string) error { return nil }

// StopPID ends process pid (Windows has no graceful signal for another process).
func StopPID(pid int) error { return KillPID(pid) }

// KillPID ends process pid at once.
func KillPID(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}
