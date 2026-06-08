import { describe, it, expect } from "bun:test";
import { TrafficRecorder } from "../recorder";
import type { IncomingMessage } from "node:http";

// ─── Mock helpers ────────────────────────────────────────────────────────────

function mockReq(overrides: Partial<Record<string, unknown>> = {}): IncomingMessage {
  return {
    headers: {},
    method: "GET",
    url: "/",
    ...overrides,
  } as IncomingMessage;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("TrafficRecorder", () => {
  describe("capture lifecycle", () => {
    it("creates a full capture entry", () => {
      const recorder = new TrafficRecorder(10);
      const req = mockReq({ method: "POST", url: "/api/data", headers: { "content-type": "application/json" } });
      const host = "myapp.localhost";

      const id = recorder.startCapture(req, host);
      recorder.addRequestBodyChunk(id, Buffer.from('{"hello":'));
      recorder.addRequestBodyChunk(id, Buffer.from('"world"}'));
      recorder.finalize(id, req, host, 200, { "content-type": "text/plain" }, "ok");

      const buffer = recorder.getBuffer();
      expect(buffer).toHaveLength(1);

      const entry = buffer[0];
      expect(entry.id).toBe(id);
      expect(entry.method).toBe("POST");
      expect(entry.path).toBe("/api/data");
      expect(entry.host).toBe("myapp.localhost");
      expect(entry.statusCode).toBe(200);
      expect(entry.requestBody).toBe('{"hello":"world"}');
      expect(entry.responseBody).toBe("ok");
      expect(entry.duration).toBeGreaterThanOrEqual(0);
      expect(entry.timestamp).toBeGreaterThan(0);
    });

    it("handles GET with no body chunks", () => {
      const recorder = new TrafficRecorder(10);
      const req = mockReq({ method: "GET", url: "/" });
      const host = "myapp.localhost";

      const id = recorder.startCapture(req, host);
      recorder.finalize(id, req, host, 302, null, null);

      const buffer = recorder.getBuffer();
      expect(buffer).toHaveLength(1);
      expect(buffer[0].requestBody).toBe("");
      expect(buffer[0].statusCode).toBe(302);
      expect(buffer[0].responseBody).toBeNull();
    });

    it("ignores finalize for unknown capture ID", () => {
      const recorder = new TrafficRecorder(10);
      const req = mockReq();
      recorder.finalize("nonexistent", req, "test", 200, {}, "ok");
      expect(recorder.getBuffer()).toHaveLength(0);
    });
  });

  describe("ring buffer capacity", () => {
    it("drops oldest entry when exceeding maxSize", () => {
      const recorder = new TrafficRecorder(3);

      function addCapture(method: string): void {
        const req = mockReq({ method, url: "/" });
        const id = recorder.startCapture(req, "test");
        recorder.finalize(id, req, "test", 200, {}, "");
      }

      addCapture("A");
      addCapture("B");
      addCapture("C");
      addCapture("D"); // should evict A

      const buffer = recorder.getBuffer();
      expect(buffer).toHaveLength(3);
      expect(buffer[0].method).toBe("B");
      expect(buffer[1].method).toBe("C");
      expect(buffer[2].method).toBe("D");
    });

    it("does not drop when at capacity exactly", () => {
      const recorder = new TrafficRecorder(2);
      function addCapture(method: string): void {
        const req = mockReq({ method, url: "/" });
        const id = recorder.startCapture(req, "test");
        recorder.finalize(id, req, "test", 200, {}, "");
      }

      addCapture("A");
      addCapture("B");

      expect(recorder.getBuffer()).toHaveLength(2);
    });
  });

  describe("event emission (onCapture)", () => {
    it("emits capture event on finalize", () => {
      const recorder = new TrafficRecorder(10);
      const captured: string[] = [];

      const unsub = recorder.onCapture((entry) => {
        captured.push(entry.host);
      });

      const req = mockReq({ method: "GET", url: "/" });
      const id = recorder.startCapture(req, "myapp.localhost");
      recorder.finalize(id, req, "myapp.localhost", 200, {}, "");

      expect(captured).toEqual(["myapp.localhost"]);
      unsub();
    });

    it("returns unsubscribe function that stops receiving events", () => {
      const recorder = new TrafficRecorder(10);
      let count = 0;

      const unsub = recorder.onCapture(() => count++);
      unsub();

      const req = mockReq({ method: "GET", url: "/" });
      const id = recorder.startCapture(req, "test");
      recorder.finalize(id, req, "test", 200, {}, "");

      expect(count).toBe(0);
    });

    it("supports multiple subscribers", () => {
      const recorder = new TrafficRecorder(10);
      let a = 0, b = 0;

      recorder.onCapture(() => a++);
      recorder.onCapture(() => b++);

      const req = mockReq({ method: "GET", url: "/" });
      const id = recorder.startCapture(req, "test");
      recorder.finalize(id, req, "test", 200, {}, "");

      expect(a).toBe(1);
      expect(b).toBe(1);
    });
  });

  describe("getBuffer / getBufferForHost / getCapture", () => {
    it("getBuffer returns a copy (not reference)", () => {
      const recorder = new TrafficRecorder(10);
      const req = mockReq({ method: "GET", url: "/" });
      const id = recorder.startCapture(req, "test");
      recorder.finalize(id, req, "test", 200, {}, "");

      const buffer = recorder.getBuffer();
      buffer.pop();
      expect(recorder.getBuffer()).toHaveLength(1);
    });

    it("getBufferForHost filters by hostname", () => {
      const recorder = new TrafficRecorder(10);

      function add(host: string): void {
        const req = mockReq({ method: "GET", url: "/" });
        const id = recorder.startCapture(req, host);
        recorder.finalize(id, req, host, 200, {}, "");
      }

      add("myapp.localhost");
      add("api.localhost");
      add("myapp.localhost");

      expect(recorder.getBufferForHost("myapp.localhost")).toHaveLength(2);
      expect(recorder.getBufferForHost("api.localhost")).toHaveLength(1);
      expect(recorder.getBufferForHost("unknown.localhost")).toHaveLength(0);
    });

    it("getCapture retrieves by ID", () => {
      const recorder = new TrafficRecorder(10);
      const req = mockReq({ method: "GET", url: "/" });
      const id = recorder.startCapture(req, "test");
      recorder.finalize(id, req, "test", 200, {}, "");

      const found = recorder.getCapture(id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(id);
    });

    it("getCapture returns undefined for unknown ID", () => {
      const recorder = new TrafficRecorder(10);
      expect(recorder.getCapture("nope")).toBeUndefined();
    });
  });
});
