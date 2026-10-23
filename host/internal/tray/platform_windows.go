package tray

import (
	"fmt"
	"strings"

	"golang.org/x/sys/windows"

	"github.com/n2ns/n2n-nexus/host/internal/service"
)

// notice shows a message box (blocking; call it from its own goroutine).
func notice(title, msg string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(msg)
	const mbIconInformation, mbSetForeground = 0x40, 0x10000
	_, _ = windows.MessageBox(0, m, t, mbIconInformation|mbSetForeground)
}

// allowLAN adds the inbound firewall rules for TCP port and UDP discoveryPort
// through a UAC prompt; it returns an error when they were not added.
func allowLAN(port, discoveryPort int) error {
	code, out, err := service.RunPowerShell(service.WindowsFirewallScript(port, discoveryPort))
	if err != nil {
		return err
	}
	if code != 0 {
		out = strings.TrimSpace(out)
		if out == "" {
			out = fmt.Sprintf("exit code %d", code)
		}
		return fmt.Errorf("%s", out)
	}
	return nil
}

// lanNeedsNotice reports whether turning LAN on should tell the user which ports to open.
const lanNeedsNotice = false
