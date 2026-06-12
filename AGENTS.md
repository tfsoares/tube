# Tube — AI Agent Instructions

Tube is a native app for named localhost URLs, traffic inspection, and
public tunnels. Built with **Wails 2 + Go** — single binary, runs on macOS, Linux, and Windows.

## Architecture

Single Go module (`tube`) with three entry points sharing the `proxy/` packages:

```
tube/
├── main.go              ← Wails GUI entry (macOS .app)
├── app.go               ← App struct, frontend bindings
├── cmd/tube/main.go     ← CLI entry (tube <name> <command>)
├── proxy/               ← Shared engine (CLI + GUI both use this)
│   ├── server.go        ← HTTPS reverse proxy (httputil.ReverseProxy)
│   ├── certs.go         ← TLS generation (crypto/x509, no openssl)
│   ├── recorder.go      ← Ring buffer, thread-safe
│   ├── routes.go        ← Route file polling + read/write helpers
│   ├── tunnel.go        ← Tunnel spawning via os/exec
│   └── ports.go         ← FindFreePort, IsPIDAlive
├── frontend/            ← Web UI (embedded in Wails binary via //go:embed)
│   ├── index.html       ← Layout template
│   ├── main.js          ← Wails bindings + event listeners
│   └── style.css        ← Dark theme styles
├── wails.json           ← Wails project config
├── go.mod / go.sum      ← Go module dependencies
├── Makefile             ← Build targets
├── mise.toml            ← mise task runner config
```

## Key Files (active codebase — Go)

| File | Lines | What it does |
|---|---|---|
| `main.go` | ~65 | Wails app entry: window config, asset embed, tray, bindings |
| `app.go` | ~200 | `App` struct with methods exposed to frontend: `GetStatus`, `GetRoutes`, `GetTraffic`, `StartTunnel`, `StopTunnel`, `ClearTraffic` |
| `cmd/tube/main.go` | ~250 | CLI: arg parsing, `runApp` (spawn + route register), `cmdList`, `cmdProxy`, `runDaemon` |
| `proxy/server.go` | ~160 | `StartServer`: creates HTTPS/HTTP proxy, `captureResponseWriter` for recording |
| `proxy/certs.go` | ~230 | `LoadOrGenerateCerts`, `SNICallback`, `TrustCA`, CA + server + host cert generation |
| `proxy/certs_darwin.go` | ~20 | macOS CA trust via `security add-trusted-cert` |
| `proxy/certs_linux.go` | ~50 | Linux CA trust via `update-ca-certificates` / `update-ca-trust` |
| `proxy/certs_windows.go` | ~15 | Windows CA trust via `certutil -addstore` |
| `proxy/recorder.go` | ~80 | `Recorder` struct: ring buffer, `Record`, `All`, `Count`, `SetListener` |
| `proxy/routes.go` | ~230 | `RouteStore` (polling), `RegisterRoute`, `UnregisterRoute`, `ReadRouteFile`, `WriteRouteFile` |
| `proxy/tunnel.go` | ~140 | `TunnelManager`: spawn ngrok/tailscale/cloudflared, parse URLs from stdout |
| `proxy/ports.go` | ~18 | `FindFreePort` |
| `proxy/ports_unix.go` | ~15 | `IsPIDAlive` (Unix: signal check) |
| `proxy/ports_windows.go` | ~15 | `IsPIDAlive` (Windows: OpenProcess) |

## Frontend ↔ Backend Communication

**No WebSocket.** Wails provides direct Go ↔ JS bindings:

### Frontend calls Go (JS → Go)
```js
const status = await window.go.main.App.GetStatus()
await window.go.main.App.StartTunnel("ngrok")
```

### Go pushes events (Go → JS)
```go
runtime.EventsEmit(ctx, "traffic", captureEntry)
runtime.EventsEmit(ctx, "routes-changed", routes)
runtime.EventsEmit(ctx, "tunnel-changed", status)
```

### Frontend subscribes to events
```js
window.runtime.EventsOn("traffic", (entry) => { /* ... */ })
```

**Rule:** Any new Go method you add to `App` that starts with a capital letter is
automatically callable from the frontend. Return types must be serializable (struct,
map, slice, string, int, bool).

## Conventions

- **Go code style:** Standard Go conventions (`gofmt`, `go vet`). Exported names use `PascalCase`.
- **Error handling:** Return errors from functions, log non-fatal errors to stderr with `[tube]` prefix.
- **State directory:** `~/.tube/` by default, overridable via `TUBE_STATE_DIR` env var.
- **Routes file:** `~/.tube/routes.json` — array of `{hostname, port, pid}`. Polled every 3s.
- **Cert directory:** `~/.tube/ca/` — PEM files. Generated on first proxy start.
- **Config:** All runtime config via `os.Getenv`. No config files (except routes.json).
- **Thread safety:** `Recorder` and `RouteStore` use `sync.RWMutex`. `TunnelManager` uses `sync.Mutex`.

## Build Commands

```bash
# CLI (single Go binary, ~8 MB)
make cli                    # → dist/tube
make cli-linux              # → dist/tube-linux-amd64 (cross-compile)
make cli-windows            # → dist/tube-windows-amd64.exe (cross-compile)
go build -ldflags="-s -w" -o dist/tube ./cmd/tube

# GUI app (Wails, ~15-20 MB)
make wails-build            # → dist/Tube.app (macOS)
make wails-build-linux      # → build for Linux
make wails-build-windows    # → build for Windows

# Hot-reload dev mode
make wails-dev              # → opens window, auto-reloads on file change
wails dev

# Run the CLI directly (no build)
go run ./cmd/tube myapp next dev

# Run CLI daemon
go run ./cmd/tube --daemon

# Install CLI globally
make install                # → ~/.local/bin/tube
```

## Testing

Tests live in `engine/src/__tests__/` (Bun test runner, for the legacy TypeScript engine
only). The Go packages don't have tests yet. To add Go tests:

```bash
# Create test files alongside source (Go convention)
touch proxy/server_test.go
go test ./proxy/... -v
```

## Environment Variables

| Variable | Default | Where used |
|---|---|---|
| `TUBE_TLD` | `localhost` | `proxy/routes.go:FindRoute()`, `cmd/tube:runApp()` |
| `TUBE_PORT` | `443` | `proxy/server.go:StartServer()`, `cmd/tube:runDaemon()` |
| `TUBE_NO_TLS` | unset | `proxy/server.go` (disables TLS if `"1"`) |
| `TUBE_STATE_DIR` | `~/.tube` | `proxy/routes.go:RouteFilePath()` |

## Cross-Platform Design

Platform-specific code uses Go build tags (`//go:build darwin`, `//go:build linux`, `//go:build windows`):

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| Wails native window | `main_darwin.go` (`mac.Options`) | `main_linux.go` (`linux.Options`) | `main_windows.go` (`windows.Options`) |
| CA trust | `security add-trusted-cert` | `update-ca-certificates` | `certutil -addstore` |
| PID check | `Signal(0)` | `Signal(0)` | `OpenProcess` |

All shared code lives in `proxy/` and `cmd/tube/` with no platform conditionals.

## How To Add a Feature

1. **New proxy behavior** → Add to `proxy/` package. Both CLI and GUI pick it up automatically.
2. **New frontend widget** → Add HTML to `frontend/index.html`, CSS to `style.css`, JS to `main.js`.
3. **New frontend data source** → Add method to `App` in `app.go`. Call from `main.js`.
4. **New CLI command** → Add case to `cmd/tube/main.go:main()` switch.
5. **New tunnel provider** → Add case to `proxy/tunnel.go:StartTunnel()`, add URL pattern to `urlPatterns`.

## Legacy Code

The `engine/` and `app/` directories contain the original Bun + PerryTS implementation
and are **not the active codebase**. They're kept for reference only. All active
development happens in `cmd/`, `proxy/`, `frontend/`, `main.go`, and `app.go`.

The legacy TypeScript engine has 54 unit tests in `engine/src/__tests__/`. They test `findRoute`,
`TrafficRecorder`, and `extractUrl` logic that has equivalent implementations in the Go `proxy/` package.

## Known Gaps

1. **No Go tests yet** — The proxy logic needs test coverage mirroring the TypeScript tests
2. **No menubar tray icon** — Wails tray API needs an app icon PNG
3. **No edit & replay** — Engine records request/response bodies but UI has no edit+resend controls
4. **No code signing** — Builds and runs locally, needs signing for distribution
5. **Subdomain matching** — Only exact hostname matches; loose `.sub.app.localhost` routing is planned
6. **Linux GtkWebKit dependency** — Wails on Linux requires WebKit2GTK (`libwebkit2gtk-4.0-dev`)
