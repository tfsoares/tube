package main

import (
	"fmt"
	"os"
	"strings"
	"time"
	"tube/proxy"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ─── Styles ──────────────────────────────────────────────────────────────────

var (
	styleTitle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#40c057")).
			MarginLeft(1)

	styleStatus = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#888888"))

	styleHeader = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("#aaaaaa"))

	styleSidebar = lipgloss.NewStyle().
			Width(36).
			Height(20).
			Padding(0, 1)

	styleMain = lipgloss.NewStyle().
			Padding(0, 1)

	styleHelp = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#666666"))

	styleActive = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#40c057"))

	styleInactive = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#555555"))

	styleMethod = map[string]lipgloss.Style{
		"GET":    lipgloss.NewStyle().Foreground(lipgloss.Color("#40c057")).Bold(true),
		"POST":   lipgloss.NewStyle().Foreground(lipgloss.Color("#94d82d")).Bold(true),
		"PUT":    lipgloss.NewStyle().Foreground(lipgloss.Color("#339af0")).Bold(true),
		"DELETE": lipgloss.NewStyle().Foreground(lipgloss.Color("#ff6b6b")).Bold(true),
		"PATCH":  lipgloss.NewStyle().Foreground(lipgloss.Color("#fcc419")).Bold(true),
	}

	styleStatus2xx = lipgloss.NewStyle().Foreground(lipgloss.Color("#40c057"))
	styleStatus3xx = lipgloss.NewStyle().Foreground(lipgloss.Color("#339af0"))
	styleStatus4xx = lipgloss.NewStyle().Foreground(lipgloss.Color("#fcc419"))
	styleStatus5xx = lipgloss.NewStyle().Foreground(lipgloss.Color("#ff6b6b"))
)

// ─── Model ───────────────────────────────────────────────────────────────────

type TickMsg struct{}

type TuiModel struct {
	routes      *proxy.RouteStore
	recorder    *proxy.Recorder
	tunnels     *proxy.TunnelManager
	proxySrv    any

	table      table.Model
	routeView  viewport.Model
	traffic    []proxy.CaptureEntry
	routeList  []proxy.RouteInfo
	tunnelSt   proxy.TunnelStatus
	tld        string
	proxyPort  int
	startTime  time.Time
	width      int
	height     int
	quitting   bool
}

func NewTuiModel() *TuiModel {
	tld := os.Getenv("TUBE_TLD")
	if tld == "" {
		tld = "localhost"
	}
	proxyPort := 443
	if v := os.Getenv("TUBE_PORT"); v != "" {
		fmt.Sscanf(v, "%d", &proxyPort)
	}

	columns := []table.Column{
		{Title: "Method", Width: 8},
		{Title: "Path", Width: 40},
		{Title: "Status", Width: 7},
		{Title: "Dur", Width: 7},
	}

	t := table.New(table.WithColumns(columns), table.WithFocused(true))
	t.SetStyles(table.Styles{
		Header: lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#888")),
		Cell:   lipgloss.NewStyle().Foreground(lipgloss.Color("#ccc")),
		Selected: lipgloss.NewStyle().
			Foreground(lipgloss.Color("#fff")).
			Background(lipgloss.Color("#1e2a38")),
	})

	return &TuiModel{
		routes:    proxy.NewRouteStore(proxy.RouteFilePath(), tld),
		recorder:  proxy.NewRecorder(500),
		tunnels:   proxy.NewTunnelManager(),
		tld:       tld,
		proxyPort: proxyPort,
		startTime: time.Now(),
		table:     t,
		routeView: viewport.New(36, 16),
	}
}

func (m *TuiModel) Init() tea.Cmd {
	// Start proxy in background
	go m.startProxy()

	// Start route polling
	m.routes.Start()
	m.routes.SetOnChange(func(routes []proxy.RouteInfo) {
		m.routeList = routes
	})

	// Tunnel status updates
	m.tunnels.SetOnChange(func(s proxy.TunnelStatus) {
		m.tunnelSt = s
	})

	// Listen for captures
	m.recorder.SetListener(func(e proxy.CaptureEntry) {
		m.traffic = append([]proxy.CaptureEntry{e}, m.traffic...)
		if len(m.traffic) > 200 {
			m.traffic = m.traffic[:200]
		}
	})

	return tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
		return TickMsg{}
	})
}

func (m *TuiModel) startProxy() {
	noTLS := os.Getenv("TUBE_NO_TLS") == "1"
	cfg := &proxy.ServerConfig{
		TLD:       m.tld,
		ProxyPort: m.proxyPort,
		NoTLS:     noTLS,
		Routes:    m.routes,
		Recorder:  m.recorder,
		Tunnels:   m.tunnels,
	}
	srv, _, err := proxy.StartServer(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Failed to start proxy: %v\n", err)
		return
	}
	m.proxySrv = srv
}

func (m *TuiModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			m.quitting = true
			if m.proxySrv != nil {
				if s, ok := m.proxySrv.(interface{ Close() error }); ok {
					s.Close()
				}
			}
			m.routes.Stop()
			return m, tea.Quit
		case "1":
			m.tunnels.StartTunnel(proxy.TunnelNgrok, m.proxyPort)
		case "2":
			m.tunnels.StartTunnel(proxy.TunnelTailscale, m.proxyPort)
		case "3":
			m.tunnels.StartTunnel(proxy.TunnelFunnel, m.proxyPort)
		case "!":
			m.tunnels.StopTunnel(proxy.TunnelNgrok)
		case "@":
			m.tunnels.StopTunnel(proxy.TunnelTailscale)
		case "#":
			m.tunnels.StopTunnel(proxy.TunnelFunnel)
		}

	case TickMsg:
		m.routes.All() // trigger data refresh
		var cmds []tea.Cmd
		cmds = append(cmds, tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg {
			return TickMsg{}
		}))
		return m, tea.Batch(cmds...)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.table.SetWidth(min(msg.Width-40, 80))
		m.table.SetHeight(msg.Height - 6)
	}

	var cmd tea.Cmd
	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m *TuiModel) View() string {
	if m.quitting {
		return "Shutting down...\n"
	}

	w := m.width
	if w < 60 {
		w = 60
	}

	// ── Header ─────────────────────────────────────────────────────────────
	status := fmt.Sprintf("routes: %d  requests: %d  TLD: %s  TLS: %v",
		len(m.routeList), len(m.traffic), m.tld,
		os.Getenv("TUBE_NO_TLS") != "1")
	title := styleTitle.Render("Tube") + styleStatus.Render("  "+status)
	header := lipgloss.NewStyle().Width(w).Render(title)

	// ── Sidebar ───────────────────────────────────────────────────────────
	var sb strings.Builder
	sb.WriteString(styleHeader.Render("Routes") + "\n")
	if len(m.routeList) == 0 {
		sb.WriteString(styleInactive.Render("  No active routes") + "\n")
	} else {
		for _, r := range m.routeList {
			sb.WriteString(fmt.Sprintf("  ● https://%s\n", r.Hostname))
		}
	}

	sb.WriteString("\n" + styleHeader.Render("Tunnels") + "\n")
	toggles := []string{}
	types := []struct {
		key  string
		name string
		on   bool
		url  string
	}{
		{"1", "ngrok", m.tunnelSt.Ngrok, m.tunnelSt.URLs["ngrok"]},
		{"2", "tailscale", m.tunnelSt.Tailscale, m.tunnelSt.URLs["tailscale"]},
		{"3", "cloudflare", m.tunnelSt.Funnel, m.tunnelSt.URLs["funnel"]},
	}
	for _, t := range types {
		s := styleInactive
		mark := "○"
		if t.on {
			s = styleActive
			mark = "●"
		}
		toggles = append(toggles, s.Render(fmt.Sprintf(" %s %s(%s)", mark, t.name, t.key)))
		if t.url != "" {
			toggles = append(toggles, styleStatus.Render("  "+t.url))
		}
	}
	toggles = append(toggles, styleHelp.Render("\n ! ngrok-off  @tail-off  #cf-off"))

	sidebar := styleSidebar.Render(sb.String() + strings.Join(toggles, "\n"))

	// ── Traffic table ─────────────────────────────────────────────────────
	rows := make([]table.Row, 0, len(m.traffic))
	for _, c := range m.traffic[:min(len(m.traffic), 50)] {
		methodStyle := styleMethod[c.Method]
		if methodStyle.GetForeground() == (lipgloss.NoColor{}) {
			methodStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#ccc"))
		}
		method := methodStyle.Render(fmt.Sprintf("%-6s", c.Method))
		path := c.Path
		if len(path) > 38 {
			path = path[:38]
		}

		sc := c.StatusCode
		var stStyle lipgloss.Style
		switch {
		case sc >= 500:
			stStyle = styleStatus5xx
		case sc >= 400:
			stStyle = styleStatus4xx
		case sc >= 300:
			stStyle = styleStatus3xx
		case sc >= 200:
			stStyle = styleStatus2xx
		default:
			stStyle = lipgloss.NewStyle()
		}
		status := stStyle.Render(fmt.Sprintf("%d", sc))
		dur := fmt.Sprintf("%dms", c.Duration)

		rows = append(rows, table.Row{method, path, status, dur})
	}
	m.table.SetRows(rows)

	main := styleMain.Render(m.table.View())

	// ── Help ──────────────────────────────────────────────────────────────
	help := styleHelp.Render("q: quit  1/2/3: tunnels  !/@/#: stop  ↑↓: scroll")

	// ── Layout ────────────────────────────────────────────────────────────
	body := lipgloss.JoinHorizontal(
		lipgloss.Top,
		sidebar,
		main,
	)

	return lipgloss.JoinVertical(
		lipgloss.Top,
		header,
		lipgloss.NewStyle().Width(w).Render("─"+strings.Repeat("─", w-1)),
		body,
		lipgloss.NewStyle().Width(w).Render("─"+strings.Repeat("─", w-1)),
		help,
	)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
