//go:build linux

package proxy

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func trustCA(caCertPath string) error {
	// Try Debian/Ubuntu path first
	dest := "/usr/local/share/ca-certificates/tube-ca.crt"
	dirs := []struct {
		dir string
		cmd []string
	}{
		{"/usr/local/share/ca-certificates", []string{"update-ca-certificates"}},
		{"/etc/pki/ca-trust/source/anchors", []string{"update-ca-trust", "extract"}},
		{"/etc/ca-certificates/trust-source/anchors", []string{"trust", "extract-compat"}},
	}

	for _, d := range dirs {
		if _, err := os.Stat(d.dir); err == nil {
			dest = filepath.Join(d.dir, "tube-ca.crt")
			data, err := os.ReadFile(caCertPath)
			if err != nil {
				return err
			}
			// Copy CA cert to trust dir
			if err := os.WriteFile(dest, data, 0644); err != nil {
				// Try with sudo
				cpCmd := exec.Command("sudo", "cp", caCertPath, dest)
				if err := cpCmd.Run(); err != nil {
					return fmt.Errorf("copy CA cert failed (try: sudo cp %s %s)", caCertPath, dest)
				}
			}

			// Update trust store
			updateCmd := exec.Command("sudo", d.cmd...)
			if err := updateCmd.Run(); err != nil {
				// Try without sudo
				updateCmd = exec.Command(d.cmd[0], d.cmd[1:]...)
				updateCmd.Run()
			}
			return nil
		}
	}

	return fmt.Errorf("no known CA trust directory found; copy manually: sudo cp %s /usr/local/share/ca-certificates/tube-ca.crt && sudo update-ca-certificates", caCertPath)
}
