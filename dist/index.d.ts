import { type FeedbackOptions, type ReportDialogHandle, type ReportDialogOptions } from "./feedback.ts";
export type { FeedbackOptions, ReportDialogField, ReportDialogHandle, ReportDialogOptions, ReportDialogTheme } from "./feedback.ts";
import { type CustomScrubRule } from "./custom-scrub.ts";
import { type WireFrame, type WireRequest, type WireUser } from "./types.ts";
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
export declare const SDK_VERSION = "0.4.0";
/** How long the one-time rules fetch may take before the SDK stops waiting
 * for it (it was never blocking capture anyway). */
export declare const SCRUB_RULES_TIMEOUT_MS = 5000;
export interface ErrorsInit {
    /** The project's ingest URL, e.g.
     * `https://realuptime.io/api/errors/v1/ingest/rue_...`. Shown once at
     * project creation; safe to embed client-side (it can only submit events
     * to its one project). */
    dsn: string;
    release?: string;
    environment?: string;
    /** Per-field scrub opt-back-in, lowercased header/field names (v2 adds
     * the dotted identity names `user.email` and `user.username`). Never a
     * global off switch, by design. */
    allowFields?: string[];
    /** REA-264: ADDITIONAL scrub rules for this process, applied after the
     * default scrub on top of whatever the project's settings define. Each is
     * `{ kind: "field_name" | "key_glob" | "value_regex", pattern }`; an
     * invalid one is skipped. There is no option that relaxes a default. */
    scrubRules?: CustomScrubRule[];
    /** REA-264: fetch the project's additional scrub rules (set in realuptime
     * Errors settings) once at init and apply them client-side too. Default
     * true. Fails open to the defaults: a slow or unreachable fetch never
     * delays or drops an event, and the server applies the same rules at
     * ingest regardless. Set false to skip the request (e.g. in tests). */
    fetchScrubRules?: boolean;
    /** v2: report the runtime and platform this process runs on
     * (`device.runtime` / `runtimeVersion` / `platform` / `arch`). Default
     * true: these are facts about OUR customer's own server, not about their
     * users, and "which Node version does this only happen on" is a question
     * worth one line of payload. Set false to send nothing.
     *
     * Never includes hostname, local IP or container id. See WireDevice. */
    sendDeviceInfo?: boolean;
    /** Install process/window handlers for uncaught errors. Default true. */
    captureUnhandled?: boolean;
    /** REA-257: user feedback (the "what happened?" dialog). OFF unless this
     * object is present; its presence is the opt-in. When set, every event
     * carries a client-minted `eventId` so a report can attach to it, and
     * `showReportDialog()` works. `autoShow: true` additionally opens the
     * dialog after an unhandled browser exception. The project's feedback
     * switch in realuptime Errors settings must ALSO be on, or the endpoint
     * refuses with `reason: "feedback_disabled"`. See feedback.ts. */
    feedback?: FeedbackOptions;
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
    /** v2: identity for THIS event only, merged over the sticky scope. */
    user?: WireUser | null;
    /** v2: tags for THIS event only, merged over the sticky scope. */
    tags?: Record<string, string>;
    /** v2: custom context for THIS event only, merged over the sticky scope. */
    context?: Record<string, string>;
}
/**
 * v2 (REA-182): sets the sticky identity applied to every subsequent event.
 * `null` clears it (sign-out).
 *
 * Only `id`, `email` and `username` are carried; anything else on the object
 * is ignored rather than forwarded, so a caller who hands us their whole
 * user record does not accidentally ship its address book. `email` and
 * `username` are `[scrubbed]` before serialization unless the matching
 * `allowFields` entry is set. Never throws.
 */
export declare function setUser(user: WireUser | null): void;
/** v2: sets one sticky tag. A null/undefined value removes it. Tags past
 * MAX_TAGS_PER_EVENT are ignored rather than evicting an existing one --
 * silently replacing what the integrator set earlier would be the worse
 * surprise. Never throws. */
export declare function setTag(key: string, value: string | null | undefined): void;
/** v2: merges several sticky tags at once. Never throws. */
export declare function setTags(tags: Record<string, string>): void;
/**
 * v2: sets one sticky custom-context entry, or merges a whole map.
 *
 *   setContext("tenant", "acme");
 *   setContext({ tenant: "acme", shard: "eu-1" });
 *
 * A null/undefined value removes the named entry; passing null as the only
 * argument clears the whole context. Never throws.
 */
export declare function setContext(keyOrMap: string | Record<string, string> | null, value?: string | null): void;
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
 * than wrapped in a fake stack.
 *
 * Returns the event's client id when feedback is enabled (REA-257), so the
 * caller can hand it to `showReportDialog({ eventId })`; null otherwise.
 * Additive: every pre-existing caller ignored the `void` this returned. */
export declare function captureException(error: unknown, context?: CaptureContext): string | null;
export declare function captureMessage(message: string, context?: CaptureContext): string | null;
/** REA-257: the client id of the most recently captured event, or null
 * when none was captured yet or feedback is not enabled. */
export declare function lastEventId(): string | null;
/**
 * REA-257: opens the user feedback dialog for one event (default: the last
 * captured one). Browser only; returns null and logs once anywhere else,
 * when feedback was not enabled in `init`, when there is no event to attach
 * to, or when a dialog is already open. Never throws.
 *
 *   const eventId = captureException(err);
 *   showReportDialog({ eventId });
 */
export declare function showReportDialog(options?: ReportDialogOptions): ReportDialogHandle | null;
/** Initializes the SDK. Safe to call more than once (the last call wins);
 * safe to call with a bad DSN (logs once, stays inert). */
export declare function init(options: ErrorsInit): void;
/** Flushes buffered events; resolves when the attempt finishes. Never
 * rejects. */
export declare function flush(): Promise<void>;
/** Removes handlers and drops state. Mostly a test seam; a long-lived app
 * has no reason to call it. */
export declare function close(): void;
