import type { WireEvent } from "./types.ts";
/**
 * PII scrub-by-default, client-side (the internal-docs repo's errors-plan.md, "PII
 * scrub-by-default, specified"). Runs BEFORE serialization so the sensitive
 * value never transits realuptime's wire; the server runs the same rules
 * again as a second net (packages/db/error-scrub.ts), and the shared
 * vectors in scrub-vectors.json pin all implementations -- this one, the
 * Python SDK's, and the server's -- to byte-identical behavior.
 *
 * The rules, in the order they run over every scrubbed string:
 *
 *   0. URL userinfo credentials (`scheme://user:pass@host`, REA-474): the
 *      userinfo is replaced whole; the host stays readable. Runs first so a
 *      password that happens to look hex- or base64-shaped is not partially
 *      eaten by a later rule before the URL rule can see the whole userinfo.
 *   1. JWT three-dot shape (`eyJ...` header, two more base64url segments).
 *   2. Prefixed keys: sk_/pk_/rk_/ghp_/gho_/ghs_/xox?_/rua_/rue_/ru_live_/
 *      whsec_ (REA-474) followed by 8+ token characters.
 *   2b. AWS access-key ids (REA-474): AKIA/ASIA followed by exactly 16
 *      uppercase-alnum characters.
 *   3. Card-shaped digit runs: 13-19 digits, optional space/dash
 *      separators, passing Luhn. A digit run that fails Luhn is an order
 *      id, not a card, and stays.
 *   4. Long hex runs (32+).
 *   5. Long base64-ish runs (40+, no slash -- file paths stay readable).
 *
 * BEFORE any of the above, a KEY-NAME denylist pass (REA-474) runs over
 * every flat string map (tags, custom context, device, breadcrumb data,
 * stack-frame locals) and over request headers: a key whose name -- read as
 * whole snake_case/camelCase segments, so "tokenizer" and "authentic" do
 * NOT match "token" and "auth" -- is password, passwd, secret, token,
 * api_key/apikey, auth, authorization, credential(s), private_key,
 * access_key, or session, has its value replaced whole regardless of shape.
 * For headers this is folded into the existing REMOVED_HEADERS check (same
 * allowFields opt-back-in); for the other maps it is unconditional, the
 * same as the maps' key set itself.
 *
 * Scrubbed strings: the message, every request header value, the request
 * path and route, every breadcrumb message and breadcrumb data value
 * (Phase 3), any source-context lines a frame carries (a hardcoded secret
 * in source code must not ride a stack trace), and every v2 field a
 * customer can put their own bytes in -- the user id, every tag value,
 * every custom-context value, every device value, and every captured local
 * variable. NOT scrubbed: frame file paths, function names and line/column
 * numbers (they are the product), exceptionType, release, environment, and
 * tag/context KEYS (a key is a label the integrator chose, and scrubbing it
 * would make an issue's tag filter depend on whether the value beside it
 * happened to look like a card number).
 *
 * REMOVAL (value replaced whole) unless the field is allow-listed:
 *
 *   - Headers: Authorization, Proxy-Authorization, Cookie, Set-Cookie,
 *     case-insensitive, allow-listed by lowercased header name.
 *   - Identity (v2, REA-182): `user.email` and `user.username`, allow-listed
 *     by those exact dotted names. `user.id` is NOT removed: an opaque
 *     identifier in the customer's own key space is the field that makes
 *     "how many users hit this" answerable, and it is not contact data.
 *
 * `allowFields` opts a field back in BY NAME, per field and explicit in
 * code, never a global switch -- and an allowed field's value still passes
 * the pattern scrub, so opting one back in can never smuggle a raw token
 * through.
 */
export declare const SCRUBBED = "[scrubbed]";
/** Identity fields removed whole unless allow-listed by these exact names.
 * `user.id` is deliberately absent: see the module doc. */
export declare const REMOVED_USER_FIELDS: readonly ["user.email", "user.username"];
/** True when some contiguous run of a key's segments, joined with no
 * separator, equals a denylisted word exactly -- catches "api_key",
 * "apiKey" and "db_password" alike, without matching "tokenizer" or
 * "authentic". */
export declare function isKeyDenylisted(key: string): boolean;
/** Applies the five pattern rules to one string. Pure; exported so the
 * vector tests can drive it directly. */
export declare function scrubString(value: string): string;
/** Scrubs one event. Returns a new object; the input is never mutated (the
 * caller may still be holding it, e.g. inside an exception handler).
 *
 * v2 fields are touched only when PRESENT: a v1 event goes through here and
 * comes out with exactly the v1 key set it went in with, which is what
 * makes the vector table's v1 expectations still hold byte-for-byte. */
export declare function scrubEvent(event: WireEvent, allowFields?: readonly string[]): WireEvent;
