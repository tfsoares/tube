/**
 * Tube — Native macOS GUI app (PerryTS → AppKit).
 *
 * Compiled by PerryTS (SWC + LLVM) to a native executable (~9 MB).
 * No Electron, no WebView — real NSView widgets via perry/ui.
 *
 * Features:
 *   - Tray icon (NSStatusItem) via trayCreate()
 *   - No dock icon (activationPolicy: "accessory")
 *   - Split view: route sidebar | traffic inspector
 *   - Reactive text elements (textSetString)
 *   - Spawns the Bun engine as a child process
 *   - IPC via WebSocket (ws://127.0.0.1:<port>/api)
 *
 * Lifecycle:
 *   1. App() creates the native window (hidden at start)
 *   2. setupTray() creates NSStatusItem with context menu
 *   3. startEngine() spawns tube-engine as child process
 *   4. Engine prints TUBE_API_PORT=<port> to stdout
 *   5. connectWs() establishes WebSocket to engine
 *   6. UI updates reactively via textSetString() on WS events
 *   7. On quit: kill engine, destroy tray, exit
 *
 * Environment:
 *   TUBE_PORT       - proxy port (default 443)
 *   TUBE_NO_TLS     - disable TLS (set "1" for dev)
 *   TUBE_API_PORT   - WebSocket API port (default random)
 */

import {
  App, VStack, HStack, Text, Button, Spacer, SplitView,
  widgetAddChild, widgetSetWidth, widgetMatchParentWidth,
  textSetString, Divider,
  trayCreate, traySetTooltip, trayAttachMenu, trayDestroy,
  menuCreate, menuAddItem, menuAddSeparator,
  Table, tableSetColumnHeader, tableSetColumnWidth, tableUpdateRowCount, tableSetOnRowSelect,
} from "perry/ui";
import { spawn } from "child_process";

// ─── State ──────────────────────────────────────────────────────────────────

let ws: any = null;
let apiPort = 0;
let engineProc: any = null;
let routes: Array<{ hostname: string; port: number; localUrl: string }> = [];
let captures: Array<any> = [];
let requestId = 0;
let pendingReqs: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }> = new Map();
let tray: any = null;
let capturesTable: any = null;

// ─── Engine lifecycle ───────────────────────────────────────────────────────

function findEnginePath(): string {
  const candidates = [
    "../dist/tube-engine",
    `${__dirname}/tube-engine`,
    `${__dirname}/../Resources/tube-engine`,
    `${__dirname}/../../Resources/tube-engine`,
  ];
  // In Perry, we can't use try-catch with fs easily.
  // Just use the most likely path based on context.
  return candidates[0];
}

function startEngine(): void {
  const enginePath = findEnginePath();

  engineProc = spawn(enginePath, [], {
    env: {
      TUBE_PORT: "443",
      TUBE_NO_TLS: "1",
      TUBE_API_PORT: "0",
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buf = "";
  engineProc.stdout.on("data", (chunk: string) => {
    buf += String(chunk);
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const m = line.match(/TUBE_API_PORT=(\d+)/);
      if (m) {
        apiPort = parseInt(m[1], 10);
        connectWs();
      }
    }
  });

  engineProc.on("exit", () => {
    engineProc = null;
    updateStatusText("Engine: stopped");
  });
}

// ─── WebSocket IPC ──────────────────────────────────────────────────────────

function connectWs(): void {
  if (!apiPort) return;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${apiPort}/api`);
    ws.on("open", () => {
      updateStatusText("Engine: connected");
      send("get-status");
    });
    ws.on("message", (raw: string) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.event) {
          if (msg.event === "traffic") {
            captures.unshift(msg.data);
            if (captures.length > 200) captures.length = 200;
            refreshCaptures();
          }
        } else if (msg.reqId) {
          const p = pendingReqs.get(msg.reqId);
          if (p) {
            pendingReqs.delete(msg.reqId);
            if (msg.ok) {
              p.resolve(msg.data);
              if (msg.reqId.startsWith("get-status")) {
                applyStatus(msg.data);
              }
            } else {
              p.reject(new Error(msg.error || "error"));
            }
          }
        }
      } catch {}
    });
    ws.on("close", () => {
      ws = null;
      updateStatusText("Engine: disconnected");
      setTimeout(connectWs, 2000);
    });
    ws.on("error", () => updateStatusText("Engine: connection error"));
  } catch {
    updateStatusText("Engine: connection failed");
  }
}

function send(cmd: string, payload?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ws) { reject(new Error("Not connected")); return; }
    const reqId = `r${++requestId}`;
    pendingReqs.set(reqId, { resolve, reject });
    ws.send(JSON.stringify({ reqId, cmd, payload }));
    setTimeout(() => {
      if (pendingReqs.has(reqId)) {
        pendingReqs.delete(reqId);
        reject(new Error("Timeout"));
      }
    }, 10000);
  });
}

function applyStatus(data: any): void {
  if (data.routes) routes = data.routes;
  if (data.tunnel) {
    const t = data.tunnel;
    const urls: string[] = [];
    if (t.ngrok && t.urls.ngrok) urls.push(`ngrok: ${t.urls.ngrok}`);
    if (t.tailscale && t.urls.tailscale) urls.push(`tailscale: ${t.urls.tailscale}`);
    if (t.funnel && t.urls.funnel) urls.push(`cloudflare: ${t.urls.funnel}`);
    textSetString("tunnel-status", urls.length > 0 ? urls.join("\n") : "No active tunnels");
  }
  if (data.trafficCount !== undefined) {
    traySetTooltip(tray, `Tube — ${routes.length} route(s), ${data.trafficCount} request(s)`);
  }
  refreshRoutes();
}

// ─── UI Refresh ─────────────────────────────────────────────────────────────

function updateStatusText(s: string): void {
  textSetString("status", s);
}

function refreshRoutes(): void {
  const s = routes.length === 0
    ? "No active routes."
    : routes.map((r) => `  ${r.localUrl}`).join("\n");
  textSetString("routes-content", s);
}

function refreshCaptures(): void {
  tableUpdateRowCount(capturesTable, Math.min(captures.length, 200));
}

function showCaptureDetail(c: any): void {
  const parts = [
    `${c.method || "?"} ${c.path || "/"}`,
    `Status: ${c.statusCode || "…"}`,
    `Duration: ${c.duration ? c.duration + "ms" : "…"}`,
    `Host: ${c.host || "?"}`,
    "",
    c.resBody ? `Response: ${c.resBody.slice(0, 2000)}` : "",
  ];
  textSetString("capture-detail", parts.filter(Boolean).join("\n"));
}

// ─── Build UI ───────────────────────────────────────────────────────────────

const SIDEBAR_W = 280;

// Status bar
const statusRow = HStack([
  Text("Engine: starting…", "status"),
  Spacer(),
]);
widgetMatchParentWidth(statusRow);

// Routes section
const routesContent = Text("No active routes.", "routes-content");
widgetMatchParentWidth(routesContent);
const routesBox = VStack([Text("Routes"), routesContent]);
widgetMatchParentWidth(routesBox);

// Tunnel section
const tunnelsBox = VStack([
  Text("Tunnels"),
  Text("No active tunnels", "tunnel-status"),
]);
widgetMatchParentWidth(tunnelsBox);

// Sidebar
const sidebar = VStack([
  routesBox,
  Divider(),
  tunnelsBox,
  Spacer(),
  Button("Refresh", () => { send("get-status").catch(() => {}); }),
]);
widgetSetWidth(sidebar, SIDEBAR_W);

// Main area
const capturesHeader = HStack([
  Text("Traffic Inspector", "captures-hdr"),
  Spacer(),
  Button("Clear", () => { captures = []; refreshCaptures(); }),
]);
widgetMatchParentWidth(capturesHeader);

capturesTable = Table(0, 4, (row: number, col: number) => {
  const c = captures[row];
  if (!c) return Text("");
  switch (col) {
    case 0: return Text(c.method || "");
    case 1: return Text(c.path || "/");
    case 2: return Text(c.statusCode ? String(c.statusCode) : "…");
    case 3: return Text(c.duration ? `${c.duration}ms` : "…");
    default: return Text("");
  }
});

tableSetColumnHeader(capturesTable, 0, "Method");
tableSetColumnHeader(capturesTable, 1, "Path");
tableSetColumnHeader(capturesTable, 2, "Status");
tableSetColumnHeader(capturesTable, 3, "Duration");
tableSetColumnWidth(capturesTable, 0, 70);
tableSetColumnWidth(capturesTable, 1, 350);
tableSetColumnWidth(capturesTable, 2, 60);
tableSetColumnWidth(capturesTable, 3, 80);

tableSetOnRowSelect(capturesTable, (row: number) => {
  const c = captures[row];
  if (c) showCaptureDetail(c);
});

const detailText = Text("Select a request to inspect", "capture-detail");
widgetMatchParentWidth(detailText);

const mainArea = VStack([capturesHeader, Divider(), capturesTable, Divider(), detailText]);
widgetMatchParentWidth(mainArea);

// Split view
const split = SplitView();
widgetAddChild(split, sidebar);
widgetAddChild(split, mainArea);

// Root layout
const root = VStack([statusRow, Divider(), split]);
widgetMatchParentWidth(root);

// ─── Tray / Menubar ─────────────────────────────────────────────────────────

function setupTray(): void {
  // Create tray icon (NSStatusItem on macOS)
  // Pass "" for default placeholder icon
  tray = trayCreate("");

  traySetTooltip(tray, "Tube — loading…");

  // Build tray context menu
  const trayMenu = menuCreate();
  menuAddItem(trayMenu, "Open Tube", () => {
    // Window is always visible — this just focuses it
    // (on macOS, clicking tray opens menu directly)
  });
  menuAddSeparator(trayMenu);
  menuAddItem(trayMenu, "Routes: loading…", () => {});
  menuAddSeparator(trayMenu);
  menuAddItem(trayMenu, "Quit", () => {
    if (engineProc) engineProc.kill("SIGTERM");
    if (tray) trayDestroy(tray);
    // Let the app terminate naturally
    process.exit(0);
  });

  trayAttachMenu(tray, trayMenu);
}

// ─── Entry ──────────────────────────────────────────────────────────────────

function main(): void {
  // Create the main app window
  App({
    title: "Tube",
    width: 1000,
    height: 650,
    body: root,
    // accessory = no dock icon, just menubar
    activationPolicy: "accessory",
    onTerminate: () => {
      if (engineProc) engineProc.kill("SIGTERM");
      if (tray) trayDestroy(tray);
    },
  });

  // Set up tray icon (menubar)
  setupTray();

  // Start engine
  startEngine();
}

main();
