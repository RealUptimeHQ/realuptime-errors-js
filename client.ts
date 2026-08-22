import { EventBuffer } from "./buffer.ts";
import { MAX_EVENTS_PER_BATCH, type WireBatch, type WireEvent, type WireIngestResult } from "./types.ts";

/**
 * Delivery: batched, buffered, backed off, and incapable of crashing the
 * host app (docs/errors-plan.md, "The SDKs"). Disciplines inherited from
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

export const SEND_TIMEOUT_MS = 10_000;
export const BACKOFF_START_MS = 5_000;
export const BACKOFF_MAX_MS = 300_000;

export interface TransportOptions {
  endpoint: string;
  sdk: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface RefusalBody {
  error?: string;
  reason?: string;
  resetsAt?: string;
}

export class Transport {
  private readonly buffer = new EventBuffer();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private backoffMs = 0;
  private nextAttemptAt = 0;
  private pausedUntil = 0;
  private disabled = false;
  private loggedKinds = new Set<string>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly options: TransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
  }

  enqueue(event: WireEvent): void {
    if (this.disabled) return;
    this.buffer.push(event);
    void this.flush();
  }

  /** Sends what is due. Serialized: one delivery in flight at a time, so a
   * burst of captures becomes one batch, not a request per event. */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.deliver().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private logOnce(kind: string, message: string): void {
    if (this.loggedKinds.has(kind)) return;
    this.loggedKinds.add(kind);
    this.log(`[realuptime-errors] ${message}`);
  }

  private async deliver(): Promise<void> {
    while (this.buffer.length > 0) {
      const now = this.now();
      if (this.disabled || now < this.nextAttemptAt || now < this.pausedUntil) return;

      const events = this.buffer.peekBatch(MAX_EVENTS_PER_BATCH);
      const droppedClient = this.buffer.takeDropped();
      const batch: WireBatch = { sdk: this.options.sdk, droppedClient, events };

      let response: Response;
      try {
        response = await this.fetchImpl(this.options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch {
        this.buffer.restoreDropped(droppedClient);
        this.backOff("network", "cannot reach the ingest endpoint; buffering and retrying");
        return;
      }

      if (response.ok) {
        this.buffer.commit(events.length);
        this.backoffMs = 0;
        this.nextAttemptAt = 0;
        let body: WireIngestResult | null = null;
        try {
          body = (await response.json()) as WireIngestResult;
        } catch {
          body = null;
        }
        if (body?.overQuota) {
          this.pauseUntil(body.quota?.resetsAt);
          this.logOnce(
            "over-quota",
            `monthly event quota reached (${body.quota?.limit ?? "?"}); pausing until ${body.quota?.resetsAt ?? "the window resets"}. Dropped events are counted and shown on your realuptime Errors dashboard.`,
          );
          return;
        }
        continue;
      }

      let refusal: RefusalBody = {};
      try {
        refusal = (await response.json()) as RefusalBody;
      } catch {
        refusal = {};
      }

      if (response.status === 403 && refusal.reason === "key_revoked") {
        this.disabled = true;
        this.logOnce(
          "revoked",
          "this project's ingest key was revoked; error reporting is disabled for this process. Rotate the key in realuptime Errors settings and redeploy with the new DSN.",
        );
        return;
      }
      if (response.status === 429 && refusal.reason === "over_quota") {
        // The whole batch was refused at the cap: nothing was written, and
        // holding the events would only re-refuse them all window long.
        this.buffer.commit(events.length);
        this.pauseUntil(refusal.resetsAt);
        this.logOnce(
          "over-quota",
          `monthly event quota reached; pausing until ${refusal.resetsAt ?? "the window resets"}. Dropped events are counted and shown on your realuptime Errors dashboard.`,
        );
        return;
      }
      if (response.status === 400) {
        // A malformed batch will never become well-formed by retrying; drop
        // it rather than wedging the buffer, and say so once.
        this.buffer.commit(events.length);
        this.buffer.restoreDropped(droppedClient);
        this.logOnce("malformed", `the server refused a batch as malformed: ${refusal.error ?? "no detail"}. This is an SDK bug worth reporting.`);
        continue;
      }

      this.buffer.restoreDropped(droppedClient);
      this.backOff("transient", `ingest endpoint answered ${response.status}; buffering and retrying`);
      return;
    }
  }

  private pauseUntil(resetsAt: string | undefined): void {
    const parsed = resetsAt ? Date.parse(resetsAt) : Number.NaN;
    // A missing or unparseable reset instant still pauses meaningfully: an
    // hour is long enough to stop the burn, short enough to recover early
    // in a new window.
    this.pausedUntil = Number.isFinite(parsed) ? parsed : this.now() + 60 * 60_000;
  }

  private backOff(kind: string, message: string): void {
    this.backoffMs = this.backoffMs <= 0 ? BACKOFF_START_MS : Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.nextAttemptAt = this.now() + this.backoffMs;
    this.logOnce(kind, `${message} (backing off).`);
  }
}
