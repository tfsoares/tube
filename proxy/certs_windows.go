//go:build windows

package proxy

import (
	"fmt"
	"os/exec"
)

func trustCA(caCertPath string) error {
	cmd := exec.Command("certutil", "-addstore", "-user", "Root", caCertPath)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("certutil -addstore failed: %w", err)
	}
	return nil
}
