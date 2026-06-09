package proxy

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sync"
)

// TunnelType identifies the tunnel provider.
type TunnelType string

const (
	TunnelNgrok     TunnelType = "ngrok"
	TunnelTailscale TunnelType = "tailscale"
	TunnelFunnel    TunnelType = "funnel"
)

// TunnelStatus represents active tunnel state.
type TunnelStatus struct {
	Ngrok     bool              `json:"ngrok"`
	Tailscale bool              `json:"tailscale"`
	Funnel    bool              `json:"funnel"`
	URLs      map[string]string `json:"urls"`
}

type activeTunnel struct {
	cmd *exec.Cmd
	url string
}

// TunnelManager spawns and manages tunnel processes.
type TunnelManager struct {
	mu       sync.Mutex
	tunnels  map[TunnelType]*activeTunnel
	onChange func(TunnelStatus)
}

var urlPatterns = map[TunnelType]*regexp.Regexp{
	TunnelNgrok:     regexp.MustCompile(`https://[a-zA-Z0-9-]+\.ngrok-free\.app`),
	TunnelTailscale: regexp.MustCompile(`https://[a-z0-9][a-z0-9.-]*\.(?:ts\.net|tailscale\.net)`),
	TunnelFunnel:    regexp.MustCompile(`https://[a-zA-Z0-9-]+\.trycloudflare\.com`),
}

// NewTunnelManager creates a tunnel manager.
func NewTunnelManager() *TunnelManager {
	return &TunnelManager{
		tunnels: make(map[TunnelType]*activeTunnel),
	}
}

// SetOnChange sets a callback that fires when tunnel state changes.
func (m *TunnelManager) SetOnChange(fn func(TunnelStatus)) {
	m.onChange = fn
}

// StartTunnel spawns the given tunnel type for the specified port.
func (m *TunnelManager) StartTunnel(typ TunnelType, port int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, ok := m.tunnels[typ]; ok {
		return nil // already running
	}

	var cmd *exec.Cmd
	switch typ {
	case TunnelNgrok:
		cmd = exec.Command("ngrok", "http", fmt.Sprint(port), "--log=stdout")
	case TunnelTailscale:
		cmd = exec.Command("tailscale", "funnel", "--bg", fmt.Sprint(port))
	case TunnelFunnel:
		cmd = exec.Command("cloudflared", "tunnel", "--no-autoupdate", "--url", fmt.Sprintf("http://localhost:%d", port))
	default:
		return fmt.Errorf("unknown tunnel type: %s", typ)
	}

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start %s: %w", typ, err)
	}

	entry := &activeTunnel{cmd: cmd}
	m.tunnels[typ] = entry

	// Parse URL from output
	scanner := func(pipe *os.File) {
		s := bufio.NewScanner(pipe)
		for s.Scan() {
			line := s.Text()
			if pat, ok := urlPatterns[typ]; ok {
				if m := pat.FindString(line); m != "" && m != entry.url {
					entry.url = m
					fmt.Fprintf(os.Stderr, "[tube] Tunnel %s: %s\n", typ, m)
					m.emit()
				}
			}
		}
	}

	if stdout != nil {
		go scanner(stdout.(*os.File))
	}
	if stderr != nil {
		go scanner(stderr.(*os.File))
	}

	go func() {
		cmd.Wait()
		m.mu.Lock()
		delete(m.tunnels, typ)
		m.mu.Unlock()
		m.emit()
	}()

	fmt.Fprintf(os.Stderr, "[tube] Tunnel %s: started\n", typ)
	return nil
}

// StopTunnel stops the given tunnel type.
func (m *TunnelManager) StopTunnel(typ TunnelType) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if entry, ok := m.tunnels[typ]; ok {
		entry.cmd.Process.Signal(os.Interrupt)
		go func() {
			entry.cmd.Wait()
		}()
		delete(m.tunnels, typ)
		fmt.Fprintf(os.Stderr, "[tube] Tunnel %s: stopped\n", typ)
	}
	m.emit()
}

// Status returns the current tunnel state.
func (m *TunnelManager) Status() TunnelStatus {
	m.mu.Lock()
	defer m.mu.Unlock()

	s := TunnelStatus{URLs: make(map[string]string)}
	for typ, entry := range m.tunnels {
		switch typ {
		case TunnelNgrok:
			s.Ngrok = true
		case TunnelTailscale:
			s.Tailscale = true
		case TunnelFunnel:
			s.Funnel = true
		}
		if entry.url != "" {
			s.URLs[string(typ)] = entry.url
		}
	}
	return s
}

func (m *TunnelManager) emit() {
	if m.onChange != nil {
		m.onChange(m.Status())
	}
}
