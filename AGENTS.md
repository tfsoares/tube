# Tube — Native macOS menubar app for named localhost URLs

Tube is a native macOS menubar app for named localhost URLs, traffic inspection,
and public tunnels. It combines a Bun-compiled proxy engine with a
native UI (PerryTS) using the tray API for the menubar icon.

## Architecture

```
Tube.app/
├── Contents/
│   ├── MacOS/
│   │   └── Tube         ← PerryTS native UI app (9 MB)
│   ├── Resources/
│   │   └── tube-engine  ← Bun-compiled proxy engine (61 MB)
│   └── Info.plist
```

### Two Components

| Component | Language | Compiler | Size | Role |
|---|---|---|---|---|
| **UI** (`app/`) | TypeScript + `perry/ui` | PerryTS (SWC+LLVM) | 9 MB | Native macOS window + tray menubar icon (NSStatusItem) |
| **Engine** (`engine/`) | TypeScript | Bun `build --compile` | 61 MB | HTTPS/HTTP2 proxy, traffic recorder, TLS cert generation, WebSocket API |

### Communication

```
┌─────────────┐   WebSocket    ┌──────────────────────┐
│  PerryTS    │ ◄────────────► │  Bun Engine           │
│  UI App     │  ws://:PORT    │  • Proxy (:443)       │
│  (9 MB)     │   /api         │  • Recorder            │
│  + tray     │                │  • TLS cert generation │
└─────────────┘                │  • WebSocket API       │
      │                        └──────────────────────┘
      │ spawns as child process
      │ reads TUBE_API_PORT from stdout
      ▼
  trayCreate → NSStatusItem (menubar icon)
```

## Directory Structure

```
tube/
├── README.md                 ← Public-facing docs
├── AGENTS.md                 ← This file (AI agent instructions)
├── Makefile                  ← Build system (fallback)
├── mise.toml                 ← Build system (primary, `mise run <task>`)
├── portline-vs-portless.md   ← Original analysis
├── dist/                     ← Build output
│   ├── Tube.app/             ← macOS .app bundle
│   ├── tube-engine           ← Engine binary
│   └── tube                  ← Symlink to tube-engine
├── engine/                   ← Bun-compiled engine
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          ← Entry: CLI parsing + daemon startup
│       ├── proxy.ts          ← Custom HTTPS/HTTP2 proxy with recording hooks
│       ├── recorder.ts       ← Traffic ring buffer (1000 entries) + EventEmitter
│       ├── api.ts            ← WebSocket API protocol (commands + events)
│       ├── certs.ts          ← TLS CA + server cert generation via openssl
│       ├── tunnel.ts         ← Public tunnel support (ngrok, tailscale, cloudflared)
└── app/                      ← PerryTS native UI app
    ├── perry.toml
    ├── .perry/               ← PerryTS type stubs
    └── src/
        ├── main.ts           ← Entry: UI layout + tray + engine lifecycle
        └── Info.plist.in     ← macOS app bundle template
```

## Engine (Bun)

Single binary with dual mode:

- **CLI mode:** `tube <name> <command>` — runs a dev server through the proxy
- **Daemon mode:** `tube --daemon` — proxy + WebSocket API for GUI

State lives in `~/.tube/` (overridable via `TUBE_STATE_DIR`). Routes are written to `~/.tube/routes.json` and polled every 3s.

### Custom TLD

Set `TUBE_TLD` to any string (defaults to `localhost`):

```bash
TUBE_TLD=test tube myapp next dev  # https://myapp.test
```

The TLD suffix is enforced in route matching via `proxy.ts:findRoute()` — only hosts ending with `.${tld}` are routed.

### TLS Certificates

On first run, the engine generates a self-signed CA and server certs using system `openssl` (`certs.ts`):

```
~/.tube/ca/
├── ca-key.pem              ← EC key (prime256v1)
├── ca.pem                  ← Self-signed CA cert (10yr, /CN=Tube Local CA)
├── server-key.pem          ← EC key for server
├── server.pem              ← Wildcard server cert (SAN: *.localhost, *.test, etc.)
├── ca.srl                  ← Serial number tracking
└── host-certs/             ← Per-hostname SNI certs (generated on-demand)
```

- `loadCerts(tld)` — loads or generates certs at daemon startup
- `createSNICallback(tld)` — returns an SNI callback that lazily generates per-hostname certs cached in `host-certs/`
- `trustCA()` — attempts auto-trust via `security add-trusted-cert` (login keychain, no sudo)
- If `openssl` is missing, TLS falls back to disabled (HTTP only)

### Public Tunnels

Tube can spawn external tunnel processes via `tunnel.ts`:

- **ngrok** → `ngrok http <port>` — parses `.ngrok-free.app` URL from stdout
- **Tailscale Funnel** → `tailscale funnel --bg <port>` — public internet via Tailscale
- **Cloudflare Tunnel** → `cloudflared tunnel --url ...` — `.trycloudflare.com` URLs

Tunnels are toggled via the `start-tunnel` / `stop-tunnel` WebSocket commands and report URLs asynchronously. The UI tunnel section updates reactively.

### WebSocket API

Commands (UI → Engine):
- `get-status` — Full engine status (tld, routes, tunnels, traffic count, TLS, uptime)
- `get-routes` — Active routes list
- `get-traffic` — All buffered captures
- `get-capture` / `get-capture-body` — Single capture detail
- `replay` / `edit-replay` — Resend a captured request
- `start-tunnel` / `stop-tunnel` — Toggle tunnels

Events (Engine → UI):
- `traffic` — New capture available (streamed in real-time)
- `route-added` / `route-removed` — Route table changes

## UI App (PerryTS)

Native macOS app built with `perry/ui` (compiles to AppKit).

Features:
- **Tray icon** via `trayCreate()` → `NSStatusItem` in the menubar
- **Split view** window: sidebar (routes + tunnels) | main (traffic inspector)
- **Table widget** (`NSTableView`) for traffic capture listing — method, path, status, duration
- **Detail panel** below table showing selected capture info
- **Status bar** at top showing engine connection state
- **Reactive text** elements updated via `textSetString()` on WebSocket events
- **No dock icon** (`activationPolicy: "accessory"`)
- **Context menu** on tray icon with status, routes, quit

## Build

```bash
# Using mise (recommended)
mise run engine         # Bun compile → dist/tube-engine + dist/tube symlink
mise run app            # PerryTS compile → app/main
mise run bundle         # Package into .app
mise run all            # engine + app + bundle
mise run run            # Build + open app
mise run install-cli    # Install tube CLI to ~/.local/bin
mise run dev-engine     # Run engine in dev mode (no TLS, port 8099)

# Using make (fallback)
make engine
make app
make bundle
make all
```

## Dependencies

- **Bun** — runtime and compiler for the engine binary
- **PerryTS** — TypeScript-to-native compiler for the UI
- **openssl** — TLS certificate generation (ships with macOS)
- **ws** (npm) — WebSocket implementation (native in Perry/Bun)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TUBE_TLD` | `localhost` | TLD for named URLs |
| `TUBE_PORT` | `443` | Proxy port |
| `TUBE_API_PORT` | `0` (random) | WebSocket API port |
| `TUBE_NO_TLS` | unset | Set to `1` to disable TLS |
| `TUBE_STATE_DIR` | `~/.tube` | State directory |

## Known Issues / TODOs

1. PerryTS `ws` module types are `any` — need proper type definitions
2. Engine binary is 61 MB (includes Bun runtime) — could be optimized later
3. No code signing yet — runs fine locally but needs `--deep` signing for distribution
4. Perry `strip-dedup` has non-fatal permission warning during build
5. Tray icon uses default placeholder — needs a proper app icon PNG/icns
