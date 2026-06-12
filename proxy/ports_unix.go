//go:build !windows

package proxy

import (
	"os"
	"syscall"
)

// IsPIDAlive checks whether a process with the given PID is running.
func IsPIDAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
