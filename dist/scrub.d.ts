import type { WireEvent } from "./types.ts";
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
export declare const SCRUBBED = "[scrubbed]";
/** Applies the five pattern rules to one string. Pure; exported so the
 * vector tests can drive it directly. */
export declare function scrubString(value: string): string;
/** Scrubs one event. Returns a new object; the input is never mutated (the
 * caller may still be holding it, e.g. inside an exception handler). */
export declare function scrubEvent(event: WireEvent, allowFields?: readonly string[]): WireEvent;
