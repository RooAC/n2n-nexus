// Command n2n-nexus-host runs the n2n-nexus host: by default as a tray
// program, with `serve` in the foreground without a user interface.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/n2ns/n2n-nexus/host/internal/config"
	"github.com/n2ns/n2n-nexus/host/internal/host"
	"github.com/n2ns/n2n-nexus/host/internal/testhooks"
)

// version is set at build time: -ldflags "-X main.version=1.0.0".
var version = "dev"

func main() {
	args := os.Args[1:]
	cmd := ""
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		os.Exit(serve(args))
	case "version":
		fmt.Println(version)
	default:
		// TODO(platform): tray (default), service, autostart.
		fmt.Fprintf(os.Stderr, "usage: n2n-nexus-host serve [--host <addr>] [--port <port>] [--root <dir>]\n")
		os.Exit(2)
	}
}

// serve runs the host in the foreground until SIGINT / SIGTERM.
func serve(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	hostFlag := fs.String("host", "", "address to listen on (default: settings.json, then 127.0.0.1)")
	port := fs.Int("port", -1, "port to listen on, 0 for any free port (default: settings.json, then 5688)")
	root := fs.String("root", "", "data directory (default: NEXUS_ROOT, then the platform data directory)")
	var test testhooks.Options
	testhooks.RegisterFlags(fs, &test)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	logger := log.New(os.Stderr, "[n2n-nexus-host] ", log.LstdFlags)
	dataDir := *root
	if dataDir == "" {
		dataDir = config.DataDir()
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		logger.Print(err)
		return 1
	}
	settings, err := config.LoadSettings(dataDir)
	if err != nil {
		logger.Print(err)
		return 1
	}
	if *hostFlag != "" {
		settings.Host = *hostFlag
	}
	if *port >= 0 {
		settings.Port = *port
	}
	h, err := host.Start(host.Options{Version: version, DataDir: dataDir, Settings: settings, Logger: logger, Test: test})
	if err != nil {
		logger.Print(err)
		return 1
	}
	// The conformance harness reads the port from this line.
	logger.Printf("%s listening on http://%s", version, h.Addr.String())
	logger.Printf("data: %s", dataDir)
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	logger.Print("shutting down")
	h.Stop()
	return 0
}
