package proxy

import "net"

// FindFreePort returns an available TCP port.
func FindFreePort() int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 4000
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}
