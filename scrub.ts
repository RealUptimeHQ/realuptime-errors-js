import type { WireBreadcrumb, WireEvent, WireRequest } from "./types.ts";

/**
 * PII scrub-by-default, client-side (docs/errors-plan.md, "PII
 * scrub-by-default, specified"). Runs BEFORE serialization so the sensitive
 * value never transits realuptime's wire; the server runs the same rules
 * again as a second net (packages/db/error-scrub.ts), and the shared
 * vectors in scrub-vectors.json pin all implementations -- this one, the
 * Python SDK's, and the server's -- to byte-identical behavior.
 *
 * The rules, in the order they run over every scrubbed string:
 *
 *   1. JWT three-dot shape (`eyJ...` header, two more base64url segments).
 *   2. Prefixed keys: sk_/pk_/rk_/ghp_/gho_/ghs_/xox?_/rua_/rue_/ru_live_
 *      followed by 8+ token characters.
 *   3. Card-shaped digit runs: 13-19 digits, optional space/dash
 *      separators, passing Luhn. A digit run that fails Luhn is an order
 *      id, not a card, and stays.
 *   4. Long hex runs (32+).
 *   5. Long base64-ish runs (40+, no slash -- file paths stay readable).
 *
 * Scrubbed strings: the message, every request header value, the request
 * path, every breadcrumb message and breadcrumb data value (Phase 3), and
 * any source-context lines a frame carries (a hardcoded secret in source
 * code must not ride a stack trace). NOT scrubbed: frame file paths,
 * function names and line/column numbers (they are the product),
 * exceptionType, release, environment.
 *
 * Header REMOVAL (value replaced whole): Authorization,
 * Proxy-Authorization, Cookie, Set-Cookie, case-insensitive.
 * `allowFields` opts a header back in BY LOWERCASED NAME, per field and
 * explicit in code, never a global switch -- and an allowed field's value
 * still passes the pattern scrub, so opting a header back in can never
 * smuggle a raw token through.
 */

export const SCRUBBED = "[scrubbed]";

/** Headers whose value is removed whole unless the field is allow-listed. */
const REMOVED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const PREFIXED_KEY_RE = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[a-z]|rua|rue|ru_live)_[A-Za-z0-9_-]{8,}/g;
const CARD_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64_RE = /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_-]{40,}={0,2}/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Applies the five pattern rules to one string. Pure; exported so the
 * vector tests can drive it directly. */
export function scrubString(value: string): string {
  let out = value.replace(JWT_RE, SCRUBBED);
  out = out.replace(PREFIXED_KEY_RE, SCRUBBED);
  out = out.replace(CARD_RE, (run) => {
    const digits = run.replace(/[ -]/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? SCRUBBED : run;
  });
  out = out.replace(HEX_RE, SCRUBBED);
  out = out.replace(BASE64_RE, SCRUBBED);
  return out;
}

function scrubRequest(request: WireRequest, allowFields: ReadonlySet<string>): WireRequest {
  const out: WireRequest = { ...request };
  if (typeof out.path === "string") out.path = scrubString(out.path);
  if (out.headers) {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(out.headers)) {
      const lower = name.toLowerCase();
      if (REMOVED_HEADERS.has(lower) && !allowFields.has(lower)) {
        headers[name] = SCRUBBED;
      } else {
        headers[name] = scrubString(value);
      }
    }
    out.headers = headers;
  }
  return out;
}

function scrubBreadcrumb(crumb: WireBreadcrumb): WireBreadcrumb {
  let data: Record<string, string> | null = null;
  if (crumb.data) {
    data = {};
    for (const [name, value] of Object.entries(crumb.data)) data[name] = scrubString(value);
  }
  return { ...crumb, message: scrubString(crumb.message), data };
}

/** Scrubs one event. Returns a new object; the input is never mutated (the
 * caller may still be holding it, e.g. inside an exception handler). */
export function scrubEvent(event: WireEvent, allowFields: readonly string[] = []): WireEvent {
  const allowed = new Set(allowFields.map((f) => f.toLowerCase()));
  return {
    ...event,
    message: scrubString(event.message),
    request: event.request ? scrubRequest(event.request, allowed) : event.request,
    breadcrumbs: event.breadcrumbs ? event.breadcrumbs.map(scrubBreadcrumb) : event.breadcrumbs,
    frames: event.frames
      ? event.frames.map((frame) =>
          frame.contextLine != null || frame.preContext?.length || frame.postContext?.length
            ? {
                ...frame,
                ...(frame.contextLine != null ? { contextLine: scrubString(frame.contextLine) } : {}),
                ...(frame.preContext ? { preContext: frame.preContext.map(scrubString) } : {}),
                ...(frame.postContext ? { postContext: frame.postContext.map(scrubString) } : {}),
              }
            : frame,
        )
      : event.frames,
  };
}
