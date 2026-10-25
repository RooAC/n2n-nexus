package service

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func readFile(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReplacePrograms(t *testing.T) {
	src, dst := filepath.Join(t.TempDir(), "release"), filepath.Join(t.TempDir(), "Programs", "n2n-nexus-host")
	names := []string{"a.exe", "b.exe"}
	writeFiles(t, src, map[string]string{"a.exe": "a2", "b.exe": "b2"})

	// A first install creates the folder.
	if err := ReplacePrograms(src, dst, names); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst, "a.exe")) != "a2" {
		t.Fatal("not copied")
	}

	// An upgrade keeps the previous program as .old and replaces an earlier .old.
	writeFiles(t, dst, map[string]string{"a.exe.old": "a0"})
	writeFiles(t, src, map[string]string{"a.exe": "a3", "b.exe": "b3"})
	if err := ReplacePrograms(src, dst, names); err != nil {
		t.Fatal(err)
	}
	if readFile(t, filepath.Join(dst, "a.exe")) != "a3" || readFile(t, filepath.Join(dst, "a.exe.old")) != "a2" || readFile(t, filepath.Join(dst, "b.exe.old")) != "b2" {
		t.Fatal("upgrade did not keep the previous programs as .old")
	}

	// Leftovers go; other files stay.
	writeFiles(t, dst, map[string]string{"settings.txt": "x"})
	removeLeftovers(dst)
	entries, _ := os.ReadDir(dst)
	var left []string
	for _, e := range entries {
		left = append(left, e.Name())
	}
	if !slices.Equal(left, []string{"a.exe", "b.exe", "settings.txt"}) {
		t.Fatalf("left %v", left)
	}
}

func TestReplaceProgramsNeedsTheRelease(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	writeFiles(t, src, map[string]string{"a.exe": "a"})
	writeFiles(t, dst, map[string]string{"missing.exe": "installed"})
	if err := ReplacePrograms(src, dst, []string{"a.exe", "missing.exe"}); err == nil {
		t.Fatal("copied without missing.exe")
	}
	// A failed copy leaves the installed program in place.
	if readFile(t, filepath.Join(dst, "missing.exe")) != "installed" {
		t.Fatal("installed program lost")
	}
}
