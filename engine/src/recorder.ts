/**
 * Traffic Recorder — ring buffer for HTTP request/response capture.
 *
 * Lifecycle of a capture:
 *   1. `startCapture(req, host)` — called when a request arrives at the proxy
 *      Returns a capture ID for correlation
 *   2. `addRequestBodyChunk(id, chunk)` — called as request body streams in
 *   3. `finalize(id, req, host, status, headers, body)` — called when response
 *      is fully received. Emits a 'capture' event for the WebSocket API.
 *
 * The buffer holds up to `maxSize` entries (default 1000), dropping oldest first.
 * The EventEmitter lets the WebSocket API subscribe to real-time captures.
 *
 * NOT thread-safe — single-threaded Node.js event loop is assumed.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";

export interface CaptureEntry {
  id: string;
  timestamp: number;
  method: string;
  path: string;
  host: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  statusCode: number | null;
  responseHeaders: Record<string, string> | null;
  responseBody: string | null;
  duration: number | null; // milliseconds
}

export class TrafficRecorder {
  private buffer: CaptureEntry[] = [];
  private readonly maxSize: number;
  private activeCaptures = new Map<
    string,
    {
      startTime: number;
      bodyChunks: Buffer[];
    }
  >();
  private emitter = new EventEmitter();

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /** Start tracking a new proxied request. Returns a capture ID. */
  startCapture(_req: IncomingMessage, _host: string): string {
    const id = randomUUID();
    this.activeCaptures.set(id, {
      startTime: Date.now(),
      bodyChunks: [],
    });
    return id;
  }

  /** Accumulate a chunk of the request body. */
  addRequestBodyChunk(id: string, chunk: Buffer): void {
    const capture = this.activeCaptures.get(id);
    if (capture) {
      capture.bodyChunks.push(chunk);
    }
  }

  /**
   * Finalize a capture — called when both request and response are complete.
   * Stores the entry in the ring buffer and emits a 'capture' event.
   */
  finalize(
    id: string,
    req: IncomingMessage,
    host: string,
    statusCode: number | null,
    resHeaders: Record<string, string> | null,
    resBody: string | null
  ): void {
    const active = this.activeCaptures.get(id);
    if (!active) return;
    this.activeCaptures.delete(id);

    const duration = Date.now() - active.startTime;
    const reqBody = Buffer.concat(active.bodyChunks).toString("utf-8");

    const entry: CaptureEntry = {
      id,
      timestamp: active.startTime,
      method: req.method || "GET",
      path: req.url || "/",
      host,
      requestHeaders: (req.headers as Record<string, string>) || {},
      requestBody: reqBody,
      statusCode,
      responseHeaders: resHeaders,
      responseBody: resBody,
      duration,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }

    this.emitter.emit("capture", entry);
  }

  /** Get all buffered captures (most recent last). */
  getBuffer(): CaptureEntry[] {
    return [...this.buffer];
  }

  /** Get captures filtered by host. */
  getBufferForHost(host: string): CaptureEntry[] {
    return this.buffer.filter((e) => e.host === host);
  }

  /** Subscribe to new captures as they arrive. Returns unsubscribe function. */
  onCapture(cb: (entry: CaptureEntry) => void): () => void {
    this.emitter.on("capture", cb);
    return () => this.emitter.off("capture", cb);
  }

  /** Get a specific capture by ID for replay. */
  getCapture(id: string): CaptureEntry | undefined {
    return this.buffer.find((e) => e.id === id);
  }
}
