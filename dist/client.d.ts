import { type WireEvent } from "./types.ts";
/**
 * Delivery: batched, buffered, backed off, and incapable of crashing the
 * host app (the internal-docs repo's errors-plan.md, "The SDKs"). Disciplines inherited from
 * apps/agent/api.ts and runtime.ts:
 *
 *   - Failures never throw out of the SDK. Everything is caught; the first
 *     failure of each kind logs ONCE and further ones are silent, because
 *     an error tracker that floods the console is nearly as bad as one that
 *     throws.
 *   - Transient failures (network, 5xx, unparseable body) back off
 *     exponentially and the events stay buffered.
 *   - `over_quota` responses stop delivery until the reset instant the
 *     server names. Retrying into a hard cap burns the customer's cycles
 *     and our ingest budget for nothing; the drop already happened and is
 *     already counted server-side.
 *   - `key_revoked` (403) disables the SDK for the process lifetime after
 *     one log line naming the fix. A revoked key never becomes an event
 *     black hole or a retry storm.
 *   - `rate_limited` (429) is transient: back off and keep the events.
 */
export declare const SEND_TIMEOUT_MS = 10000;
export declare const BACKOFF_START_MS = 5000;
export declare const BACKOFF_MAX_MS = 300000;
export interface TransportOptions {
    endpoint: string;
    sdk: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: (message: string) => void;
}
export declare class Transport {
    private readonly buffer;
    private readonly fetchImpl;
    private readonly now;
    private readonly log;
    private backoffMs;
    private nextAttemptAt;
    private pausedUntil;
    private disabled;
    private loggedKinds;
    private inFlight;
    private readonly options;
    constructor(options: TransportOptions);
    enqueue(event: WireEvent): void;
    /** Sends what is due. Serialized: one delivery in flight at a time, so a
     * burst of captures becomes one batch, not a request per event. */
    flush(): Promise<void>;
    private logOnce;
    private deliver;
    private pauseUntil;
    private backOff;
}
