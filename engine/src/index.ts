/**
 * Tube Engine — single binary with dual mode:
 *
 * CLI mode:   tube <name> <command...>   — Run a dev server through the proxy
 *            tube list                   — Show active routes
 *            tube proxy start|stop       — Control the proxy daemon
 *
 * Daemon mode: tube                      — Start proxy + WebSocket API (for GUI)
 *             tube --daemon              — Explicit daemon mode
 */

import * as http from "node:http";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { createTubeProxy } from "./proxy";
import type { RouteInfo as ProxyRouteInfo } from "./proxy";
import { TrafficRecorder } from "./recorder";
import { startApiServer, type RouteInfo, type TunnelStatus } from "./api";
import { loadCerts, createSNICallback, trustCA } from "./certs";
import { startTunnel, stopTunnel, getStatus as getTunnelStatus } from "./tunnel";

// ─── Constants ──────────────────────────────────────────────────────────────

const TLD = process.env.TUBE_TLD || "localhost";
const STATE_DIR = process.env.TUBE_STATE_DIR || join(process.env.HOME || "/tmp", ".tube");
const ROUTES_PATH = join(STATE_DIR, "routes.json");
const API_PORT_PATH = join(STATE_DIR, "api.port");
const PROXY_PID_PATH = join(STATE_DIR, "proxy.pid");
const PROXY_PORT_PATH = join(STATE_DIR, "proxy.port");

// ─── CLI Entry ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--daemon") {
    return runDaemon();
  }

  switch (args[0]) {
    case "list":
      return cmdList();
    case "proxy":
      return cmdProxy(args.slice(1));
    case "proxy:start":
      return runDaemon();
    case "--help":
    case "-h":
      return printHelp();
    default: {
      // tube <name> <command...>
      const name = args[0];
      const cmd = args.slice(1);
      if (cmd.length === 0) {
        console.error("Usage: tube <name> <command> [args...]");
        process.exit(1);
      }
      return runApp(name, cmd);
    }
  }
}

function printHelp(): void {
  console.log(`
Tube — named localhost URLs with traffic inspection

Usage:
  tube <name> <command> [args...]    Run a dev server through the proxy
  tube list                          Show active routes
  tube proxy start                   Start the proxy daemon
  tube proxy stop                    Stop the proxy daemon
  tube --daemon                      Start in daemon mode (for GUI)
  tube --help                        Show this help

Examples:
  tube myapp next dev                https://myapp.localhost
  tube api pnpm start                https://api.localhost
  tube web vite                      https://web.localhost
  tube list

Environment:
  TUBE_TLD    Custom TLD (default: localhost)
  TUBE_PORT   Proxy port (default: 443)
  TUBE_NO_TLS Disable TLS (set to 1)
`);
}

// ─── Daemon Mode ────────────────────────────────────────────────────────────

function runDaemon(): void {
  const PORT = parseInt(process.env.TUBE_PORT || "443", 10);
  const API_PORT = parseInt(process.env.TUBE_API_PORT || "0", 10);
  const TLS = process.env.TUBE_NO_TLS !== "1";

  console.error(`[tube] Daemon — proxy :${PORT}, TLS: ${TLS}`);

  const recorder = new TrafficRecorder(1000);
  const startTime = Date.now();
  let currentRoutes: ProxyRouteInfo[] = [];
  let tunnelStatus: TunnelStatus = { ngrok: false, tailscale: false, funnel: false, urls: {} };

  // Load or generate TLS certs
  const sniCallback = TLS ? createSNICallback(TLD) : undefined;
  const certs = TLS ? loadCerts(TLD) : undefined;
  const tlsEnabled = TLS && certs !== undefined;

  if (certs) {
    trustCA();
  }
  if (TLS && !certs) {
    console.error("[tube] TLS requested but certs unavailable — falling back to HTTP only");
  }

  // Proxy
  const proxy = createTubeProxy({
    getRoutes: () => currentRoutes,
    proxyPort: PORT,
    tld: TLD,
    strict: true,
    onError: (msg) => console.error(`[tube] ${msg}`),
    tls: tlsEnabled ? certs : undefined,
    sniCallback: tlsEnabled ? sniCallback : undefined,
    recorder,
  });

  // API server
  const apiServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "tube-engine", version: "0.2.0" }));
  });

  startApiServer(apiServer, {
    recorder,
    getRoutes: () =>
      currentRoutes.map(
        (r): RouteInfo => ({
          hostname: r.hostname,
          port: r.port,
          pid: 0,
          localUrl: `https://${r.hostname}`,
        })
      ),
    getTunnelStatus: () => tunnelStatus,
    setTunnel: (type, enabled) => {
      if (enabled) {
        startTunnel(type, PORT, (status) => {
          tunnelStatus = status;
        });
        tunnelStatus = getTunnelStatus();
      } else {
        stopTunnel(type);
        tunnelStatus = getTunnelStatus();
      }
    },
    getProxyPort: () => PORT,
    getTLS: () => TLS,
    getTLD: () => TLD,
    getStartTime: () => startTime,
  });

  // Listen
  proxy.listen(PORT, () => {
    writeFileSync(PROXY_PORT_PATH, String(PORT));
    console.error(`[tube] Proxy: ${PORT}`);
  });

  apiServer.listen(API_PORT, () => {
    const addr = apiServer.address();
    const port = typeof addr === "object" && addr ? addr.port : API_PORT;
    console.log(`TUBE_API_PORT=${port}`);
    console.error(`[tube] API: ws://127.0.0.1:${port}/api`);
    try { writeFileSync(API_PORT_PATH, String(port)); } catch {}
  });

  // Ensure state dir + write PID
  ensureStateDir();
  writeFileSync(PROXY_PID_PATH, String(process.pid));

  // Poll routes from tube state
  function syncRoutes(): void {
    const merged: ProxyRouteInfo[] = [];

    try {
      const content = readFileSync(ROUTES_PATH, "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        for (const r of parsed) {
          const h = String(r.hostname || "");
          const p = Number(r.port || 0);
          if (h && p > 0 && !merged.find((m) => m.hostname === h)) {
            merged.push({ hostname: h, port: p });
          }
        }
      }
    } catch {}

    currentRoutes = merged;
  }

  syncRoutes();
  setInterval(syncRoutes, 3000);

  // Shutdown
  function shutdown(signal: string): void {
    console.error(`\n[tube] ${signal} — shutdown`);
    try { writeFileSync(ROUTES_PATH, "[]"); } catch {}
    proxy.close();
    apiServer.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  console.error("[tube] Daemon ready");
}

// ─── CLI: Run app ───────────────────────────────────────────────────────────

function runApp(name: string, cmdArgs: string[]): void {
  const appPort = findFreePort();
  const hostname = `${name}.${TLD}`;

  console.error(`[tube] Starting "${name}" → https://${hostname}`);

  // Ensure state dir and routes.json exist
  ensureStateDir();
  ensureRoutesFile();

  // Spawn the dev server
  const child = spawn(cmdArgs[0], cmdArgs.slice(1), {
    stdio: "inherit",
    env: {
      ...process.env,
      PORT: String(appPort),
      TUBE_URL: `https://${hostname}`,
      TUBE_NAME: name,
      HOST: "127.0.0.1",
    },
  });

  // Register route (write to routes.json — daemon picks it up)
  registerRoute(name, hostname, appPort, child.pid || 0);

  // Print the URL
  console.log(`\n  https://${hostname}\n`);

  // Forward signals
  process.on("SIGINT", () => { child.kill("SIGINT"); });
  process.on("SIGTERM", () => { child.kill("SIGTERM"); });
  process.on("SIGHUP", () => { child.kill("SIGHUP"); });

  // Wait for exit
  child.on("exit", (code, signal) => {
    unregisterRoute(hostname);
    const exitCode = typeof code === "number" ? code : (signal ? 1 : 0);
    process.exit(exitCode);
  });
}

function findFreePort(): number {
  // Pick a random port in the 4000-4999 range (like portless)
  return 4000 + Math.floor(Math.random() * 1000);
}

// ─── Route Management ───────────────────────────────────────────────────────

interface RouteEntry {
  hostname: string;
  port: number;
  pid: number;
  tailscaleUrl?: string;
  ngrokUrl?: string;
}

function readRoutes(): RouteEntry[] {
  try {
    const content = readFileSync(ROUTES_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

function writeRoutes(routes: RouteEntry[]): void {
  writeFileSync(ROUTES_PATH, JSON.stringify(routes, null, 2));
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

function ensureRoutesFile(): void {
  if (!existsSync(ROUTES_PATH)) {
    writeRoutes([]);
  }
}

function registerRoute(name: string, hostname: string, port: number, pid: number): void {
  const routes = readRoutes().filter((r) => r.hostname !== hostname);
  routes.push({ hostname, port, pid });
  writeRoutes(routes);
  console.error(`[tube] Route registered: ${hostname} → :${port} (PID ${pid})`);
}

function unregisterRoute(hostname: string): void {
  const routes = readRoutes().filter((r) => r.hostname !== hostname);
  writeRoutes(routes);
  console.error(`[tube] Route removed: ${hostname}`);
}

// ─── CLI: List routes ───────────────────────────────────────────────────────

function cmdList(): void {
  const routes = readRoutes();
  if (routes.length === 0) {
    console.log("No active routes.");
    return;
  }
  console.log("\nActive routes:");
  for (const r of routes) {
    const alive = isPidAlive(r.pid);
    console.log(`  https://${r.hostname} → :${r.port}  ${alive ? "●" : "○"}`);
  }
  console.log();
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── CLI: Proxy commands ────────────────────────────────────────────────────

function cmdProxy(sub: string[]): void {
  const action = sub[0] || "";
  switch (action) {
    case "start":
      runDaemon();
      break;
    case "stop":
      cmdProxyStop();
      break;
    case "status":
      cmdProxyStatus();
      break;
    default:
      console.error("Usage: tube proxy start|stop|status");
      process.exit(1);
  }
}

function cmdProxyStop(): void {
  try {
    const pid = parseInt(readFileSync(PROXY_PID_PATH, "utf-8").trim(), 10);
    process.kill(pid, "SIGTERM");
    console.error(`[tube] Proxy (PID ${pid}) stopped.`);
  } catch {
    console.error("[tube] No running proxy found.");
    process.exit(1);
  }
}

function cmdProxyStatus(): void {
  try {
    const pid = parseInt(readFileSync(PROXY_PID_PATH, "utf-8").trim(), 10);
    const alive = isPidAlive(pid);
    const port = readFileSync(PROXY_PORT_PATH, "utf-8").trim();
    console.log(`Proxy PID: ${pid}  ${alive ? "● Running" : "○ Stopped"}`);
    console.log(`Proxy port: ${port}`);
    if (alive) {
      try {
        const apiPort = readFileSync(API_PORT_PATH, "utf-8").trim();
        console.log(`API port: ${apiPort}`);
      } catch {}
    }
  } catch {
    console.log("Proxy: not running");
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

main();
