package proxy

import (
	"bufio"
	"fmt"
	"os"
	"strings"
)

const hostsMarker = "# Tube — managed block"
const hostsEndMarker = "# End Tube block"

// SyncHosts writes all active route hostnames to /etc/hosts so custom TLDs
// (like .test, .dev) resolve to 127.0.0.1. Requires root/sudo.
// Returns nil on success, or an error if /etc/hosts is not writable.
func SyncHosts(routes []RouteInfo) error {
	hostsPath := "/etc/hosts"
	content, err := os.ReadFile(hostsPath)
	if err != nil {
		return fmt.Errorf("read /etc/hosts: %w (try: sudo tube hosts sync)", err)
	}

	lines := strings.Split(string(content), "\n")
	var filtered []string
	inBlock := false
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if t == hostsMarker {
			inBlock = true
			continue
		}
		if t == hostsEndMarker {
			inBlock = false
			continue
		}
		if !inBlock {
			filtered = append(filtered, line)
		}
	}

	if len(routes) == 0 {
		// No routes — just remove the block if it exists
		newContent := strings.Join(filtered, "\n")
		return os.WriteFile(hostsPath, []byte(newContent), 0644)
	}

	contentStr := strings.TrimSpace(strings.Join(filtered, "\n")) + "\n\n"
	contentStr += hostsMarker + "\n"
	for _, r := range routes {
		contentStr += fmt.Sprintf("127.0.0.1 %s\n", r.Hostname)
	}
	contentStr += hostsEndMarker + "\n"

	tmpPath := hostsPath + ".tube-tmp"
	if err := os.WriteFile(tmpPath, []byte(contentStr), 0644); err != nil {
		return fmt.Errorf("write /etc/hosts: permission denied (run: sudo tube hosts sync)")
	}
	if err := os.Rename(tmpPath, hostsPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("update /etc/hosts: permission denied (run: sudo tube hosts sync)")
	}
	return nil
}

// CleanHosts removes the Tube-managed block from /etc/hosts.
func CleanHosts() error {
	hostsPath := "/etc/hosts"
	content, err := os.ReadFile(hostsPath)
	if err != nil {
		return err
	}

	var filtered []string
	inBlock := false
	scanner := bufio.NewScanner(strings.NewReader(string(content)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == hostsMarker {
			inBlock = true
			continue
		}
		if strings.TrimSpace(line) == hostsEndMarker {
			inBlock = false
			continue
		}
		if !inBlock {
			filtered = append(filtered, line)
		}
	}

	newContent := strings.Join(filtered, "\n")
	return os.WriteFile(hostsPath, []byte(newContent), 0644)
}
