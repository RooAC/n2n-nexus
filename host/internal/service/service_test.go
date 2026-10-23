package service

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
)

func TestSettingsForAppliesFlags(t *testing.T) {
	dir := t.TempDir()
	s := config.Defaults()
	s.MaxAutoTurns = 2
	_ = config.SaveSettings(dir, s)
	got, err := settingsFor(target{dataDir: dir}, Options{Host: "0.0.0.0", Port: 5799})
	if err != nil || got.Host != "0.0.0.0" || got.Port != 5799 || got.MaxAutoTurns != 2 {
		t.Fatalf("%+v %v", got, err)
	}
	got, err = settingsFor(target{dataDir: dir}, Options{Port: -1})
	if err != nil || got.Host != "127.0.0.1" || got.Port != 5688 {
		t.Fatalf("no flags: %+v %v", got, err)
	}
	if _, err := settingsFor(target{dataDir: dir}, Options{Port: 0}); err == nil {
		t.Fatal("port 0 accepted for a service")
	}
}

func TestProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			_, _ = io.WriteString(w, `{"ok":true,"service":"n2n-nexus","version":"9.9.9"}`)
		}
	}))
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "http://")
	if v, ok := Probe(addr, time.Second); !ok || v != "9.9.9" {
		t.Fatal(v, ok)
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, `{"service":"x"}`) }))
	defer other.Close()
	if _, ok := Probe(strings.TrimPrefix(other.URL, "http://"), time.Second); ok {
		t.Fatal("foreign service accepted")
	}
	if HealthAddr("0.0.0.0", 5688) != "127.0.0.1:5688" || HealthAddr("10.0.0.2", 1) != "10.0.0.2:1" || HealthAddr("::1", 2) != "[::1]:2" {
		t.Fatal("HealthAddr")
	}
}

func TestStopLockHolderWithoutHolder(t *testing.T) {
	dir := t.TempDir()
	if err := StopLockHolder(dir, io.Discard); err != nil {
		t.Fatal(err)
	}
	// A released lock with a stale record stops nothing.
	l, _ := host.AcquireLock(dir, 1, 1)
	l.Release()
	if err := StopLockHolder(dir, io.Discard); err != nil {
		t.Fatal(err)
	}
}
