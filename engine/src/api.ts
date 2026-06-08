/**
 * WebSocket API — communication protocol between the PerryTS UI and the Bun engine.
 *
 * Two message types over a single WebSocket connection (path: /api):
 *
 * 1. Commands (UI → Engine): request/response pattern
 *    Request:  { reqId: string, cmd: string, payload?: any }
 *    Response: { reqId: string, ok: boolean, data?: any, error?: string }
 *
 * 2. Events (Engine → UI): push notifications (no response expected)
 *    { event: string, data: any }
 *    - 'traffic': new capture available (streamed in real-time)
 *    - 'route-added' / 'route-removed': route table changes
 *
 * Commands supported:
 *   get-status       → full engine status (routes, tunnels, traffic count)
 *   get-routes       → active routes list
 *   get-traffic      → all buffered captures
 *   get-traffic-for-host → filtered captures
 *   get-capture      → single capture detail
 *   get-capture-body → raw request/response body
 *   replay           → resend captured request
 *   edit-replay      → modify and resend
 *   start-tunnel     → enable ngrok/tailscale/funnel
 *   stop-tunnel      → disable tunnel
 *
 * The UI connects via ws://127.0.0.1:<port>/api.
 * The engine prints TUBE_API_PORT=<port> to stdout on startup.
 */

import type { Server as HTTPServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { TrafficRecorder, CaptureEntry } from "./recorder";

// ─── Protocol Types ─────────────────────────────────────────────────────────

export interface ApiRequest {
  /** Request ID for correlation (UI sets this, engine echoes in response). */
  reqId: string;
  /** Command name. */
  cmd:
    | "get-routes"
    | "get-traffic"
    | "get-traffic-for-host"
    | "get-capture"
    | "replay"
    | "edit-replay"
    | "start-tunnel"
    | "stop-tunnel"
    | "get-status"
    | "get-capture-body";
  /** Command payload (varies by command). */
  payload?: unknown;
}

export interface ApiResponse {
  reqId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ApiEvent {
  event: "route-added" | "route-removed" | "traffic" | "tunnel-status" | "error";
  data: unknown;
}

// ─── Tunnel Config (delegates to portless's --ngrok / --tailscale) ──────────

export interface TunnelStatus {
  ngrok: boolean;
  tailscale: boolean;
  funnel: boolean;
  urls: Record<string, string>;
}

// ─── Route Info ─────────────────────────────────────────────────────────────

export interface RouteInfo {
  hostname: string;
  port: number;
  pid: number;
  localUrl: string;
  tunnelUrl?: string;
  tailscaleUrl?: string;
  ngrokUrl?: string;
}

// ─── Engine Status ──────────────────────────────────────────────────────────

export interface EngineStatus {
  proxyPort: number;
  tls: boolean;
  tld: string;
  routes: RouteInfo[];
  tunnel: TunnelStatus;
  uptime: number;
  trafficCount: number;
}

// ─── WebSocket Server ───────────────────────────────────────────────────────

export interface ApiDependencies {
  recorder: TrafficRecorder;
  getRoutes: () => RouteInfo[];
  getTunnelStatus: () => TunnelStatus;
  setTunnel: (type: "ngrok" | "tailscale" | "funnel", enabled: boolean) => void;
  getProxyPort: () => number;
  getTLS: () => boolean;
  getTLD: () => string;
  getStartTime: () => number;
}

export function startApiServer(
  server: HTTPServer,
  deps: ApiDependencies
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/api" });

  wss.on("connection", (ws) => {
    // Unsubscribe functions
    const cleanups: (() => void)[] = [];

    // Push traffic events to UI
    cleanups.push(
      deps.recorder.onCapture((entry: CaptureEntry) => {
        if (ws.readyState === WebSocket.OPEN) {
          const event: ApiEvent = {
            event: "traffic",
            data: entry,
          };
          ws.send(JSON.stringify(event));
        }
      })
    );

    ws.on("message", (raw) => {
      let req: ApiRequest;
      try {
        req = JSON.parse(raw.toString()) as ApiRequest;
      } catch {
        sendError(ws, "", "Invalid JSON");
        return;
      }

      handleCommand(req, ws, deps).catch((err) => {
        sendError(ws, req.reqId, err.message);
      });
    });

    ws.on("close", () => {
      for (const cleanup of cleanups) cleanup();
    });

    ws.on("error", () => {
      for (const cleanup of cleanups) cleanup();
    });
  });

  return wss;
}

async function handleCommand(
  req: ApiRequest,
  ws: WebSocket,
  deps: ApiDependencies
): Promise<void> {
  switch (req.cmd) {
    case "get-status": {
      const routes = deps.getRoutes();
      sendOk(ws, req.reqId, {
        proxyPort: deps.getProxyPort(),
        tls: deps.getTLS(),
        tld: deps.getTLD(),
        routes,
        tunnel: deps.getTunnelStatus(),
        uptime: Date.now() - deps.getStartTime(),
        trafficCount: deps.recorder.getBuffer().length,
      } satisfies EngineStatus);
      break;
    }

    case "get-routes": {
      sendOk(ws, req.reqId, deps.getRoutes());
      break;
    }

    case "get-traffic": {
      sendOk(ws, req.reqId, deps.recorder.getBuffer());
      break;
    }

    case "get-traffic-for-host": {
      const { host } = req.payload as { host: string };
      sendOk(ws, req.reqId, deps.recorder.getBufferForHost(host));
      break;
    }

    case "get-capture": {
      const { id } = req.payload as { id: string };
      const capture = deps.recorder.getCapture(id);
      sendOk(ws, req.reqId, capture ?? null);
      break;
    }

    case "get-capture-body": {
      const { id } = req.payload as { id: string };
      const capture = deps.recorder.getCapture(id);
      if (!capture) {
        sendError(ws, req.reqId, "Capture not found");
        return;
      }
      sendOk(ws, req.reqId, {
        requestBody: capture.requestBody,
        responseBody: capture.responseBody,
      });
      break;
    }

    case "replay": {
      const { id } = req.payload as { id: string };
      const capture = deps.recorder.getCapture(id);
      if (!capture) {
        sendError(ws, req.reqId, "Capture not found");
        return;
      }
      // Replay the request: make a new HTTP request to the backend
      try {
        const result = await replayRequest(capture);
        sendOk(ws, req.reqId, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(ws, req.reqId, `Replay failed: ${msg}`);
      }
      break;
    }

    case "edit-replay": {
      const { id, edits } = req.payload as {
        id: string;
        edits: {
          method?: string;
          path?: string;
          headers?: Record<string, string>;
          body?: string;
        };
      };
      const capture = deps.recorder.getCapture(id);
      if (!capture) {
        sendError(ws, req.reqId, "Capture not found");
        return;
      }
      const modified = { ...capture, ...edits };
      try {
        const result = await replayRequest(modified);
        sendOk(ws, req.reqId, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        sendError(ws, req.reqId, `Replay failed: ${msg}`);
      }
      break;
    }

    case "start-tunnel": {
      const { type } = req.payload as { type: "ngrok" | "tailscale" | "funnel" };
      deps.setTunnel(type, true);
      sendOk(ws, req.reqId, deps.getTunnelStatus());
      break;
    }

    case "stop-tunnel": {
      const { type } = req.payload as { type: "ngrok" | "tailscale" | "funnel" };
      deps.setTunnel(type, false);
      sendOk(ws, req.reqId, deps.getTunnelStatus());
      break;
    }

    default: {
      sendError(ws, req.reqId, `Unknown command: ${req.cmd}`);
    }
  }
}

// ─── Replay Logic ───────────────────────────────────────────────────────────

async function replayRequest(
  capture: Partial<CaptureEntry> & {
    method: string;
    path: string;
    host: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
  }
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const hostname = capture.host.split(".")[0];
  const { default: http } = await import("node:http");
  const { default: https } = await import("node:https");
  const isHttps = capture.path?.startsWith("https");

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      method: capture.method,
      path: capture.path,
      headers: {
        ...capture.requestHeaders,
        host: capture.host,
      },
    };

    const mod = isHttps ? https : http;
    const body = capture.requestBody || "";

    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 502,
          headers: res.headers as Record<string, string>,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.end(body);
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sendOk(ws: WebSocket, reqId: string, data: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    const res: ApiResponse = { reqId, ok: true, data };
    ws.send(JSON.stringify(res));
  }
}

function sendError(ws: WebSocket, reqId: string, error: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    const res: ApiResponse = { reqId, ok: false, error };
    ws.send(JSON.stringify(res));
  }
}
