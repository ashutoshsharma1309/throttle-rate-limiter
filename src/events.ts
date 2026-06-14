import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for live check events, consumed by the dashboard's SSE
 * stream. Cross-cutting (like metrics): the limiter core never sees it; the
 * service publishes here after each decision. A small ring buffer lets a newly
 * connected dashboard backfill the recent past.
 */
export interface CheckEvent {
  ts: number;
  rule: string;
  identifier: string;
  allowed: boolean;
  remaining: number;
  limit: number;
  degraded?: boolean;
}

export class CheckEventBus extends EventEmitter {
  private readonly buffer: CheckEvent[] = [];

  constructor(private readonly maxBuffer = 100) {
    super();
    this.setMaxListeners(0); // many concurrent SSE subscribers are fine
  }

  publish(event: CheckEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    this.emit("check", event);
  }

  /** Last N events, for backfilling a freshly-connected dashboard. */
  recent(): CheckEvent[] {
    return this.buffer.slice();
  }
}
