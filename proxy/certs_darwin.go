//go:build darwin

package proxy

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func trustCA(caCertPath string) error {
	home, _ := os.UserHomeDir()
	keychain := filepath.Join(home, "Library", "Keychains", "login.keychain-db")
	cmd := exec.Command("security", "add-trusted-cert", "-d", "-r", "trustRoot",
		"-k", keychain, caCertPath)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("security add-trusted-cert failed: %w", err)
	}
	return nil
}
