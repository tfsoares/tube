import { describe, it, expect } from "bun:test";
import { extractUrl } from "../tunnel";

// ─── ngrok ───────────────────────────────────────────────────────────────────

describe("extractUrl — ngrok", () => {
  it("extracts ngrok-free.app URL from typical stdout", () => {
    const stdout = `
ngrok

Session Status                online
Account                       user (Plan: Free)
Forwarding                    https://crimson-otter.ngrok-free.app -> http://localhost:443
Web Interface                 http://127.0.0.1:4040
    `;
    expect(extractUrl("ngrok", stdout)).toBe("https://crimson-otter.ngrok-free.app");
  });

  it("extracts long subdomain ngrok URL", () => {
    const stdout = "Forwarding  https://abc-def-123-xyz.ngrok-free.app -> http://localhost:3000";
    expect(extractUrl("ngrok", stdout)).toBe("https://abc-def-123-xyz.ngrok-free.app");
  });

  it("returns undefined when no ngrok URL is present", () => {
    expect(extractUrl("ngrok", "Error: ngrok not installed")).toBeUndefined();
  });

  it("handles empty string", () => {
    expect(extractUrl("ngrok", "")).toBeUndefined();
  });
});

// ─── tailscale ───────────────────────────────────────────────────────────────

describe("extractUrl — tailscale", () => {
  it("extracts tailscale ts.net URL", () => {
    const stdout = `
Available on your Tailnet:

https://machine-name.tail1234.ts.net
    `;
    expect(extractUrl("tailscale", stdout)).toBe("https://machine-name.tail1234.ts.net");
  });

  it("extracts tailscale.net URL", () => {
    const stdout = "Funnel started: https://my-app.operator.tailscale.net";
    expect(extractUrl("tailscale", stdout)).toBe("https://my-app.operator.tailscale.net");
  });

  it("extracts hyphenated tailnet URL", () => {
    const stdout = "https://my-macbook-pro.tail0000.ts.net";
    expect(extractUrl("tailscale", stdout)).toBe("https://my-macbook-pro.tail0000.ts.net");
  });

  it("returns undefined for non-matching output", () => {
    expect(extractUrl("tailscale", "Funnel: error connecting")).toBeUndefined();
  });

  it("handles empty string", () => {
    expect(extractUrl("tailscale", "")).toBeUndefined();
  });
});

// ─── cloudflared (funnel) ────────────────────────────────────────────────────

describe("extractUrl — cloudflared", () => {
  it("extracts trycloudflare.com URL", () => {
    const stdout = `
2024-01-15T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2024-01-15T10:00:01Z INF Registered tunnel connection url=https://random-words-fish.trycloudflare.com
    `;
    expect(extractUrl("funnel", stdout)).toBe("https://random-words-fish.trycloudflare.com");
  });

  it("extracts URL from oneliner", () => {
    const stdout = "url=https://quick-badger-jump.trycloudflare.com";
    expect(extractUrl("funnel", stdout)).toBe("https://quick-badger-jump.trycloudflare.com");
  });

  it("returns undefined for non-matching output", () => {
    expect(extractUrl("funnel", "cloudflared: command not found")).toBeUndefined();
  });

  it("handles empty string", () => {
    expect(extractUrl("funnel", "")).toBeUndefined();
  });
});
