//go:build !windows

package service

import "errors"

// DefaultInstallDir: install is Windows only.
func DefaultInstallDir() string { return "" }

// SelfInstall: on macOS and Linux the package manager (Homebrew) or the
// release archive installs the host.
func SelfInstall(SelfInstallOptions) error {
	return errors.New("install is for Windows; on macOS use Homebrew (brew install n2ns/tap/n2n-nexus-host), on Linux put the release's n2n-nexus-host on your PATH")
}
