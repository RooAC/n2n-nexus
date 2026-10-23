package discovery

import "syscall"

// reuseAddr sets SO_REUSEADDR, as Node's dgram reuseAddr does.
func reuseAddr(_, _ string, c syscall.RawConn) error {
	var serr error
	if err := c.Control(func(fd uintptr) {
		serr = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1)
	}); err != nil {
		return err
	}
	return serr
}
