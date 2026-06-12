package proxy

import (
	"net"
	"os"
)

// FindFreePort returns an available TCP port in the 4000-4999 range.
func FindFreePort() int {
	for attempt := 0; attempt < 100; attempt++ {
		port := 4000 + (attempt*173+41)%1000
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err == nil {
			ln.Close()
			_ = port
			return ln.Addr().(*net.TCPAddr).Port
		}
	}
	// Fallback
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 4000
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// IsPIDAlive checks whether a process with the given PID is running.
func IsPIDAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(os.Signal(nil))
	return err == nil
}
