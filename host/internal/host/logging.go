package host

import (
	"io"
	"log"
	"path/filepath"

	"gopkg.in/natefinch/lumberjack.v2"
)

// LogPrefix starts every log line of the host.
const LogPrefix = "[n2n-nexus-host] "

// LogFile is host.log in logDir.
func LogFile(logDir string) string { return filepath.Join(logDir, "host.log") }

// LogWriter appends to <logDir>/host.log, rotated at 10 MB with 3 old files
// kept; the tray and the service log there (serve logs to standard error).
func LogWriter(logDir string) io.WriteCloser {
	return &lumberjack.Logger{Filename: LogFile(logDir), MaxSize: 10, MaxBackups: 3}
}

// NewLogger is the host's logger on w.
func NewLogger(w io.Writer) *log.Logger { return log.New(w, LogPrefix, log.LstdFlags) }

// ReadyLine is the line logged once the host listens; the conformance harness
// reads the address from it (/listening on http:\/\/(\S+)/).
func ReadyLine(version string, h *Host) string {
	return version + " listening on http://" + h.Addr.String()
}
