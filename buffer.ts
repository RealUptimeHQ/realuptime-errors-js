import type { WireEvent } from "./types.ts";

/**
 * Bounded in-memory event buffer, modelled on apps/agent/buffer.ts: oldest
 * dropped when full, every drop counted, and the count is reported in the
 * next successful batch (`droppedClient` on the wire) so even client-side
 * drops reach the product's visible drop counters. In-memory only; an error
 * SDK that writes to the customer's filesystem is over the line.
 */

export const BUFFER_MAX = 200;

export class EventBuffer {
  private events: WireEvent[] = [];
  private droppedSinceReport = 0;

  push(event: WireEvent): void {
    if (this.events.length >= BUFFER_MAX) {
      this.events.shift();
      this.droppedSinceReport += 1;
    }
    this.events.push(event);
  }

  get length(): number {
    return this.events.length;
  }

  /** Reads up to `n` events without removing them; `commit(n)` removes them
   * only after the server acknowledged the batch, so a failed delivery
   * retries the same events instead of losing them. */
  peekBatch(n: number): WireEvent[] {
    return this.events.slice(0, n);
  }

  commit(n: number): void {
    this.events.splice(0, n);
  }

  /** The drop count to carry on the NEXT batch. Taken (reset to zero) only
   * when the caller is about to put it on the wire; if that delivery fails
   * the caller must give it back via `restoreDropped`. */
  takeDropped(): number {
    const n = this.droppedSinceReport;
    this.droppedSinceReport = 0;
    return n;
  }

  restoreDropped(n: number): void {
    this.droppedSinceReport += n;
  }
}
