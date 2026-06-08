/**
 * Tube Proxy — HTTPS/HTTP2 reverse proxy with traffic recording.
 *
 * Core responsibilities:
 *   1. Accept incoming HTTPS (HTTP/2 + HTTP/1.1) or plain HTTP requests
 *   2. Look up the target app by Host header (via `getRoutes` callback)
 *   3. Forward the request to 127.0.0.1:<assigned-port>
 *   4. Record the full request/response via PassThrough streams
 *   5. Handle WebSocket upgrades (portless-compatible)
 *
 * Architecture:
 *   - TLS mode: single net.Server demuxes TLS (0x16) vs plain HTTP → 302 to HTTPS
 *   - HTTP/2 via http2.createSecureServer with allowHTTP1 fallback
 *   - Plain HTTP mode: standard http.createServer
 *   - Recording uses PassThrough streams so data still flows end-to-end
 *     without buffering the entire body (streaming-friendly)
 *
 * Based on Portless proxy architecture (Apache 2.0, Vercel Labs).
 */

import * as http from "node:http";
import * as http2 from "node:http2";
import * as net from "node:net";
import * as tls from "node:tls";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { TrafficRecorder } from "./recorder";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RouteInfo {
  hostname: string;
  port: number;
}

export interface TLSConfig {
  cert: Buffer;
  key: Buffer;
  ca?: Buffer;
}

export interface TubeProxyOptions {
  getRoutes: () => RouteInfo[];
  proxyPort: number;
  tld?: string;
  strict?: boolean;
  onError?: (msg: string) => void;
  tls?: TLSConfig;
  sniCallback?: (
    servername: string,
    cb: (err: Error | null, ctx: tls.SecureContext) => void
  ) => void;
  recorder: TrafficRecorder;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TUBE_HEADER = "X-Tube";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);
const TUBE_HOPS_HEADER = "x-tube-hops";
const MAX_PROXY_HOPS = 5;

// ─── Helpers ───────────────────────────────────────────────────────────────

function getRequestHost(req: http.IncomingMessage): string {
  const authority = (req.headers as Record<string, string>)["host"] || "";
  return authority.split(":")[0];
}

function isEncrypted(req: http.IncomingMessage): boolean {
  return !!(req.socket as net.Socket & { encrypted?: boolean }).encrypted;
}

function findRoute(
  routes: RouteInfo[],
  host: string,
  strict?: boolean,
  tld?: string
): RouteInfo | undefined {
  if (tld && host !== tld && !host.endsWith(`.${tld}`)) {
    return undefined;
  }
  return (
    routes.find((r) => r.hostname === host) ||
    (strict ? undefined : routes.find((r) => host.endsWith("." + r.hostname)))
  );
}

function buildForwardedHeaders(req: http.IncomingMessage): Record<string, string> {
  const tls = isEncrypted(req);
  const remoteAddress = req.socket.remoteAddress || "127.0.0.1";
  const proto = tls ? "https" : "http";
  const host = getRequestHost(req);
  const defaultPort = tls ? "443" : "80";

  return {
    "x-forwarded-for": (req.headers["x-forwarded-for"] as string)
      ? `${req.headers["x-forwarded-for"]}, ${remoteAddress}`
      : remoteAddress,
    "x-forwarded-proto": (req.headers["x-forwarded-proto"] as string) || proto,
    "x-forwarded-host": (req.headers["x-forwarded-host"] as string) || host,
    "x-forwarded-port":
      (req.headers["x-forwarded-port"] as string) || host.split(":")[1] || defaultPort,
  };
}

// ─── Proxy Server ───────────────────────────────────────────────────────────

export function createTubeProxy(
  options: TubeProxyOptions
): net.Server {
  const {
    getRoutes,
    proxyPort,
    tld = "localhost",
    strict = true,
    onError = (msg: string) => console.error(msg),
    tls,
    sniCallback,
    recorder,
  } = options;

  const handleRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader(TUBE_HEADER, "1");

    const routes = getRoutes();
    const host = getRequestHost(req);

    if (!host) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing Host header");
      return;
    }

    // Loop detection
    const hops = parseInt(req.headers[TUBE_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      onError(`Loop detected for ${host}`);
      res.writeHead(508, { "Content-Type": "text/plain" });
      res.end("Loop Detected");
      return;
    }

    const route = findRoute(routes, host, strict, tld);
    if (!route) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`No app registered for ${host}`);
      return;
    }

    // ── Start recording ──
    const captureId = recorder.startCapture(req, host);
    const reqBodyChunks: Buffer[] = [];

    const forwardedHeaders = buildForwardedHeaders(req);
    const proxyReqHeaders: http.OutgoingHttpHeaders = {
      ...req.headers,
      ...forwardedHeaders,
      [TUBE_HOPS_HEADER]: String(hops + 1),
    };

    // Remove HTTP/2 pseudo-headers
    for (const key of Object.keys(proxyReqHeaders)) {
      if (key.startsWith(":")) delete proxyReqHeaders[key];
    }

    const proxyReq = http.request(
      {
        hostname: "127.0.0.1",
        port: route.port,
        path: req.url,
        method: req.method,
        headers: proxyReqHeaders,
      },
      (proxyRes) => {
        const resHeaders = { ...proxyRes.headers } as Record<string, string>;

        // Capture response via PassThrough stream
        const resCapture = new PassThrough();
        const resChunks: Buffer[] = [];
        resCapture.on("data", (chunk: Buffer) => resChunks.push(chunk));
        resCapture.on("end", () => {
          recorder.finalize(
            captureId,
            req,
            host,
            proxyRes.statusCode || 502,
            resHeaders,
            Buffer.concat(resChunks).toString("utf-8")
          );
        });

        // Forward response to client
        const responseHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };
        if (isEncrypted(req)) {
          for (const h of HOP_BY_HOP_HEADERS) delete responseHeaders[h];
        }
        res.writeHead(proxyRes.statusCode || 502, responseHeaders);

        proxyRes.pipe(resCapture);
        resCapture.pipe(res);
      }
    );

    proxyReq.on("error", (err) => {
      onError(`Proxy error for ${host}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        res.end("Bad Gateway");
      }
    });

    // Capture request body
    const reqCapture = new PassThrough();
    reqCapture.on("data", (chunk: Buffer) => {
      reqBodyChunks.push(chunk);
      recorder.addRequestBodyChunk(captureId, chunk);
    });

    req.pipe(reqCapture);
    reqCapture.pipe(proxyReq);

    // Handle client disconnect
    res.on("close", () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });
    req.on("error", () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });
  };

  const handleUpgrade = (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on("error", () => socket.destroy());

    const hops = parseInt(req.headers[TUBE_HOPS_HEADER] as string, 10) || 0;
    if (hops >= MAX_PROXY_HOPS) {
      socket.end();
      return;
    }

    const routes = getRoutes();
    const host = getRequestHost(req);
    const route = findRoute(routes, host, strict, tld);
    if (!route) {
      socket.destroy();
      return;
    }

    const forwardedHeaders = buildForwardedHeaders(req);
    const proxyReqHeaders: http.OutgoingHttpHeaders = {
      ...req.headers,
      ...forwardedHeaders,
      [TUBE_HOPS_HEADER]: String(hops + 1),
    };
    for (const key of Object.keys(proxyReqHeaders)) {
      if (key.startsWith(":")) delete proxyReqHeaders[key];
    }

    const proxyReq = http.request({
      hostname: "127.0.0.1",
      port: route.port,
      path: req.url,
      method: req.method,
      headers: proxyReqHeaders,
    });

    proxyReq.on("upgrade", (_proxyRes, proxySocket, proxyHead) => {
      let response = "HTTP/1.1 101 Switching Protocols\r\n";
      for (let i = 0; i < (_proxyRes as unknown as { rawHeaders: string[] }).rawHeaders.length; i += 2) {
        response += `${(_proxyRes as unknown as { rawHeaders: string[] }).rawHeaders[i]}: ${(_proxyRes as unknown as { rawHeaders: string[] }).rawHeaders[i + 1]}\r\n`;
      }
      response += "\r\n";
      socket.write(response);
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      const cleanup = () => { proxySocket.destroy(); socket.destroy(); };
      proxySocket.on("error", cleanup);
      socket.on("error", cleanup);
      proxySocket.on("close", cleanup);
      socket.on("end", cleanup);
    });

    proxyReq.on("error", () => socket.destroy());
    proxyReq.on("response", (res) => {
      if (!socket.destroyed) {
        let response = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
        for (let i = 0; i < res.rawHeaders.length; i += 2) {
          response += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
        }
        response += "\r\n";
        socket.write(response);
        res.on("error", () => socket.destroy());
        res.pipe(socket);
      }
    });

    if (head.length > 0) proxyReq.write(head);
    proxyReq.end();
  };

  // ── Create server ──

  if (tls) {
    // HTTP/2 + HTTP/1.1 with TLS
    const h2Options: http2.SecureServerOptions = {
      cert: tls.ca ? Buffer.concat([tls.cert, tls.ca]) : tls.cert,
      key: tls.key,
      allowHTTP1: true,
      ...({ streamResetBurst: 10000, streamResetRate: 100 } as Record<string, unknown>),
    };
    if (sniCallback) {
      h2Options.SNICallback = sniCallback;
    }
    const h2Server = http2.createSecureServer(h2Options);

    h2Server.on("sessionError", () => {});
    h2Server.on("request", (req: http2.Http2ServerRequest, res: http2.Http2ServerResponse) => {
      req.stream?.on("error", () => {});
      handleRequest(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);
    });
    h2Server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      handleUpgrade(req, socket, head);
    });

    // Plain HTTP → 302 redirect to HTTPS
    const plainServer = http.createServer((req, res) => {
      const host = getRequestHost(req) || "localhost";
      const location = `https://${host}${proxyPort === 443 ? "" : `:${proxyPort}`}${req.url || "/"}`;
      res.writeHead(302, { Location: location, [TUBE_HEADER]: "1" });
      res.end();
    });
    plainServer.on("upgrade", (req: http.IncomingMessage) => {
      console.warn(`[tube] Dropped plain-HTTP WebSocket upgrade for ${getRequestHost(req)}`);
    });

    // Wrap both in a single net.Server that demuxes TLS vs plain HTTP
    const wrapper = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      socket.once("readable", () => {
        const buf: Buffer | null = socket.read(1);
        if (!buf) { socket.destroy(); return; }
        socket.unshift(buf);
        if (buf[0] === 0x16) {
          h2Server.emit("connection", socket);
        } else {
          plainServer.emit("connection", socket);
        }
      });
    });

    const origClose = wrapper.close.bind(wrapper);
    wrapper.close = function (cb?: (err?: Error) => void) {
      h2Server.close();
      plainServer.close();
      return origClose(cb);
    } as typeof wrapper.close;

    return wrapper;
  }

  // HTTP/1.1 only (no TLS)
  const httpServer = http.createServer(handleRequest);
  httpServer.on("upgrade", handleUpgrade);
  return httpServer;
}
