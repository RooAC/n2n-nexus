package service

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// SelfInstallOptions are the flags of `install`.
type SelfInstallOptions struct {
	// Exe is the running console build; the programs next to it are installed.
	Exe string
	// Dir is where to install, "" for DefaultInstallDir.
	Dir string
	Out io.Writer
}

// Programs `install` copies on Windows: the console build and the tray build.
var installedPrograms = []string{"n2n-nexus-host.exe", "n2n-nexus-host-tray.exe"}

// ReplacePrograms copies names from srcDir to dstDir. A program already in
// dstDir is renamed to <name>.old first, which Windows allows while it runs,
// and a leftover .old from an earlier install that no longer runs is removed;
// one that still runs stays, and this rename gets a timestamped name instead.
func ReplacePrograms(srcDir, dstDir string, names []string) error {
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return err
	}
	for _, name := range names {
		dst := filepath.Join(dstDir, name)
		// Copy first, so a failed copy leaves the installed program in place.
		if err := copyFile(filepath.Join(srcDir, name), dst+".new"); err != nil {
			os.Remove(dst + ".new")
			return fmt.Errorf("copy %s: %w", name, err)
		}
		if err := os.Remove(dst + ".old"); err != nil && !errors.Is(err, fs.ErrNotExist) {
			// Still running (or locked): keep it, move the current one aside under another name.
			if err := moveAside(dst, dst+"."+strconv.FormatInt(time.Now().UnixNano(), 36)+".old"); err != nil {
				return err
			}
		} else if err := moveAside(dst, dst+".old"); err != nil {
			return err
		}
		if err := os.Rename(dst+".new", dst); err != nil {
			return err
		}
	}
	return nil
}

// moveAside renames file to aside when it exists.
func moveAside(file, aside string) error {
	if err := os.Rename(file, aside); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// removeLeftovers deletes the .old programs of earlier installs that no longer run.
func removeLeftovers(dir string) {
	olds, _ := filepath.Glob(filepath.Join(dir, "*.old"))
	for _, old := range olds {
		_ = os.Remove(old)
	}
}
