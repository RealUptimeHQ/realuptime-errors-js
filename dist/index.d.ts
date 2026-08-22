import { type WireFrame, type WireRequest } from "./types.ts";
/**
 * @realuptime/errors: minimal JS/Node error tracking SDK, Phase 1
 * (docs/errors-plan.md). Captures unhandled exceptions and rejections plus
 * manual `captureException`/`captureMessage`, scrubs PII client-side by
 * default (scrub.ts), and posts to the project's DSN-style ingest endpoint.
 *
 * Contract with the host app, non-negotiable: THIS SDK NEVER THROWS. Every
 * public function catches everything; a broken SDK logs once and goes
 * quiet. An error tracker that crashes the app it watches is worse than
 * none.
 */
export declare const SDK_NAME = "realuptime-errors-js";
export declare const SDK_VERSION = "0.2.0";
export interface ErrorsInit {
    /** The project's ingest URL, e.g.
     * `https://realuptime.io/api/errors/v1/ingest/rue_...`. Shown once at
     * project creation; safe to embed client-side (it can only submit events
     * to its one project). */
    dsn: string;
    release?: string;
    environment?: string;
    /** Per-field scrub opt-back-in, lowercased header/field names. Never a
     * global off switch, by design. */
    allowFields?: string[];
    /** Install process/window handlers for uncaught errors. Default true. */
    captureUnhandled?: boolean;
    /** Test seams. */
    fetchImpl?: typeof fetch;
    now?: () => number;
    log?: (message: string) => void;
}
/** Parses a V8/JavaScriptCore/SpiderMonkey stack string into wire frames,
 * innermost first. Best-effort: an unparseable line is skipped, never
 * fatal. */
export declare function parseStack(stack: string | undefined): WireFrame[] | null;
export interface CaptureContext {
    request?: WireRequest;
    fingerprint?: string[];
    release?: string;
    environment?: string;
}
export interface BreadcrumbInput {
    message: string;
    category?: string;
    /** Short string values only; scrubbed like every other captured string. */
    data?: Record<string, string>;
}
/**
 * Records one breadcrumb onto the bounded trail (Phase 3). The trail rides
 * the NEXT captured event, newest last, at most MAX_BREADCRUMBS_PER_EVENT;
 * older entries are evicted and the eviction COUNT rides the event too
 * (`breadcrumbsDropped`), so a truncated trail is never presented as the
 * whole story. Never throws.
 */
export declare function addBreadcrumb(input: BreadcrumbInput): void;
/** Reports a thrown value. Non-Error values are stringified honestly rather
 * than wrapped in a fake stack. */
export declare function captureException(error: unknown, context?: CaptureContext): void;
export declare function captureMessage(message: string, context?: CaptureContext): void;
/** Initializes the SDK. Safe to call more than once (the last call wins);
 * safe to call with a bad DSN (logs once, stays inert). */
export declare function init(options: ErrorsInit): void;
/** Flushes buffered events; resolves when the attempt finishes. Never
 * rejects. */
export declare function flush(): Promise<void>;
/** Removes handlers and drops state. Mostly a test seam; a long-lived app
 * has no reason to call it. */
export declare function close(): void;
