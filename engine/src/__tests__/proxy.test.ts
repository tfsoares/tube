import { describe, it, expect } from "bun:test";
import { findRoute, getRequestHost, buildForwardedHeaders, type RouteInfo } from "../proxy";
import type { IncomingMessage } from "node:http";
import * as net from "node:net";

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Record<string, unknown>> = {}): IncomingMessage {
  return {
    headers: {},
    method: "GET",
    url: "/",
    socket: {
      remoteAddress: "127.0.0.1",
      encrypted: false,
    } as unknown as net.Socket,
    ...overrides,
  } as IncomingMessage;
}

// ─── findRoute ───────────────────────────────────────────────────────────────

describe("findRoute", () => {
  const routes: RouteInfo[] = [
    { hostname: "myapp.localhost", port: 4042 },
    { hostname: "api.localhost", port: 4043 },
    { hostname: "web.test", port: 4044 },
  ];

  it("finds exact match", () => {
    const r = findRoute(routes, "myapp.localhost");
    expect(r).toEqual({ hostname: "myapp.localhost", port: 4042 });
  });

  it("returns undefined for unknown host", () => {
    const r = findRoute(routes, "unknown.localhost");
    expect(r).toBeUndefined();
  });

  it("returns undefined for empty routes array", () => {
    const r = findRoute([], "myapp.localhost");
    expect(r).toBeUndefined();
  });

  describe("strict mode", () => {
    it("does not match subdomains when strict is true", () => {
      const r = findRoute(routes, "abc.myapp.localhost", true);
      expect(r).toBeUndefined();
    });

    it("still matches exact hostname when strict is true", () => {
      const r = findRoute(routes, "myapp.localhost", true);
      expect(r).toEqual({ hostname: "myapp.localhost", port: 4042 });
    });
  });

  describe("loose mode (strict=false)", () => {
    it("matches subdomain via suffix check", () => {
      const r = findRoute(routes, "sub.myapp.localhost", false);
      expect(r).toEqual({ hostname: "myapp.localhost", port: 4042 });
    });

    it("still matches exact hostname", () => {
      const r = findRoute(routes, "myapp.localhost", false);
      expect(r).toEqual({ hostname: "myapp.localhost", port: 4042 });
    });
  });

  describe("TLD enforcement", () => {
    it("rejects host not matching TLD suffix", () => {
      const r = findRoute(routes, "myapp.test", false, "localhost");
      expect(r).toBeUndefined();
    });

    it("allows host matching TLD suffix", () => {
      const r = findRoute(routes, "myapp.localhost", false, "localhost");
      expect(r).toEqual({ hostname: "myapp.localhost", port: 4042 });
    });

    it("works with custom TLD", () => {
      const r = findRoute(routes, "web.test", false, "test");
      expect(r).toEqual({ hostname: "web.test", port: 4044 });
    });

    it("rejects .localhost host when TLD is .test", () => {
      const r = findRoute(routes, "myapp.localhost", false, "test");
      expect(r).toBeUndefined();
    });

    it("allows root TLD hostname exactly", () => {
      const r = findRoute([{ hostname: "test", port: 8080 }], "test", false, "test");
      expect(r).toEqual({ hostname: "test", port: 8080 });
    });

    it("rejects host with wrong suffix when TLD is substring", () => {
      const r = findRoute(routes, "myapp.localhosting", false, "localhost");
      expect(r).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("handles empty host string", () => {
      const r = findRoute(routes, "", false);
      expect(r).toBeUndefined();
    });

    it("returns first match when multiple routes share same hostname", () => {
      const dupes: RouteInfo[] = [
        { hostname: "dup.localhost", port: 4001 },
        { hostname: "dup.localhost", port: 4002 },
      ];
      const r = findRoute(dupes, "dup.localhost");
      expect(r?.port).toBe(4001);
    });
  });
});

// ─── getRequestHost ──────────────────────────────────────────────────────────

describe("getRequestHost", () => {
  it("extracts host from Host header", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    expect(getRequestHost(req)).toBe("myapp.localhost");
  });

  it("strips port from Host header", () => {
    const req = mockReq({ headers: { host: "myapp.localhost:443" } });
    expect(getRequestHost(req)).toBe("myapp.localhost");
  });

  it("returns empty string when Host header is missing", () => {
    const req = mockReq({ headers: {} });
    expect(getRequestHost(req)).toBe("");
  });

  it("handles empty host string", () => {
    const req = mockReq({ headers: { host: "" } });
    expect(getRequestHost(req)).toBe("");
  });
});

// ─── buildForwardedHeaders ───────────────────────────────────────────────────

describe("buildForwardedHeaders", () => {
  it("sets x-forwarded-for from remote address", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("appends to existing x-forwarded-for", () => {
    const req = mockReq({ headers: { host: "myapp.localhost", "x-forwarded-for": "10.0.0.1" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-for"]).toBe("10.0.0.1, 127.0.0.1");
  });

  it("uses http as proto for unencrypted connections", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-proto"]).toBe("http");
  });

  it("uses https as proto for encrypted connections", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    (req.socket as Record<string, unknown>).encrypted = true;
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-proto"]).toBe("https");
  });

  it("preserves existing x-forwarded-proto", () => {
    const req = mockReq({ headers: { host: "myapp.localhost", "x-forwarded-proto": "https" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-proto"]).toBe("https");
  });

  it("sets x-forwarded-host from Host header", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-host"]).toBe("myapp.localhost");
  });

  it("preserves existing x-forwarded-host", () => {
    const req = mockReq({ headers: { host: "myapp.localhost", "x-forwarded-host": "proxy.example.com" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-host"]).toBe("proxy.example.com");
  });

  it("sets x-forwarded-port to 80 for HTTP", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-port"]).toBe("80");
  });

  it("sets x-forwarded-port to 443 for HTTPS", () => {
    const req = mockReq({ headers: { host: "myapp.localhost" } });
    (req.socket as Record<string, unknown>).encrypted = true;
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-port"]).toBe("443");
  });

  it("extracts port from Host header for x-forwarded-port", () => {
    const req = mockReq({ headers: { host: "myapp.localhost:3000" } });
    const headers = buildForwardedHeaders(req);
    expect(headers["x-forwarded-port"]).toBe("3000");
  });
});
