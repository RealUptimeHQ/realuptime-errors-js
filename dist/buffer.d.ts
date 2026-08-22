import type { WireEvent } from "./types.ts";
/**
 * Bounded in-memory event buffer, modelled on apps/agent/buffer.ts: oldest
 * dropped when full, every drop counted, and the count is reported in the
 * next successful batch (`droppedClient` on the wire) so even client-side
 * drops reach the product's visible drop counters. In-memory only; an error
 * SDK that writes to the customer's filesystem is over the line.
 */
export declare const BUFFER_MAX = 200;
export declare class EventBuffer {
    private events;
    private droppedSinceReport;
    push(event: WireEvent): void;
    get length(): number;
    /** Reads up to `n` events without removing them; `commit(n)` removes them
     * only after the server acknowledged the batch, so a failed delivery
     * retries the same events instead of losing them. */
    peekBatch(n: number): WireEvent[];
    commit(n: number): void;
    /** The drop count to carry on the NEXT batch. Taken (reset to zero) only
     * when the caller is about to put it on the wire; if that delivery fails
     * the caller must give it back via `restoreDropped`. */
    takeDropped(): number;
    restoreDropped(n: number): void;
}
