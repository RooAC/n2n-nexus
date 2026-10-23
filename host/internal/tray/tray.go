//go:build !darwin || cgo

// Package tray is the default mode of n2n-nexus-host: a system tray icon that
// runs the host in-process, or only controls it when another one (the
// background service) already answers on the configured port.
package tray

import (
	"fmt"
	"log"
	"sync"
	"time"

	"fyne.io/systray"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/service"
)

type app struct {
	o      Options
	t      texts
	logger *log.Logger

	mu       sync.Mutex
	h        *host.Host // the in-process host, nil when not running here
	external string     // address of a host running elsewhere (controller mode), "" if none
	lastErr  error
	settings config.Settings

	status, lan, autostart, restart *systray.MenuItem
}

// Run shows the tray until Quit; it blocks.
func Run(o Options) error {
	a := &app{o: o, t: textsFor(systemChinese())}
	logs := host.LogWriter(o.LogDir)
	defer logs.Close()
	a.logger = host.NewLogger(logs)
	systray.Run(a.ready, a.exit)
	return nil
}

func (a *app) ready() {
	systray.SetIcon(trayIcon())
	systray.SetTooltip(a.t.Tooltip)
	a.status = systray.AddMenuItem("…", "")
	a.status.Disable()
	systray.AddSeparator()
	logs := systray.AddMenuItem(a.t.OpenLogs, "")
	data := systray.AddMenuItem(a.t.OpenData, "")
	systray.AddSeparator()
	a.lan = systray.AddMenuItemCheckbox(a.t.LAN, "", false)
	a.autostart = systray.AddMenuItemCheckbox(a.t.Autostart, "", service.AutostartEnabled(a.o.Exe))
	systray.AddSeparator()
	a.restart = systray.AddMenuItem(a.t.Restart, "")
	quit := systray.AddMenuItem(a.t.Quit, "")

	a.mu.Lock()
	a.start()
	a.refresh()
	a.mu.Unlock()

	go func() {
		for {
			select {
			case <-logs.ClickedCh:
				a.open(a.o.LogDir)
			case <-data.ClickedCh:
				a.open(a.o.DataDir)
			case <-a.lan.ClickedCh:
				a.toggleLAN()
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
	if a.h != nil {
		a.h.Stop()
		a.h = nil
		a.logger.Print("stopped")
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
	h, err := host.Start(host.Options{Version: a.o.Version, DataDir: a.o.DataDir, Settings: s, Logger: a.logger})
	if err != nil {
		a.lastErr = err
		a.logger.Print(err)
		return
	}
	a.h = h
	a.logger.Print(host.ReadyLine(a.o.Version, h))
	a.logger.Printf("data: %s", a.o.DataDir)
}

// refresh (a.mu held) updates the menu from the state.
func (a *app) refresh() {
	switch {
	case a.h != nil:
		a.status.SetTitle(fmt.Sprintf(a.t.StatusInProcess, a.h.Addr.String()))
	case a.external != "":
		a.status.SetTitle(fmt.Sprintf(a.t.StatusService, a.external))
	default:
		a.status.SetTitle(fmt.Sprintf(a.t.StatusStopped, a.lastErr))
	}
	if isLAN(a.settings) {
		a.lan.Check()
	} else {
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
// host, or, in controller mode, stops the service's serve by the PID in
// host.lock so its supervisor starts it again with the new settings.
func (a *app) restartHost() {
	if a.external != "" {
		info, err := host.ReadLock(a.o.DataDir)
		if err != nil || !info.Held || info.Supervisor == 0 {
			go notice(a.t.Tooltip, a.t.RestartNoControl)
			return
		}
		if err := service.StopPID(info.PID); err != nil {
			go notice(a.t.Tooltip, fmt.Sprintf(a.t.Error, err))
			return
		}
		a.logger.Printf("stopped serve PID %d; its supervisor restarts it", info.PID)
		a.mu.Unlock()
		time.Sleep(service.RestartDelay + 3*time.Second)
		a.mu.Lock()
	}
	if a.h != nil {
		a.h.Stop()
		a.h = nil
	}
	a.start()
}

func (a *app) doRestart() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.restartHost()
	a.refresh()
}

func (a *app) toggleLAN() {
	a.mu.Lock()
	defer a.mu.Unlock()
	on := !isLAN(a.settings)
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
