# Tube

> Named localhost URLs for dev servers — native macOS app with traffic inspection and custom TLD support.

Tube gives every dev server a stable HTTPS URL (`https://myapp.localhost`, `https://api.test`)
instead of `localhost:3000`. Built with **Wails 2 + Go** — single native binary, zero runtime
dependencies. Runs on **macOS, Linux, and Windows**.

## Quick Start

```bash
# Install prerequisites
brew install go wails          # macOS
# or: go install github.com/wailsapp/wails/v2/cmd/wails@latest

# Build the CLI (macOS/Linux/Windows)
make cli                       # → dist/tube (~8 MB)
GOOS=linux go build ./cmd/tube # cross-compile Linux
GOOS=windows go build ./cmd/tube # cross-compile Windows

# Run a dev server through the proxy
dist/tube myapp next dev       # → https://myapp.localhost
TUBE_TLD=test dist/tube api vite   # → https://api.test

# Build the GUI app
make wails-build    # → dist/Tube.app (~15–20 MB)
open dist/Tube.app
```

## Features

- **Named HTTPS URLs** — `https://myapp.localhost` instead of `http://localhost:3000`
- **Custom TLDs** — `TUBE_TLD=test` → `https://myapp.test`
- **Automatic TLS** — Self-signed CA + wildcard certs generated in pure Go (`crypto/x509`), no `openssl` needed
- **CA auto-trust** — Trusts the CA in your login keychain on first run (macOS)
- **HTTP/2** — ALPN auto-negotiation via Go stdlib
- **Cross-platform** — macOS, Linux, and Windows (native WebView2/GtkWebkit on each)
- **Public tunnels** — Built-in ngrok, Tailscale Funnel, and Cloudflare Tunnel support
- **Traffic inspector** — Dark-themed table view with method/path/status/duration + detail panel
- **Native macOS app** — Wails WebView2/GtkWebkit window, single binary per platform

## CLI Usage

```bash
# Start a dev server (spawns <command>, registers route, sets PORT env)
tube myapp next dev
tube api pnpm start
tube web vite

# Daemon mode (proxy server + route polling)
tube --daemon
tube proxy start
tube proxy stop
tube proxy status

# List active routes
tube list
```

## Architecture

```
┌──────────────────────┐
│  Tube.app (~15 MB)    │
│  ┌──────────────────┐ │
│  │  Frontend (WebView)│ │  HTML/CSS/JS
│  │  • Traffic table  │ │  Wails runtime bindings
│  │  • Route sidebar  │ │  Events: traffic, routes-changed
│  │  • Tunnel controls│ │
│  ├──────────────────┤ │
│  │  Backend (Go)     │ │  proxy/ packages
│  │  • HTTPS proxy     │ │  crypto/x509 → TLS certs
│  │  • Route registry  │ │  httputil.ReverseProxy
│  │  • Traffic recorder│ │  Ring buffer (500 entries)
│  │  • Tunnel spawning │ │  os/exec (ngrok/tailscale/cloudflared)
│  └──────────────────┘ │
└──────────────────────┘

  CLI: tube <name> <command>   (cmd/tube/main.go, reuses same proxy/ pkgs)
```

| Component | Language | Role |
|---|---|---|
| **Backend** | Go | HTTPS/HTTP2 proxy, TLS certs, route polling, tunnel spawning, recorder |
| **Frontend** | HTML/CSS/JS | Traffic table, route sidebar, tunnel controls, detail panel |
| **CLI** | Go | `tube <name> <command>`, route management, daemon control |
| **IPC** | Wails bindings | Go struct methods exposed to frontend JS, runtime events for real-time updates |

## CLI Usage

```bash
# Start a dev server (spawns <command>, registers route, sets PORT env)
tube myapp next dev
tube api pnpm start
tube web vite

# Daemon mode (proxy server + route polling)
tube --daemon
tube proxy start
tube proxy stop
tube proxy status

# List active routes
tube list
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TUBE_TLD` | `localhost` | TLD for named URLs |
| `TUBE_PORT` | `443` | Proxy port |
| `TUBE_NO_TLS` | unset | Set to `1` to disable TLS |
| `TUBE_STATE_DIR` | `~/.tube` | State directory |

### Custom TLD Example

```bash
TUBE_TLD=dev tube myapp next dev      # https://myapp.dev
TUBE_TLD=test tube api pnpm start     # https://api.test
```

On first run, Tube generates a CA and wildcard server cert via Go's `crypto/x509`
(no external tools). The CA is auto-trusted in your login keychain.

## Build

Requires: **Go 1.22+**, **Wails CLI** (`go install github.com/wailsapp/wails/v2/cmd/wails@latest`)

```bash
make cli              # Build CLI → dist/tube (~8 MB)
make cli-linux        # Cross-compile CLI for Linux
make cli-windows      # Cross-compile CLI for Windows
make wails-build      # Build GUI app for current platform
make wails-build-linux  # Build GUI for Linux
make wails-build-windows # Build GUI for Windows
make wails-dev        # Run GUI in dev mode (hot reload)
make install          # Build CLI + install to ~/.local/bin
make clean            # Remove build artifacts
```

## Directory Structure

```
tube/
├── README.md
├── AGENTS.md                    # AI agent instructions
├── Makefile                     # Build system
├── mise.toml                    # Build tasks (mise)
├── go.mod / go.sum              # Go module definition
├── wails.json                   # Wails project config
├── main.go                      # Wails app entry, window config
├── app.go                       # App struct, frontend bindings
├── proxy/                       # Proxy engine (shared by CLI + GUI)
│   ├── certs.go                 # TLS CA + server certs (crypto/x509)
│   ├── server.go                # HTTPS reverse proxy (httputil)
│   ├── recorder.go              # Ring buffer recorder
│   ├── routes.go                # Route file polling + read/write
│   ├── tunnel.go                # Tunnel spawning (os/exec)
│   └── ports.go                 # Port utils (FindFreePort, IsPIDAlive)
├── cmd/tube/                    # CLI binary
│   └── main.go                  # CLI entry: tube <name> <command>
├── frontend/                    # Web UI (embedded in .app)
│   ├── index.html               # Layout: sidebar + table + detail panel
│   ├── style.css                # Dark theme, macOS-native look
│   └── main.js                  # Wails bindings, event listeners
├── engine/                      # Legacy Bun engine (TypeScript)
│   └── src/                     # index.ts, proxy.ts, recorder.ts, etc.
└── app/                         # Legacy PerryTS UI
    └── src/                     # main.ts, Info.plist.in
```

## TLS Certificates

Tube generates all certificates on first run using **Go's `crypto/x509`** — no external
`openssl` dependency:

```
~/.tube/ca/
├── ca-key.pem              ← CA private key (ECDSA P-256)
├── ca.pem                  ← Self-signed CA cert (10yr, /CN=Tube Local CA)
├── server-key.pem          ← Server private key
├── server.pem              ← Wildcard server cert (SAN: *.localhost, *.test, etc.)
├── .trusted                ← Trust marker (prevents re-trusting)
└── host-certs/             ← Per-hostname SNI certs (on-demand)
    ├── myapp.test.pem
    └── myapp.test-key.pem
```

Auto-trust hooks into the platform's certificate store:
- **macOS** — `security add-trusted-cert` (login keychain)
- **Linux** — `update-ca-certificates` / `update-ca-trust` (system trust anchors)
- **Windows** — `certutil -addstore -user Root`

## License

MIT
