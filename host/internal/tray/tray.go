//go:build !darwin || cgo

// Package tray is the default mode of n2n-nexus-host: a system tray icon that
// runs the host in-process, or only controls it when another one (the
// background service) already answers on the configured port.
package tray

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"sync"
	"time"

	"fyne.io/systray"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

// refreshInterval is how often the menu re-reads the session count and whether the service answers.
const refreshInterval = 5 * time.Second

// restartWait bounds how long a restart in controller mode waits for the service to answer again.
var restartWait = 20 * time.Second

type app struct {
	o      Options
	t      texts
	logger *log.Logger // tray.log

	mu       sync.Mutex
	h        *host.Host     // the in-process host, nil when not running here
	hostLogs io.WriteCloser // host.log of the in-process host, nil when none
	external string         // address of a host running elsewhere (controller mode), "" if none
	lastErr  error
	online   int // agent sessions not offline, as last read
	settings config.Settings

	status, sessions, local, lan, autostart, restart *systray.MenuItem
}

// Run shows the tray until Quit; it blocks. The tray logs to tray.log; only
// a host it runs in-process (which then holds host.lock) writes host.log.
func Run(o Options) error {
	a, logs := newApp(o)
	defer logs.Close()
	systray.Run(a.ready, a.exit)
	return nil
}

// newApp is the tray's state, logging to tray.log.
func newApp(o Options) (*app, io.Closer) {
	logs := host.TrayLogWriter(o.LogDir)
	return &app{o: o, t: textsFor(systemChinese()), logger: host.NewLogger(logs)}, logs
}

func (a *app) ready() {
	// The tray starts at login by default (first run only; the menu toggle changes it).
	if err := service.EnsureAutostartDefault(a.o.Exe); err != nil {
		a.logger.Printf("start at login: %v", err)
	}
	systray.SetIcon(trayIcon())
	systray.SetTooltip(a.t.Tooltip)
	a.status = systray.AddMenuItem("…", "")
	a.status.Disable()
	a.sessions = systray.AddMenuItem("…", "")
	a.sessions.Disable()
	systray.AddSeparator()
	logs := systray.AddMenuItem(a.t.OpenLogs, "")
	data := systray.AddMenuItem(a.t.OpenData, "")
	systray.AddSeparator()
	a.local = systray.AddMenuItemCheckbox(a.t.Local, "", false)
	a.lan = systray.AddMenuItemCheckbox(a.t.LAN, "", false)
	a.autostart = systray.AddMenuItemCheckbox(a.t.Autostart, "", service.AutostartEnabled(a.o.Exe))
	systray.AddSeparator()
	a.restart = systray.AddMenuItem(a.t.Restart, "")
	quit := systray.AddMenuItem(a.t.Quit, "")

	a.mu.Lock()
	a.start()
	a.poll()
	a.refresh()
	a.mu.Unlock()

	go func() {
		for range time.Tick(refreshInterval) {
			a.mu.Lock()
			a.poll()
			a.refresh()
			a.mu.Unlock()
		}
	}()

	go func() {
		for {
			select {
			case <-logs.ClickedCh:
				a.open(a.o.LogDir)
			case <-data.ClickedCh:
				a.open(a.o.DataDir)
			case <-a.local.ClickedCh:
				a.setListen(false)
			case <-a.lan.ClickedCh:
				a.setListen(true)
			case <-a.autostart.ClickedCh:
				a.toggleAutostart()
			case <-a.restart.ClickedCh:
				a.doRestart()
			case <-quit.ClickedCh:
				systray.Quit()
				return
			}
		}
	}()
}

func (a *app) exit() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.stopHost()
}

// stopHost (a.mu held) stops the in-process host, if any, and closes host.log.
func (a *app) stopHost() {
	if a.h != nil {
		a.h.Stop()
		a.h = nil
		a.logger.Print("stopped")
	}
	if a.hostLogs != nil {
		_ = a.hostLogs.Close()
		a.hostLogs = nil
	}
}

// start (a.mu held) loads the settings and either finds a running host or starts one here.
func (a *app) start() {
	a.lastErr, a.external = nil, ""
	s, err := config.LoadSettings(a.o.DataDir)
	a.settings = s
	if err != nil {
		a.lastErr = err
		return
	}
	if addr := findRunning(s); addr != "" {
		a.external = addr
		a.logger.Printf("a host already answers on http://%s; the tray only controls it", addr)
		return
	}
	logs := host.LogWriter(a.o.LogDir)
	hostLogger := host.NewLogger(logs)
	h, err := host.Start(host.Options{Version: a.o.Version, DataDir: a.o.DataDir, Settings: s, Logger: hostLogger, Role: host.RoleTray})
	if err != nil {
		_ = logs.Close()
		a.lastErr = err
		a.logger.Print(err)
		return
	}
	a.h, a.hostLogs = h, logs
	for _, l := range []*log.Logger{hostLogger, a.logger} {
		l.Print(host.ReadyLine(a.o.Version, h))
		l.Printf("data: %s", a.o.DataDir)
	}
}

// poll (a.mu held) reads the session count, and in controller mode whether the service answers.
func (a *app) poll() {
	switch {
	case a.h != nil:
		n, err := a.h.OnlineSessions()
		if err != nil {
			a.logger.Printf("count sessions: %v", err)
			return
		}
		a.online = n
	case a.external != "":
		if info, ok := service.Health(a.external, time.Second); ok {
			a.online, a.lastErr = info.Online, nil
			return
		}
		// The service may be back on other settings (service install --port, an edited file).
		if s, err := config.LoadSettings(a.o.DataDir); err == nil {
			a.settings = s
			if addr := findRunning(s); addr != "" {
				a.external = addr
				if info, ok := service.Health(addr, time.Second); ok {
					a.online, a.lastErr = info.Online, nil
					return
				}
			}
		}
		a.lastErr = errors.New(a.t.ServiceDown)
	}
}

// statusTitle (a.mu held) is the status line of a running host: the address
// it listens on, not the loopback address the tray probes a LAN host on.
func (a *app) statusTitle() string {
	if a.h != nil {
		return fmt.Sprintf(a.t.StatusInProcess, a.h.Addr.String()) + a.lanSuffix(a.h.Addr.IP.String())
	}
	addr := a.external
	if _, port, err := net.SplitHostPort(a.external); err == nil && a.settings.Host != "" {
		addr = net.JoinHostPort(a.settings.Host, port)
	}
	return fmt.Sprintf(a.t.StatusService, addr) + a.lanSuffix(a.settings.Host)
}

func (a *app) lanSuffix(host string) string {
	if isLAN(config.Settings{Host: host}) {
		return a.t.LANSuffix
	}
	return ""
}

// refresh (a.mu held) updates the menu from the state.
func (a *app) refresh() {
	running := true
	switch {
	case a.h != nil, a.external != "" && a.lastErr == nil:
		a.status.SetTitle(a.statusTitle())
	default:
		a.status.SetTitle(fmt.Sprintf(a.t.StatusStopped, a.lastErr))
		running = false
	}
	if running {
		a.sessions.SetTitle(fmt.Sprintf(a.t.OnlineSessions, a.online))
		a.sessions.Show()
	} else {
		a.sessions.Hide()
	}
	if isLAN(a.settings) {
		a.local.Uncheck()
		a.lan.Check()
	} else {
		a.local.Check()
		a.lan.Uncheck()
	}
	if service.AutostartEnabled(a.o.Exe) {
		a.autostart.Check()
	} else {
		a.autostart.Uncheck()
	}
}

func (a *app) open(dir string) {
	if err := openFolder(dir); err != nil {
		a.logger.Printf("open %s: %v", dir, err)
		go notice(a.t.Tooltip, fmt.Sprintf(a.t.Error, err))
	}
}

// restartHost (a.mu held) applies settings.json: it restarts the in-process
// host, or, in controller mode, asks the service's serve to restart (a request
// file in the data directory: the tray may not end a process of another logon
// session) so its supervisor starts it again with the new settings, and
// waits up to restartWait for it to answer. A controller stays a controller:
// it never starts a host in-process, which would take the lock from the service.
func (a *app) restartHost() {
	if a.external == "" {
		a.stopHost()
		a.start()
		return
	}
	info, err := host.ReadLock(a.o.DataDir)
	if err != nil || !info.Held || info.Supervisor == 0 {
		go notice(a.t.Tooltip, a.t.RestartNoControl)
		return
	}
	if err := host.RequestRestart(a.o.DataDir); err != nil {
		a.logger.Printf("restart request: %v", err)
		go notice(a.t.Tooltip, fmt.Sprintf(a.t.Error, err))
		return
	}
	a.logger.Printf("asked serve PID %d to restart; its supervisor starts it again", info.PID)
	if fresh, err := config.LoadSettings(a.o.DataDir); err == nil {
		a.settings = fresh // the service restarts with what settings.json says now
	}
	s := a.settings
	a.mu.Unlock()
	addr := awaitService(a.o.DataDir, s, info.PID, restartWait)
	a.mu.Lock()
	if addr == "" {
		a.lastErr = errors.New(a.t.ServiceDown)
		a.logger.Printf("the service did not answer within %s of the restart", restartWait)
		go notice(a.t.Tooltip, fmt.Sprintf(a.t.ServiceNotBack, int(restartWait/time.Second)))
		return
	}
	a.external, a.lastErr = addr, nil
	a.logger.Printf("the service answers again on http://%s", addr)
}

// awaitService waits up to wait for a host other than oldPID to answer for
// dataDir and returns its address, or "". The lock is read only once a host
// answers, so the read never races the new serve for a free lock.
func awaitService(dataDir string, s config.Settings, oldPID int, wait time.Duration) string {
	for deadline := time.Now().Add(wait); time.Now().Before(deadline); time.Sleep(250 * time.Millisecond) {
		addr := findRunning(s)
		if addr == "" {
			continue
		}
		if info, err := host.ReadLock(dataDir); err == nil && info.Held && info.PID != oldPID {
			return addr
		}
	}
	return ""
}

func (a *app) doRestart() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.restartHost()
	a.refresh()
}

// setListen switches the host to listening on the LAN (0.0.0.0, on) or on this machine only (127.0.0.1) and restarts
// it; picking the mode already in use changes nothing.
func (a *app) setListen(on bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if on == isLAN(a.settings) {
		a.refresh()
		return
	}
	s, err := setLAN(a.o.DataDir, on)
	if err != nil {
		a.logger.Print(err)
		go notice(a.t.Tooltip, fmt.Sprintf(a.t.Error, err))
		a.refresh()
		return
	}
	a.settings = s
	a.logger.Printf("settings: host %s", s.Host)
	if on {
		if lanNeedsNotice {
			go notice(a.t.Tooltip, fmt.Sprintf(a.t.FirewallNotice, s.Port, s.DiscoveryPort))
		} else if err := allowLAN(s.Port, s.DiscoveryPort); err != nil {
			a.logger.Printf("firewall: %v", err)
			go notice(a.t.Tooltip, fmt.Sprintf(a.t.FirewallFailed, s.Port, s.DiscoveryPort, err))
		}
	}
	a.restartHost()
	a.refresh()
}

func (a *app) toggleAutostart() {
	a.mu.Lock()
	defer a.mu.Unlock()
	on := !service.AutostartEnabled(a.o.Exe)
	where, err := service.SetAutostart(a.o.Exe, on)
	if err != nil {
		a.logger.Printf("autostart %s: %v", where, err)
		go notice(a.t.Tooltip, fmt.Sprintf(a.t.Error, err))
	}
	a.refresh()
}
