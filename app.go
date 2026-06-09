package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"tube/proxy"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App holds the Tube application state and exposes methods to the frontend.
type App struct {
	ctx      context.Context
	recorder *proxy.Recorder
	routes   *proxy.RouteStore
	tunnels  *proxy.TunnelManager
	proxySrv *http.Server
	startTime int64

	tld       string
	proxyPort int
	apiPort   int
	noTLS     bool
}

// NewApp creates a new Tube application instance.
func NewApp() *App {
	return &App{
		recorder:  proxy.NewRecorder(500),
		startTime: time.Now().UnixMilli(),
	}
}

// startup is called by Wails when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	a.tld = envStr("TUBE_TLD", "localhost")
	a.proxyPort = envInt("TUBE_PORT", 443)
	a.apiPort = envInt("TUBE_API_PORT", 0)
	a.noTLS = envFlag("TUBE_NO_TLS")

	routesPath := proxy.RouteFilePath()
	a.routes = proxy.NewRouteStore(routesPath, a.tld)
	a.tunnels = proxy.NewTunnelManager()

	fmt.Fprintf(os.Stderr, "[tube] Daemon :%d  TLD: %s  TLS: %v\n", a.proxyPort, a.tld, !a.noTLS)

	// Push traffic events to frontend
	a.recorder.SetListener(func(entry proxy.CaptureEntry) {
		runtime.EventsEmit(ctx, "traffic", entry)
	})

	// Push route changes
	a.routes.SetOnChange(func(routes []proxy.RouteInfo) {
		runtime.EventsEmit(ctx, "routes-changed", routes)
	})

	// Push tunnel status changes
	a.tunnels.SetOnChange(func(status proxy.TunnelStatus) {
		runtime.EventsEmit(ctx, "tunnel-changed", status)
	})

	// Start route polling
	a.routes.Start()

	// Start proxy server
	cfg := &proxy.ServerConfig{
		TLD:       a.tld,
		ProxyPort: a.proxyPort,
		NoTLS:     a.noTLS,
		Routes:    a.routes,
		Recorder:  a.recorder,
		Tunnels:   a.tunnels,
	}
	srv, _, err := proxy.StartServer(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Failed to start proxy: %v\n", err)
	}
	a.proxySrv = srv

	// Handle graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Fprintf(os.Stderr, "\n[tube] Shutdown\n")
		if a.proxySrv != nil {
			a.proxySrv.Close()
		}
		os.Exit(0)
	}()

	fmt.Fprintln(os.Stderr, "[tube] Ready")
}

// shutdown is called by Wails when the app is closing.
func (a *App) shutdown(ctx context.Context) {
	if a.routes != nil {
		a.routes.Stop()
	}
}

// ─── Exposed methods (callable from frontend JS) ──────────────────────────

// GetStatus returns the full engine status.
func (a *App) GetStatus() map[string]any {
	return map[string]any{
		"proxyPort":    a.proxyPort,
		"tls":          !a.noTLS,
		"tld":          a.tld,
		"routes":       a.routes.All(),
		"tunnel":       a.tunnels.Status(),
		"uptime":       time.Now().UnixMilli() - a.startTime,
		"trafficCount": a.recorder.Count(),
		"service":      "tube-engine-wails",
		"version":      "0.4.0",
	}
}

// GetRoutes returns all active routes.
func (a *App) GetRoutes() []map[string]any {
	all := a.routes.All()
	out := make([]map[string]any, len(all))
	for i, r := range all {
		out[i] = map[string]any{
			"hostname": r.Hostname,
			"port":     r.Port,
			"localUrl": r.LocalURL,
		}
	}
	return out
}

// GetTraffic returns all buffered traffic captures.
func (a *App) GetTraffic() []proxy.CaptureEntry {
	return a.recorder.All()
}

// ClearTraffic clears the traffic buffer.
func (a *App) ClearTraffic() {
	// Recorder doesn't have clear yet; re-create
	a.recorder = proxy.NewRecorder(500)
	a.recorder.SetListener(func(entry proxy.CaptureEntry) {
		runtime.EventsEmit(a.ctx, "traffic", entry)
	})
}

// StartTunnel starts a public tunnel.
func (a *App) StartTunnel(typ string) error {
	return a.tunnels.StartTunnel(proxy.TunnelType(typ), a.proxyPort)
}

// StopTunnel stops a public tunnel.
func (a *App) StopTunnel(typ string) {
	a.tunnels.StopTunnel(proxy.TunnelType(typ))
}

// GetTunnelStatus returns the current tunnel state.
func (a *App) GetTunnelStatus() proxy.TunnelStatus {
	return a.tunnels.Status()
}

// ─── Helpers ──────────────────────────────────────────────────────────────

func envStr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		var n int
		fmt.Sscanf(v, "%d", &n)
		if n != 0 {
			return n
		}
	}
	return fallback
}

func envFlag(key string) bool {
	return os.Getenv(key) == "1"
}
