package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"tube/proxy"
)

func main() {
	args := os.Args[1:]

	if len(args) == 0 || args[0] == "--daemon" {
		runDaemon()
		return
	}

	switch args[0] {
	case "list":
		cmdList()
	case "proxy":
		cmdProxy(args[1:])
	case "--help", "-h":
		printHelp()
	default:
		// tube <name> <command...>
		name := args[0]
		cmd := args[1:]
		if len(cmd) == 0 {
			fmt.Fprintln(os.Stderr, "Usage: tube <name> <command> [args...]")
			os.Exit(1)
		}
		runApp(name, cmd)
	}
}

func printHelp() {
	fmt.Println(`
Tube — named localhost URLs with traffic inspection

Usage:
  tube <name> <command> [args...]    Run a dev server through the proxy
  tube list                          Show active routes
  tube proxy start                   Start the proxy daemon
  tube proxy stop                    Stop the proxy daemon
  tube proxy status                  Show proxy status
  tube --daemon                      Start in daemon mode
  tube --help                        Show this help

Examples:
  tube myapp next dev                https://myapp.localhost
  tube api pnpm start                https://api.localhost
  tube web vite                      https://web.localhost
  TUBE_TLD=test tube myapp next dev  https://myapp.test

Environment:
  TUBE_TLD      Custom TLD (default: localhost)
  TUBE_PORT     Proxy port (default: 443)
  TUBE_NO_TLS   Disable TLS (set to 1)
  TUBE_STATE_DIR State directory (default: ~/.tube)
`)
}

// ─── Config ─────────────────────────────────────────────────────────────────

func config() (tld string, stateDir string) {
	tld = os.Getenv("TUBE_TLD")
	if tld == "" {
		tld = "localhost"
	}
	stateDir = os.Getenv("TUBE_STATE_DIR")
	if stateDir == "" {
		home, _ := os.UserHomeDir()
		stateDir = filepath.Join(home, ".tube")
	}
	return
}

func routesPath() string {
	_, dir := config()
	return filepath.Join(dir, "routes.json")
}

func proxyPidPath() string {
	_, dir := config()
	return filepath.Join(dir, "proxy.pid")
}

func proxyPortPath() string {
	_, dir := config()
	return filepath.Join(dir, "proxy.port")
}

// ─── CLI: Run app ───────────────────────────────────────────────────────────

func runApp(name string, cmdArgs []string) {
	tld, _ := config()
	appPort := proxy.FindFreePort()
	hostname := fmt.Sprintf("%s.%s", name, tld)

	fmt.Fprintf(os.Stderr, "[tube] Starting %q → https://%s\n", name, hostname)

	// Ensure state dir and routes file exist
	stateDir := proxy.StateDirPath()
	os.MkdirAll(stateDir, 0755)

	rp := routesPath()
	if _, err := os.Stat(rp); os.IsNotExist(err) {
		os.WriteFile(rp, []byte("[]"), 0644)
	}

	// Spawn the dev server
	child := exec.Command(cmdArgs[0], cmdArgs[1:]...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	child.Env = append(os.Environ(),
		fmt.Sprintf("PORT=%d", appPort),
		fmt.Sprintf("TUBE_URL=https://%s", hostname),
		fmt.Sprintf("TUBE_NAME=%s", name),
		"HOST=127.0.0.1",
	)

	if err := child.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Failed to start %s: %v\n", name, err)
		os.Exit(1)
	}

	// Register route
	proxy.RegisterRoute(rp, hostname, appPort, child.Process.Pid)

	// Print the URL
	fmt.Printf("\n  https://%s\n\n", hostname)

	// Forward signals to child
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	go func() {
		for sig := range sigCh {
			child.Process.Signal(sig)
		}
	}()

	// Wait for child to exit
	state, err := child.Process.Wait()
	proxy.UnregisterRoute(rp, hostname)

	signal.Stop(sigCh)
	close(sigCh)

	if err != nil {
		fmt.Fprintf(os.Stderr, "[tube] %s exited: %v\n", name, err)
	}

	exitCode := 0
	if state != nil && !state.Success() {
		if ws, ok := state.Sys().(syscall.WaitStatus); ok {
			exitCode = ws.ExitStatus()
		} else {
			exitCode = 1
		}
	}
	os.Exit(exitCode)
}

// ─── CLI: List routes ───────────────────────────────────────────────────────

func cmdList() {
	routes, err := proxy.ReadRouteFile(routesPath())
	if err != nil {
		fmt.Fprintln(os.Stderr, "[tube] Error reading routes:", err)
		os.Exit(1)
	}

	if len(routes) == 0 {
		fmt.Println("No active routes.")
		return
	}

	fmt.Println("\nActive routes:")
	for _, r := range routes {
		alive := proxy.IsPIDAlive(r.PID)
		status := "●"
		if !alive {
			status = "○"
		}
		fmt.Printf("  https://%s → :%d  %s\n", r.Hostname, r.Port, status)
	}
	fmt.Println()
}

// ─── CLI: Proxy commands ────────────────────────────────────────────────────

func cmdProxy(sub []string) {
	if len(sub) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: tube proxy start|stop|status")
		os.Exit(1)
	}

	switch sub[0] {
	case "start":
		runDaemon()
	case "stop":
		cmdProxyStop()
	case "status":
		cmdProxyStatus()
	default:
		fmt.Fprintln(os.Stderr, "Usage: tube proxy start|stop|status")
		os.Exit(1)
	}
}

func cmdProxyStop() {
	data, err := os.ReadFile(proxyPidPath())
	if err != nil {
		fmt.Fprintln(os.Stderr, "[tube] No running proxy found.")
		os.Exit(1)
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		fmt.Fprintln(os.Stderr, "[tube] Invalid PID file.")
		os.Exit(1)
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Proxy PID %d not found.\n", pid)
		os.Exit(1)
	}

	if err := proc.Signal(syscall.SIGTERM); err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Failed to stop proxy (PID %d): %v\n", pid, err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "[tube] Proxy (PID %d) stopped.\n", pid)
}

func cmdProxyStatus() {
	data, err := os.ReadFile(proxyPidPath())
	if err != nil {
		fmt.Println("Proxy: not running")
		return
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		fmt.Println("Proxy: not running")
		return
	}

	alive := proxy.IsPIDAlive(pid)
	status := "● Running"
	if !alive {
		status = "○ Stopped"
	}
	fmt.Printf("Proxy PID: %d  %s\n", pid, status)

	portData, err := os.ReadFile(proxyPortPath())
	if err == nil {
		fmt.Printf("Proxy port: %s\n", strings.TrimSpace(string(portData)))
	}
}

// ─── Daemon mode ────────────────────────────────────────────────────────────

func runDaemon() {
	tld, stateDir := config()
	noTLS := os.Getenv("TUBE_NO_TLS") == "1"
	proxyPort := 443
	if v := os.Getenv("TUBE_PORT"); v != "" {
		if p, err := strconv.Atoi(v); err == nil && p > 0 {
			proxyPort = p
		}
	}

	fmt.Fprintf(os.Stderr, "[tube] Daemon :%d  TLD: %s  TLS: %v\n", proxyPort, tld, !noTLS)

	// Ensure state dir
	os.MkdirAll(stateDir, 0755)

	// Write PID and port
	os.WriteFile(proxyPidPath(), []byte(strconv.Itoa(os.Getpid())), 0644)
	os.WriteFile(proxyPortPath(), []byte(strconv.Itoa(proxyPort)), 0644)

	// Start the proxy server
	store := proxy.NewRouteStore(routesPath(), tld)
	store.Start()
	defer store.Stop()

	recorder := proxy.NewRecorder(500)

	cfg := &proxy.ServerConfig{
		TLD:       tld,
		ProxyPort: proxyPort,
		NoTLS:     noTLS,
		Routes:    store,
		Recorder:  recorder,
	}

	proxySrv, _, err := proxy.StartServer(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[tube] Failed to start proxy: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "[tube] Ready")

	// Wait for signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Fprintf(os.Stderr, "\n[tube] Shutdown\n")
	proxySrv.Close()
	os.Remove(proxyPidPath())
	os.Remove(proxyPortPath())
}
