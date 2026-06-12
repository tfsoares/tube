package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
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

// StartApp spawns a dev server and registers the route. Returns the local URL.
func (a *App) StartApp(name string, command string) (string, error) {
	parts := strings.Fields(command)
	if len(parts) == 0 {
		return "", fmt.Errorf("command is required")
	}

	port := proxy.FindFreePort()
	hostname := fmt.Sprintf("%s.%s", name, a.tld)

	// Ensure state dir and routes file exist
	stateDir := proxy.StateDirPath()
	os.MkdirAll(stateDir, 0755)
	rp := proxy.RouteFilePath()
	if _, err := os.Stat(rp); os.IsNotExist(err) {
		os.WriteFile(rp, []byte("[]"), 0644)
	}

	// Spawn dev server
	child := exec.Command(parts[0], parts[1:]...)
	child.Env = append(os.Environ(),
		fmt.Sprintf("PORT=%d", port),
		fmt.Sprintf("TUBE_URL=https://%s", hostname),
		fmt.Sprintf("TUBE_NAME=%s", name),
		"HOST=127.0.0.1",
	)
	// Discard output in GUI mode
	child.Stdout = io.Discard
	child.Stderr = io.Discard

	if err := child.Start(); err != nil {
		return "", fmt.Errorf("start %s: %w", name, err)
	}

	// Register route
	proxy.RegisterRoute(rp, hostname, port, child.Process.Pid)

	// Cleanup on exit
	go func() {
		child.Wait()
		proxy.UnregisterRoute(rp, hostname)
	}()

	return fmt.Sprintf("https://%s", hostname), nil
}

// RemoveRoute unregisters a route by hostname.
func (a *App) RemoveRoute(hostname string) error {
	rp := proxy.RouteFilePath()
	routes, err := proxy.ReadRouteFile(rp)
	if err != nil {
		return err
	}

	// Find and kill the process if still alive
	for _, r := range routes {
		if r.Hostname == hostname && r.PID > 0 {
			if proc, err := os.FindProcess(r.PID); err == nil {
				proc.Signal(syscall.SIGTERM)
			}
		}
	}

	return proxy.UnregisterRoute(rp, hostname)
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
