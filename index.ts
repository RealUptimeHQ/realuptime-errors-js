import { Transport } from "./client.ts";
import { scrubEvent } from "./scrub.ts";
import {
  MAX_BREADCRUMB_DATA_ENTRIES,
  MAX_BREADCRUMBS_PER_EVENT,
  MAX_FRAMES_PER_EVENT,
  MAX_MESSAGE_LENGTH,
  MAX_STRING_LENGTH,
  type WireBreadcrumb,
  type WireEvent,
  type WireFrame,
  type WireRequest,
} from "./types.ts";

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

export const SDK_NAME = "realuptime-errors-js";
export const SDK_VERSION = "0.2.0";

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

interface SdkState {
  options: ErrorsInit;
  transport: Transport;
  uninstall: (() => void) | null;
  /** Bounded breadcrumb ring, newest last. */
  breadcrumbs: WireBreadcrumb[];
  /** How many breadcrumbs the ring has evicted since init: the count of
   * what the trail is not showing, reported on every event. */
  breadcrumbsEvicted: number;
}

let state: SdkState | null = null;
let initFailureLogged = false;

function safeLog(message: string): void {
  try {
    (state?.options.log ?? console.error)(`[realuptime-errors] ${message}`);
  } catch {
    // Even logging must not throw.
  }
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
}

function buildEvent(message: string, exceptionType: string | null, stack: string | undefined, context: CaptureContext): WireEvent {
  const options = state?.options;
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

function capture(event: WireEvent): void {
  if (!state) return;
  state.transport.enqueue(scrubEvent(event, state.options.allowFields ?? []));
}

/** Reports a thrown value. Non-Error values are stringified honestly rather
 * than wrapped in a fake stack. */
export function captureException(error: unknown, context: CaptureContext = {}): void {
  try {
    if (!state) return;
    if (error instanceof Error) {
      capture(buildEvent(error.message || error.name, error.name || "Error", error.stack, context));
    } else {
      capture(buildEvent(String(error), null, undefined, context));
    }
  } catch (failure) {
    safeLog(`captureException failed: ${String(failure)}`);
  }
}

export function captureMessage(message: string, context: CaptureContext = {}): void {
  try {
    if (!state) return;
    capture(buildEvent(message, null, undefined, context));
  } catch (failure) {
    safeLog(`captureMessage failed: ${String(failure)}`);
  }
}

function installUnhandledHandlers(): (() => void) | null {
  // Node first: process-level handlers see everything, including code that
  // runs before any window exists.
  const proc = (globalThis as { process?: NodeJS.Process }).process;
  if (proc && typeof proc.on === "function") {
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
    const onError = (e: ErrorEvent) => captureException(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => captureException(e.reason);
    win.addEventListener("error", onError);
    win.addEventListener("unhandledrejection", onRejection);
    return () => {
      win.removeEventListener("error", onError);
      win.removeEventListener("unhandledrejection", onRejection);
    };
  }
  return null;
}

/** Initializes the SDK. Safe to call more than once (the last call wins);
 * safe to call with a bad DSN (logs once, stays inert). */
export function init(options: ErrorsInit): void {
  try {
    if (!options?.dsn || typeof options.dsn !== "string") {
      if (!initFailureLogged) {
        initFailureLogged = true;
        safeLog("init called without a dsn; error reporting is disabled.");
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
    };
    if (options.captureUnhandled !== false) {
      state.uninstall = installUnhandledHandlers();
    }
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
  state = null;
}
