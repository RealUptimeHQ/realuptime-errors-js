import { Transport } from "./client.ts";
import {
  closeReportDialog,
  createFeedbackTransport,
  type FeedbackOptions,
  type FeedbackTransport,
  feedbackEndpointFor,
  isEventId,
  isReportDialogOpen,
  mintEventId,
  openReportDialog,
  type ReportDialogHandle,
  type ReportDialogOptions,
} from "./feedback.ts";
import { scrubEvent } from "./scrub.ts";
export type { FeedbackOptions, ReportDialogField, ReportDialogHandle, ReportDialogOptions, ReportDialogTheme } from "./feedback.ts";
export type { WireEvent } from "./types.ts";
import {
  applyCustomScrubRules,
  type CompiledCustomScrubRules,
  compileCustomScrubRules,
  type CustomScrubRule,
  NO_CUSTOM_SCRUB_RULES,
  scrubRulesUrlFor,
} from "./custom-scrub.ts";
import {
  MAX_BREADCRUMB_DATA_ENTRIES,
  MAX_BREADCRUMBS_PER_EVENT,
  MAX_CONTEXT_ENTRIES,
  MAX_CONTEXT_KEY_LENGTH,
  MAX_FRAMES_PER_EVENT,
  MAX_MESSAGE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TAGS_PER_EVENT,
  type ErrorLevel,
  type WireBreadcrumb,
  type WireDevice,
  type WireEvent,
  type WireFrame,
  type WireRequest,
  type WireUser,
} from "./types.ts";

/**
 * @realuptime/errors: minimal JS/Node error tracking SDK, Phase 1
 * (the internal-docs repo's errors-plan.md). Captures unhandled exceptions and rejections plus
 * manual `captureException`/`captureMessage`, scrubs PII client-side by
 * default (scrub.ts), and posts to the project's DSN-style ingest endpoint.
 *
 * Contract with the host app, non-negotiable: THIS SDK NEVER THROWS. Every
 * public function catches everything; a broken SDK logs once and goes
 * quiet. An error tracker that crashes the app it watches is worse than
 * none.
 */

export const SDK_NAME = "realuptime-errors-js";
export const SDK_VERSION = "0.6.0"; // x-release-please-version
/** How long the one-time rules fetch may take before the SDK stops waiting
 * for it (it was never blocking capture anyway). */
export const SCRUB_RULES_TIMEOUT_MS = 5_000;

export interface ErrorsInit {
  /** The project's ingest URL, e.g.
   * `https://ingest.realuptime.io/api/errors/v1/ingest/rue_...`. Shown once at
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
  /** A last look at every event before it is queued: return the event to
   * send (the same object or a new one), or null to drop it. Runs AFTER the
   * default scrub and any additional scrub rules, so it sees exactly what
   * would otherwise leave and can only narrow it further. Fails closed: a
   * hook that throws drops the event (logged once) rather than letting it
   * through unfiltered, because a hook installed to remove data must never
   * turn into the reason that data leaves. */
  beforeSend?: (event: WireEvent) => WireEvent | null;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

interface SdkState {
  options: ErrorsInit;
  transport: Transport;
  uninstall: (() => void) | null;
  /** Bounded breadcrumb ring, newest last. */
  breadcrumbs: WireBreadcrumb[];
  /** How many breadcrumbs the ring has evicted since init: the count of
   * what the trail is not showing, reported on every event. */
  breadcrumbsEvicted: number;
  /** v2 scope (REA-182): sticky identity, tags and context, applied to
   * every subsequent event until changed. Bounded at write time so the
   * scope can never grow without limit in a long-lived process. */
  user: WireUser | null;
  tags: Record<string, string>;
  context: Record<string, string>;
  device: WireDevice | null;
  /** REA-264: the compiled additional rules, inline ones immediately and
   * the project's fetched ones once they arrive. */
  customScrub: CompiledCustomScrubRules;
  /** REA-257: non-null only when `options.feedback` was given. */
  feedback: { transport: FeedbackTransport; options: FeedbackOptions } | null;
  /** The id of the most recently captured event, when ids are minted. */
  lastEventId: string | null;
}

let state: SdkState | null = null;
let initFailureLogged = false;
let beforeSendFailureLogged = false;

function safeLog(message: string): void {
  try {
    (state?.options.log ?? console.error)(`[realuptime-errors] ${message}`);
  } catch {
    // Even logging must not throw.
  }
}

/** The ingest route's path shape: `/api/errors/v1/ingest/<key>`, an
 * optional trailing slash, nothing else. Mirrors the marker check in
 * feedback.ts/custom-scrub.ts and the stricter parse in sourcemaps.ts. */
const INGEST_PATH_RE = /^\/api\/errors\/v1\/ingest\/[^/?#]+\/?$/;

/**
 * REA-575: a `dsn` must be the full ingest URL the server hands out at
 * project creation, not the bare `rue_...` key alone. Before this check,
 * `init()` accepted any non-empty string and handed it straight to the
 * transport as the fetch endpoint: a bare key is not a fetchable URL, so
 * every send failed inside the transport's own never-throw try/catch and
 * the SDK silently reported nothing, forever, with no signal anywhere
 * (realuptime-web's own DSN held exactly this mistake in production).
 */
function isIngestUrl(dsn: string): boolean {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return INGEST_PATH_RE.test(url.pathname);
}

/**
 * Whether error reporting is actually on: `init()` was called with a dsn
 * that passed `isIngestUrl`. A host process should log this once at
 * startup (`realuptimeErrors.isEnabled()`) rather than assume that wiring
 * `init()` into the code means events are flowing -- REA-575 was exactly
 * that assumption, wrong for months because nothing checked it.
 */
export function isEnabled(): boolean {
  return state !== null;
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Parses a V8/JavaScriptCore/SpiderMonkey stack string into wire frames,
 * innermost first. Best-effort: an unparseable line is skipped, never
 * fatal. */
export function parseStack(stack: string | undefined): WireFrame[] | null {
  if (!stack) return null;
  const frames: WireFrame[] = [];
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    // V8: "at fn (file:line:col)" or "at file:line:col"
    let match = /^at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/.exec(trimmed);
    if (!match) {
      // Firefox/Safari: "fn@file:line:col"
      match = /^(.*?)@(.*?):(\d+):(\d+)$/.exec(trimmed);
    }
    if (!match) continue;
    const [, fn, file, lineNo, columnNo] = match;
    if (!file) continue;
    frames.push({
      file: clip(file, MAX_STRING_LENGTH),
      function: fn ? clip(fn, MAX_STRING_LENGTH) : null,
      line: Number.parseInt(lineNo, 10),
      // The column the runtime reported, kept for source-map symbolication
      // (Phase 3). Absence server-side is an honest "no_column" verdict.
      column: Number.parseInt(columnNo, 10),
      inApp: !file.includes("node_modules") && !file.startsWith("node:"),
    });
    if (frames.length >= MAX_FRAMES_PER_EVENT) break;
  }
  return frames.length > 0 ? frames : null;
}

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
  /** REA-569: severity for THIS event only. No sticky/init() equivalent --
   * see WireEvent.level's doc for why. */
  level?: ErrorLevel;
}

/** Bounds one caller-supplied string map: keys and values clipped, entries
 * past `max` dropped. Applied at WRITE time (setTag/setContext, and the
 * per-capture overrides) rather than at send time so the sticky scope of a
 * long-lived process is bounded by construction. */
function boundedMap(input: Record<string, unknown>, max: number, valueMax = MAX_STRING_LENGTH): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (Object.keys(out).length >= max) break;
    if (typeof value !== "string" || typeof name !== "string" || !name) continue;
    out[clip(name, MAX_CONTEXT_KEY_LENGTH)] = clip(value, valueMax);
  }
  return out;
}

/** Reads the runtime facts out of this process. Node only for now: a
 * browser's navigator.userAgent is a fingerprinting surface and a lie in
 * equal measure, so the browser build reports nothing rather than
 * something. Never throws; unknown fields are simply absent. */
function detectDevice(): WireDevice | null {
  try {
    const proc = (globalThis as { process?: { versions?: { node?: string }; platform?: string; arch?: string } }).process;
    if (!proc?.versions?.node) return null;
    const device: WireDevice = { runtime: "node", runtimeVersion: clip(proc.versions.node, MAX_STRING_LENGTH) };
    if (typeof proc.platform === "string") device.platform = clip(proc.platform, MAX_STRING_LENGTH);
    if (typeof proc.arch === "string") device.arch = clip(proc.arch, MAX_STRING_LENGTH);
    return device;
  } catch {
    return null;
  }
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
export function setUser(user: WireUser | null): void {
  try {
    if (!state) return;
    if (user === null || typeof user !== "object") {
      state.user = null;
      return;
    }
    const next: WireUser = {};
    if (typeof user.id === "string") next.id = clip(user.id, MAX_STRING_LENGTH);
    if (typeof user.email === "string") next.email = clip(user.email, MAX_STRING_LENGTH);
    if (typeof user.username === "string") next.username = clip(user.username, MAX_STRING_LENGTH);
    state.user = Object.keys(next).length > 0 ? next : null;
  } catch (failure) {
    safeLog(`setUser failed: ${String(failure)}`);
  }
}

/** v2: sets one sticky tag. A null/undefined value removes it. Tags past
 * MAX_TAGS_PER_EVENT are ignored rather than evicting an existing one --
 * silently replacing what the integrator set earlier would be the worse
 * surprise. Never throws. */
export function setTag(key: string, value: string | null | undefined): void {
  try {
    if (!state || typeof key !== "string" || !key) return;
    const name = clip(key, MAX_CONTEXT_KEY_LENGTH);
    if (value === null || value === undefined) {
      delete state.tags[name];
      return;
    }
    if (typeof value !== "string") return;
    if (!(name in state.tags) && Object.keys(state.tags).length >= MAX_TAGS_PER_EVENT) return;
    state.tags[name] = clip(value, MAX_STRING_LENGTH);
  } catch (failure) {
    safeLog(`setTag failed: ${String(failure)}`);
  }
}

/** v2: merges several sticky tags at once. Never throws. */
export function setTags(tags: Record<string, string>): void {
  try {
    if (!state || typeof tags !== "object" || tags === null) return;
    for (const [name, value] of Object.entries(tags)) setTag(name, value);
  } catch (failure) {
    safeLog(`setTags failed: ${String(failure)}`);
  }
}

/**
 * v2: sets one sticky custom-context entry, or merges a whole map.
 *
 *   setContext("tenant", "acme");
 *   setContext({ tenant: "acme", shard: "eu-1" });
 *
 * A null/undefined value removes the named entry; passing null as the only
 * argument clears the whole context. Never throws.
 */
export function setContext(keyOrMap: string | Record<string, string> | null, value?: string | null): void {
  try {
    if (!state) return;
    if (keyOrMap === null) {
      state.context = {};
      return;
    }
    if (typeof keyOrMap === "object") {
      const bounded = boundedMap(keyOrMap, MAX_CONTEXT_ENTRIES);
      for (const [name, entry] of Object.entries(bounded)) {
        if (!(name in state.context) && Object.keys(state.context).length >= MAX_CONTEXT_ENTRIES) break;
        state.context[name] = entry;
      }
      return;
    }
    if (typeof keyOrMap !== "string" || !keyOrMap) return;
    const name = clip(keyOrMap, MAX_CONTEXT_KEY_LENGTH);
    if (value === null || value === undefined) {
      delete state.context[name];
      return;
    }
    if (typeof value !== "string") return;
    if (!(name in state.context) && Object.keys(state.context).length >= MAX_CONTEXT_ENTRIES) return;
    state.context[name] = clip(value, MAX_STRING_LENGTH);
  } catch (failure) {
    safeLog(`setContext failed: ${String(failure)}`);
  }
}

function buildEvent(message: string, exceptionType: string | null, stack: string | undefined, context: CaptureContext): WireEvent {
  const options = state?.options;
  // v2 scope: the sticky values, with this capture's overrides merged over
  // the top. Emitted only when non-empty, so an integration that never
  // touches the v2 API keeps producing byte-identical v1 payloads.
  const tags = { ...(state?.tags ?? {}), ...boundedMap(context.tags ?? {}, MAX_TAGS_PER_EVENT) };
  const custom = { ...(state?.context ?? {}), ...boundedMap(context.context ?? {}, MAX_CONTEXT_ENTRIES) };
  const user =
    context.user === null
      ? null
      : context.user
        ? { ...(state?.user ?? {}), ...context.user }
        : (state?.user ?? null);
  return {
    occurredAt: new Date(state?.options.now?.() ?? Date.now()).toISOString(),
    message: clip(message, MAX_MESSAGE_LENGTH),
    exceptionType: exceptionType ? clip(exceptionType, MAX_STRING_LENGTH) : null,
    release: context.release ?? options?.release ?? null,
    environment: context.environment ?? options?.environment ?? null,
    frames: parseStack(stack),
    request: context.request ?? null,
    fingerprint: context.fingerprint ?? null,
    breadcrumbs: state && state.breadcrumbs.length > 0 ? [...state.breadcrumbs] : null,
    breadcrumbsDropped: state?.breadcrumbsEvicted ?? 0,
    ...(user ? { user } : {}),
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
    ...(Object.keys(custom).length > 0 ? { context: custom } : {}),
    ...(state?.device ? { device: state.device } : {}),
    // REA-257: minted only when feedback is enabled, so an integration that
    // never opted in keeps emitting the id-less payload it always did.
    ...(state?.feedback ? { eventId: mintEventId() } : {}),
    ...(context.level ? { level: context.level } : {}),
  };
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
export function addBreadcrumb(input: BreadcrumbInput): void {
  try {
    if (!state || typeof input?.message !== "string") return;
    let data: Record<string, string> | null = null;
    if (input.data) {
      data = {};
      for (const [name, value] of Object.entries(input.data).slice(0, MAX_BREADCRUMB_DATA_ENTRIES)) {
        if (typeof value === "string") data[clip(name, MAX_STRING_LENGTH)] = clip(value, MAX_STRING_LENGTH);
      }
    }
    state.breadcrumbs.push({
      timestamp: new Date(state.options.now?.() ?? Date.now()).toISOString(),
      category: input.category ? clip(input.category, 100) : null,
      message: clip(input.message, MAX_STRING_LENGTH),
      data,
    });
    if (state.breadcrumbs.length > MAX_BREADCRUMBS_PER_EVENT) {
      state.breadcrumbs.shift();
      state.breadcrumbsEvicted += 1;
    }
  } catch (failure) {
    safeLog(`addBreadcrumb failed: ${String(failure)}`);
  }
}

function capture(event: WireEvent): string | null {
  if (!state) return null;
  // Defaults first, always; the customer's additional rules on the result.
  const scrubbed = scrubEvent(event, state.options.allowFields ?? []);
  const outgoing = runBeforeSend(applyCustomScrubRules(scrubbed, state.customScrub), state.options.beforeSend);
  if (!outgoing) return null;
  state.transport.enqueue(outgoing);
  if (outgoing.eventId) state.lastEventId = outgoing.eventId;
  return outgoing.eventId ?? null;
}

/** Applies the integrator's `beforeSend`, failing closed: a throw or a
 * non-object result drops the event. */
function runBeforeSend(event: WireEvent, hook: ErrorsInit["beforeSend"]): WireEvent | null {
  if (typeof hook !== "function") return event;
  try {
    const result = hook(event);
    return result && typeof result === "object" ? result : null;
  } catch (failure) {
    if (!beforeSendFailureLogged) {
      beforeSendFailureLogged = true;
      safeLog(`beforeSend threw; the event was dropped: ${String(failure)}`);
    }
    return null;
  }
}

/** Fetches the project's additional scrub rules by ingest key and merges
 * them over the inline ones. Best-effort, bounded, never throws, never
 * blocks capture: an event sent before the response lands gets the
 * defaults plus inline rules here and the project's rules at ingest. */
async function fetchScrubRules(forState: SdkState): Promise<void> {
  try {
    const url = scrubRulesUrlFor(forState.options.dsn);
    if (!url) return;
    const fetchImpl = forState.options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    const response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(SCRUB_RULES_TIMEOUT_MS) });
    if (!response.ok) return;
    const body = (await response.json()) as { rules?: unknown };
    if (!Array.isArray(body?.rules)) return;
    // Init may have been called again while this was in flight; only the
    // state this fetch was started for is updated.
    if (state !== forState) return;
    forState.customScrub = compileCustomScrubRules([...(forState.options.scrubRules ?? []), ...body.rules]);
  } catch {
    // Fail open to the defaults. Silent by design: a transient fetch miss
    // is not the integrator's problem, and the server still applies them.
  }
}

/** Reports a thrown value. Non-Error values are stringified honestly rather
 * than wrapped in a fake stack.
 *
 * Returns the event's client id when feedback is enabled (REA-257), so the
 * caller can hand it to `showReportDialog({ eventId })`; null otherwise.
 * Additive: every pre-existing caller ignored the `void` this returned. */
export function captureException(error: unknown, context: CaptureContext = {}): string | null {
  try {
    if (!state) return null;
    if (error instanceof Error) {
      return capture(buildEvent(error.message || error.name, error.name || "Error", error.stack, context));
    }
    return capture(buildEvent(String(error), null, undefined, context));
  } catch (failure) {
    safeLog(`captureException failed: ${String(failure)}`);
    return null;
  }
}

export function captureMessage(message: string, context: CaptureContext = {}): string | null {
  try {
    if (!state) return null;
    return capture(buildEvent(message, null, undefined, context));
  } catch (failure) {
    safeLog(`captureMessage failed: ${String(failure)}`);
    return null;
  }
}

/** REA-257: the client id of the most recently captured event, or null
 * when none was captured yet or feedback is not enabled. */
export function lastEventId(): string | null {
  return state?.lastEventId ?? null;
}

/**
 * REA-257: opens the user feedback dialog for one event (default: the last
 * captured one). Browser only; returns null and logs once anywhere else,
 * when feedback was not enabled in `init`, when there is no event to attach
 * to, or when a dialog is already open. Never throws.
 *
 *   const eventId = captureException(err);
 *   showReportDialog({ eventId });
 */
export function showReportDialog(options: ReportDialogOptions = {}): ReportDialogHandle | null {
  try {
    if (!state) return null;
    if (!state.feedback) {
      safeLog("showReportDialog called but feedback is not enabled; pass init({ feedback: {} }) to turn it on.");
      return null;
    }
    const doc = (globalThis as { document?: Document }).document;
    if (!doc?.body) return null;
    const eventId = options.eventId ?? state.lastEventId;
    if (!isEventId(eventId)) {
      safeLog("showReportDialog: no event to attach to (capture one first, or pass eventId).");
      return null;
    }
    if (isReportDialogOpen()) return null;
    const { autoShow: _autoShow, ...standing } = state.feedback.options;
    const current = state;
    return openReportDialog(
      { ...standing, ...options, eventId },
      {
        document: doc,
        transport: state.feedback.transport,
        sdk: `${SDK_NAME}/${SDK_VERSION}`,
        beforeSend: () => current.transport.flush(),
        log: (message) => safeLog(message),
      },
    );
  } catch (failure) {
    safeLog(`showReportDialog failed: ${String(failure)}`);
    return null;
  }
}

function installUnhandledHandlers(): (() => void) | null {
  // Node first: process-level handlers see everything, including code that
  // runs before any window exists. A runtime that has BOTH a process object
  // and a DOM (an Electron renderer, a jsdom harness) is a page, and the
  // window handlers are the ones that see its errors (REA-257).
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  const hasDom = typeof (globalThis as { document?: Document }).document?.createElement === "function";
  if (!hasDom && proc && typeof proc.on === "function") {
    const onException = (error: unknown) => captureException(error);
    const onRejection = (reason: unknown) => captureException(reason);
    proc.on("uncaughtExceptionMonitor", onException);
    proc.on("unhandledRejection", onRejection);
    return () => {
      proc.removeListener("uncaughtExceptionMonitor", onException);
      proc.removeListener("unhandledRejection", onRejection);
    };
  }
  const win = globalThis as unknown as Window;
  if (typeof win.addEventListener === "function") {
    // REA-257: the opt-in auto-show. Only after an UNHANDLED browser
    // exception, only when the integrator asked, and only when the event
    // actually got an id (feedback enabled).
    const maybeShow = (eventId: string | null) => {
      if (eventId && state?.feedback?.options.autoShow) showReportDialog({ eventId });
    };
    const onError = (e: ErrorEvent) => maybeShow(captureException(e.error ?? e.message));
    const onRejection = (e: PromiseRejectionEvent) => maybeShow(captureException(e.reason));
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    return () => {
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
    };
  }
  return null;
}

/** Logs an init-time refusal through THIS call's own `log` option (falling
 * back to console.error), not through whatever a previous successful init
 * left in `state` -- state is intentionally untouched on a refused init, so
 * using `state?.options.log` here would mean a caller's own logger never
 * sees why its own call was refused. */
function logInitFailure(options: ErrorsInit | undefined, message: string): void {
  try {
    (options?.log ?? console.error)(`[realuptime-errors] ${message}`);
  } catch {
    // Even logging must not throw.
  }
}

/** Initializes the SDK. Safe to call more than once (the last call wins);
 * safe to call with a bad DSN (logs once, stays inert). */
export function init(options: ErrorsInit): void {
  try {
    if (!options?.dsn || typeof options.dsn !== "string") {
      if (!initFailureLogged) {
        initFailureLogged = true;
        logInitFailure(options, "init called without a dsn; error reporting is disabled.");
      }
      return;
    }
    if (!isIngestUrl(options.dsn)) {
      if (!initFailureLogged) {
        initFailureLogged = true;
        logInitFailure(
          options,
          "dsn must be the full ingest URL, got a bare key (or a malformed URL); expected https://<host>/api/errors/v1/ingest/<key>. Error reporting is disabled.",
        );
      }
      return;
    }
    close();
    state = {
      options,
      transport: new Transport({
        endpoint: options.dsn,
        sdk: `${SDK_NAME}/${SDK_VERSION}`,
        fetchImpl: options.fetchImpl,
        now: options.now,
        log: options.log,
      }),
      uninstall: null,
      breadcrumbs: [],
      breadcrumbsEvicted: 0,
      user: null,
      tags: {},
      context: {},
      device: options.sendDeviceInfo === false ? null : detectDevice(),
      customScrub: options.scrubRules ? compileCustomScrubRules(options.scrubRules) : NO_CUSTOM_SCRUB_RULES,
      feedback: null,
      lastEventId: null,
    };
    if (options.feedback && typeof options.feedback === "object") {
      const endpoint = feedbackEndpointFor(options.dsn);
      if (endpoint) {
        state.feedback = {
          options: options.feedback,
          transport: createFeedbackTransport({
            endpoint,
            sdk: `${SDK_NAME}/${SDK_VERSION}`,
            fetchImpl: options.fetchImpl,
            log: options.log,
          }),
        };
      } else {
        safeLog("feedback enabled but the dsn is not an ingest URL; feedback is disabled.");
      }
    }
    if (options.captureUnhandled !== false) {
      state.uninstall = installUnhandledHandlers();
    }
    if (options.fetchScrubRules !== false) void fetchScrubRules(state);
  } catch (failure) {
    safeLog(`init failed: ${String(failure)}`);
  }
}

/** Flushes buffered events; resolves when the attempt finishes. Never
 * rejects. */
export async function flush(): Promise<void> {
  try {
    await state?.transport.flush();
  } catch {
    // Never throws.
  }
}

/** Removes handlers and drops state. Mostly a test seam; a long-lived app
 * has no reason to call it. */
export function close(): void {
  try {
    state?.uninstall?.();
  } catch {
    // Never throws.
  }
  try {
    closeReportDialog();
  } catch {
    // Never throws.
  }
  state = null;
}
