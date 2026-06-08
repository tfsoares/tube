/**
 * Tube Tunnel — Spawns external tunnel processes (ngrok, tailscale funnel, cloudflared).
 *
 * Each tunnel type spawns a child process, captures the public URL from stdout,
 * and exposes it through the WebSocket API.
 */

import { spawn, type ChildProcess } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TunnelType = "ngrok" | "tailscale" | "funnel";

export interface TunnelStatus {
  ngrok: boolean;
  tailscale: boolean;
  funnel: boolean;
  urls: Record<string, string>;
}

interface ActiveTunnel {
  process: ChildProcess;
  url?: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

const tunnels = new Map<TunnelType, ActiveTunnel>();

// ─── URL extraction (per-tunnel-type stdout parser) ─────────────────────────

const URL_PATTERNS: Record<TunnelType, RegExp> = {
  ngrok: /https:\/\/[a-zA-Z0-9-]+\.ngrok-free\.app/,
  tailscale: /https:\/\/[a-z0-9-]+(?:-[a-z0-9]+)*\.(?:ts\.net|tailscale\.net)/i,
  funnel: /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/,
};

function extractUrl(type: TunnelType, text: string): string | undefined {
  const m = text.match(URL_PATTERNS[type]);
  return m ? m[0] : undefined;
}

// ─── Spawn / Kill ────────────────────────────────────────────────────────────

export function startTunnel(
  type: TunnelType,
  proxyPort: number,
  onUpdate: (status: TunnelStatus) => void
): void {
  if (tunnels.has(type)) return;

  const args = ((): [string, string[]] => {
    switch (type) {
      case "ngrok":
        return ["ngrok", ["http", String(proxyPort), "--log=stdout"]];
      case "tailscale":
        return ["tailscale", ["funnel", "--bg", String(proxyPort)]];
      case "funnel":
        return ["cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://localhost:${proxyPort}`]];
    }
  })();

  const proc = spawn(args[0], args[1], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry: ActiveTunnel = { process: proc };
  tunnels.set(type, entry);

  let buffer = "";

  const onData = (chunk: Buffer) => {
    buffer += chunk.toString();
    const url = extractUrl(type, buffer);
    if (url && url !== entry.url) {
      entry.url = url;
      console.error(`[tube] Tunnel ${type}: ${url}`);
      onUpdate(getStatus());
    }
  };

  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);

  proc.on("exit", () => {
    tunnels.delete(type);
    onUpdate(getStatus());
  });

  proc.on("error", (err) => {
    console.error(`[tube] Tunnel ${type} spawn error: ${err.message}`);
    tunnels.delete(type);
    onUpdate(getStatus());
  });

  console.error(`[tube] Tunnel ${type}: started`);
}

export function stopTunnel(type: TunnelType): void {
  const entry = tunnels.get(type);
  if (!entry) return;
  entry.process.kill("SIGTERM");
  // Also try SIGKILL after 3s if still alive
  setTimeout(() => {
    try { entry.process.kill("SIGKILL"); } catch {}
  }, 3000);
  tunnels.delete(type);
  console.error(`[tube] Tunnel ${type}: stopped`);
}

export function getStatus(): TunnelStatus {
  const urls: Record<string, string> = {};
  for (const [type, entry] of tunnels) {
    if (entry.url) urls[type] = entry.url;
  }
  return {
    ngrok: tunnels.has("ngrok"),
    tailscale: tunnels.has("tailscale"),
    funnel: tunnels.has("funnel"),
    urls,
  };
}
