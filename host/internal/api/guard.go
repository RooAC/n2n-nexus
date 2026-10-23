package api

import (
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var bracketedHost = regexp.MustCompile(`^\[([^\]]+)\](?::\d+)?$`)
var portSuffix = regexp.MustCompile(`:\d+$`)

// hostName is the Host header without its port and IPv6 brackets.
func hostName(header string) string {
	if m := bracketedHost.FindStringSubmatch(header); m != nil {
		return strings.ToLower(m[1])
	}
	return strings.ToLower(portSuffix.ReplaceAllString(header, ""))
}

// guard keeps web pages from calling the host. It has no authentication, so a
// page the user has open must not reach it: browsers attach Origin /
// Sec-Fetch-Site to cross-site requests and send JSON bodies only after a CORS
// preflight the host never grants; a DNS-rebinding page arrives under its own
// host name, so the Host header must be an IP literal or an allowed name.
func (s *Server) guard(r *http.Request) *httpError {
	if r.Host == "" {
		return &httpError{status: 400, message: "Host header is required"}
	}
	if !validTarget(r) {
		return &httpError{status: 400, message: "Invalid request URL or Host header"}
	}
	name := hostName(r.Host)
	if net.ParseIP(name) == nil && !s.allowed[name] {
		return &httpError{status: 403, message: "Host '" + name + "' is not allowed; use an IP address or add it to allowedHosts in settings.json"}
	}
	if _, ok := r.Header["Origin"]; ok {
		return &httpError{status: 403, message: "Requests from browser origins are not allowed"}
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "none" && site != "same-origin" {
		return &httpError{status: 403, message: "Cross-site browser requests are not allowed"}
	}
	if r.Method == http.MethodPost {
		ct := strings.ToLower(strings.TrimSpace(strings.SplitN(r.Header.Get("Content-Type"), ";", 2)[0]))
		if ct != "application/json" {
			return &httpError{status: 415, message: "Content-Type must be application/json"}
		}
	}
	return nil
}

func readAll(r io.Reader) ([]byte, error) { return io.ReadAll(r) }

// validTarget reports whether the request target and the Host header form a valid URL with a port in range.
func validTarget(r *http.Request) bool {
	// "//x" is a scheme-relative target naming another authority, not a path.
	if _, err := url.ParseRequestURI(r.RequestURI); err != nil || strings.HasPrefix(r.RequestURI, "//") {
		return false
	}
	u, err := url.Parse("http://" + r.Host + "/")
	if err != nil || u.Host != r.Host {
		return false
	}
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}
