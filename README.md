# Tube

> Named localhost URLs for dev servers — native macOS menubar app with traffic inspection and custom TLD support.

Tube gives every dev server a stable HTTPS URL (`myapp.localhost`, `api.test`) instead of `localhost:3000`. Built as a native macOS app (PerryTS) with a Bun-compiled proxy engine.

## Quick Start

```bash
# Build the CLI
mise run engine

# Run a dev server through the proxy
dist/tube myapp next dev       # https://myapp.localhost

# Custom TLD
TUBE_TLD=test dist/tube api pnpm start   # https://api.test
```

## Features

- **Named HTTPS URLs** — `https://myapp.localhost` instead of `http://localhost:3000`
- **Custom TLDs** — `TUBE_TLD=test` → `https://myapp.test` (env-configured)
- **Automatic TLS** — Self-signed CA + per-hostname certs generated and trusted on first run via `openssl`
- **Public tunnels** — Built-in support for ngrok, Tailscale Funnel, and Cloudflare Tunnel
- **HTTP/2 + WebSocket** — Modern protocol support out of the box
- **Traffic inspector** — Native macOS table view with request capture, detail inspection, and real-time streaming
- **Native macOS UI** — Menubar icon, split-view window (routes + traffic inspector)
- **Zero-config routing** — `tube myapp <command>` → proxy handles the rest

## Architecture

```
┌──────────────────┐   WebSocket    ┌───────────────────────┐
│  PerryTS UI App   │ ◄────────────► │  Bun Engine (61 MB)   │
│  • Menubar tray   │  ws://:PORT    │  • HTTPS/HTTP2 proxy  │
│  • Traffic view   │   /api         │  • Route registry      │
│  • Route sidebar  │               │  • Traffic recorder    │
└──────────────────┘               │  • TLS cert generation  │
                                    └───────────────────────┘
```

| Component | Language | Compiler | Role |
|---|---|---|---|
| **UI** (`app/`) | TypeScript + `perry/ui` | PerryTS (SWC+LLVM) | Native macOS menubar + window |
| **Engine** (`engine/`) | TypeScript | Bun `build --compile` | Proxy, recorder, WebSocket API, TLS certs |

## CLI Usage

```bash
# Start a dev server
tube myapp next dev
tube api pnpm start
tube web vite

# Daemon mode (for macOS GUI app)
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
| `TUBE_TLD` | `localhost` | Custom TLD for named URLs |
| `TUBE_PORT` | `443` | Proxy port |
| `TUBE_API_PORT` | `0` (random) | WebSocket API port |
| `TUBE_NO_TLS` | unset | Set to `1` to disable TLS |
| `TUBE_STATE_DIR` | `~/.tube` | State directory |

### Custom TLD Example

```bash
TUBE_TLD=dev tube myapp next dev      # https://myapp.dev
TUBE_TLD=test tube api pnpm start     # https://api.test
```

On first run, Tube generates a CA and wildcard server cert (`*.test`, `*.dev`) via `openssl`. Browsers need the CA trusted (add `~/.tube/ca/ca.pem` to your keychain).

## Build

Requires: **Bun**, **PerryTS** (`npm install -g @perryts/perry` or `npx`), **openssl** (macOS ships with it).

```bash
# Recommended: mise
mise run engine     # Build engine → dist/tube-engine + dist/tube
mise run app        # Build UI → app/main
mise run bundle     # Package into dist/Tube.app
mise run all        # engine + app + bundle
mise run run        # Build all + open app

# Fallback: make
make all            # Same as mise run all
```

## Directory Structure

```
tube/
├── README.md
├── AGENTS.md                   # AI agent instructions
├── Makefile                    # Build (fallback)
├── mise.toml                   # Build (primary)
├── dist/                       # Build output
│   ├── Tube.app/               # macOS .app bundle
│   ├── tube-engine             # Engine binary
│   └── tube → tube-engine      # CLI symlink
├── engine/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts            # Entry: CLI parsing + daemon
│       ├── proxy.ts            # HTTPS/HTTP2 reverse proxy + recording
│       ├── recorder.ts         # Traffic ring buffer (1000 entries)
│       ├── api.ts              # WebSocket API protocol
│       ├── certs.ts            # TLS CA + server cert generation (openssl)
│       └── tunnel.ts            # Public tunnel support (ngrok, tailscale, cloudflared)
└── app/
    ├── perry.toml
    └── src/
        ├── main.ts             # UI: tray + window + engine lifecycle
        └── Info.plist.in       # macOS bundle template
```

## TLS Certificates

Tube generates all TLS certificates on first run using system `openssl` and automatically trusts the CA in your login keychain (no sudo required):

```
~/.tube/ca/
├── ca-key.pem          # CA private key (EC, 10yr)
├── ca.pem              # CA certificate — auto-trusted in login keychain
├── server-key.pem      # Server private key (EC, 1yr)
├── server.pem          # Wildcard server cert (SAN: *.localhost, *.test, etc.)
├── ca.srl              # Serial number tracking
├── .trusted            # Trust marker (prevents re-trusting)
└── host-certs/         # Per-hostname SNI certs (on-demand)
    ├── myapp.test.pem
    └── myapp.test-key.pem
```

If auto-trust fails, trust manually: `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/.tube/ca/ca.pem`

## WebSocket API

Commands (UI / CLI → Engine):

| Command | Description |
|---|---|
| `get-status` | Full engine status (routes, tunnels, traffic count) |
| `get-routes` | Active routes list |
| `get-traffic` | All buffered captures |
| `get-capture` | Single capture detail |
| `replay` | Resend a captured request |
| `start-tunnel` / `stop-tunnel` | Toggle tunnels |

Events (Engine → UI):

| Event | Description |
|---|---|
| `traffic` | New capture available (real-time) |
| `route-added` / `route-removed` | Route table changes |

## License

MIT
