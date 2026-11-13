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
export const SCRUBBED = "[scrubbed]";
/** Headers whose value is removed whole unless the field is allow-listed. */
const REMOVED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
/** Identity fields removed whole unless allow-listed by these exact names.
 * `user.id` is deliberately absent: see the module doc. */
export const REMOVED_USER_FIELDS = ["user.email", "user.username"];
const URL_CREDS_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}):\/\/[^\s/@:]+:[^\s/@]+@/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const PREFIXED_KEY_RE = /\b(?:sk|pk|rk|ghp|gho|ghs|xox[a-z]|rua|rue|ru_live|whsec)_[A-Za-z0-9_-]{8,}/g;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const CARD_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g;
const BASE64_RE = /(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_-]{40,}={0,2}/g;
// name=value pairs in free text, paths and query strings (REA-1260): the
// value is scrubbed when the name hits the key-name denylist. No spaces
// around "=", so "token = x" in prose is not a pair. Linear time: the name
// is bounded and the value class excludes every delimiter, and "[scrubbed]"
// is itself a valid value, so scrubbing twice changes nothing.
const KEY_VALUE_RE = /([A-Za-z0-9_.[\]-]{1,64})=([^&#;,"'<>\s]+)/g;
/** Key-name denylist (REA-474): normalized (lowercased, separator-joined)
 * segments that mark a field as sensitive by name alone, regardless of what
 * its value looks like. Kept as single normalized words/compounds so a
 * whole-segment match never fires on a substring -- "tokenizer" is one
 * segment, "tokenizer", not "token" plus a suffix. */
const KEY_DENYLIST = new Set([
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "auth",
    "authorization",
    "credential",
    "credentials",
    "privatekey",
    "accesskey",
    "session",
    // REA-1260: names that carry credentials in query strings and form text.
    "pw",
    "pwd",
    "passphrase",
    "sig",
    "signature",
    "sid",
    "otp",
]);
/** Splits a key into lowercase segments on camelCase boundaries and any
 * non-alphanumeric separator (snake_case, kebab-case, dotted). */
function keySegments(key) {
    return key
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((s) => s.toLowerCase());
}
/** True when some contiguous run of a key's segments, joined with no
 * separator, equals a denylisted word exactly -- catches "api_key",
 * "apiKey" and "db_password" alike, without matching "tokenizer" or
 * "authentic". */
export function isKeyDenylisted(key) {
    const segments = keySegments(key);
    for (let i = 0; i < segments.length; i++) {
        let joined = "";
        for (let j = i; j < segments.length; j++) {
            joined += segments[j];
            if (KEY_DENYLIST.has(joined))
                return true;
        }
    }
    return false;
}
function luhnValid(digits) {
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = digits.charCodeAt(i) - 48;
        if (double) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}
/** Applies the five pattern rules to one string. Pure; exported so the
 * vector tests can drive it directly. */
export function scrubString(value) {
    let out = value.replace(URL_CREDS_RE, (_match, scheme) => `${scheme}://${SCRUBBED}@`);
    out = out.replace(JWT_RE, SCRUBBED);
    out = out.replace(PREFIXED_KEY_RE, SCRUBBED);
    out = out.replace(AWS_KEY_RE, SCRUBBED);
    out = out.replace(CARD_RE, (run) => {
        const digits = run.replace(/[ -]/g, "");
        return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? SCRUBBED : run;
    });
    out = out.replace(HEX_RE, SCRUBBED);
    out = out.replace(BASE64_RE, SCRUBBED);
    out = out.replace(KEY_VALUE_RE, (pair, key) => isKeyDenylisted(key) ? `${key}=${SCRUBBED}` : pair);
    return out;
}
function scrubRequest(request, allowFields) {
    const out = { ...request };
    if (typeof out.path === "string")
        out.path = scrubString(out.path);
    if (typeof out.route === "string")
        out.route = scrubString(out.route);
    if (out.headers) {
        const headers = {};
        for (const [name, value] of Object.entries(out.headers)) {
            const lower = name.toLowerCase();
            if ((REMOVED_HEADERS.has(lower) || isKeyDenylisted(lower)) && !allowFields.has(lower)) {
                headers[name] = SCRUBBED;
            }
            else {
                headers[name] = scrubString(value);
            }
        }
        out.headers = headers;
    }
    return out;
}
function scrubBreadcrumb(crumb) {
    let data = null;
    if (crumb.data) {
        data = {};
        for (const [name, value] of Object.entries(crumb.data)) {
            data[name] = isKeyDenylisted(name) ? SCRUBBED : scrubString(value);
        }
    }
    return { ...crumb, message: scrubString(crumb.message), data };
}
/** v2: identity. `id` passes the pattern rules; `email` and `username` are
 * removed whole unless the customer opted that exact dotted name in. An
 * opted-in value still passes the pattern rules. */
function scrubUser(user, allowFields) {
    const out = { ...user };
    if (typeof out.id === "string")
        out.id = scrubString(out.id);
    for (const field of REMOVED_USER_FIELDS) {
        const key = field.slice("user.".length);
        const value = out[key];
        if (typeof value !== "string")
            continue;
        out[key] = allowFields.has(field) ? scrubString(value) : SCRUBBED;
    }
    return out;
}
/** v2: a flat string map (tags, custom context, device, frame locals).
 * Values pass the pattern rules; keys are left alone (see the module doc). */
function scrubStringMap(map) {
    const out = {};
    for (const [name, value] of Object.entries(map)) {
        if (typeof value !== "string") {
            out[name] = value;
        }
        else {
            out[name] = isKeyDenylisted(name) ? SCRUBBED : scrubString(value);
        }
    }
    return out;
}
function scrubDevice(device) {
    return scrubStringMap(device);
}
/** Scrubs one event. Returns a new object; the input is never mutated (the
 * caller may still be holding it, e.g. inside an exception handler).
 *
 * v2 fields are touched only when PRESENT: a v1 event goes through here and
 * comes out with exactly the v1 key set it went in with, which is what
 * makes the vector table's v1 expectations still hold byte-for-byte. */
export function scrubEvent(event, allowFields = []) {
    const allowed = new Set(allowFields.map((f) => f.toLowerCase()));
    return {
        ...event,
        message: scrubString(event.message),
        request: event.request ? scrubRequest(event.request, allowed) : event.request,
        breadcrumbs: event.breadcrumbs ? event.breadcrumbs.map(scrubBreadcrumb) : event.breadcrumbs,
        frames: event.frames
            ? event.frames.map((frame) => frame.contextLine != null || frame.preContext?.length || frame.postContext?.length || frame.vars
                ? {
                    ...frame,
                    ...(frame.contextLine != null ? { contextLine: scrubString(frame.contextLine) } : {}),
                    ...(frame.preContext ? { preContext: frame.preContext.map(scrubString) } : {}),
                    ...(frame.postContext ? { postContext: frame.postContext.map(scrubString) } : {}),
                    ...(frame.vars ? { vars: scrubStringMap(frame.vars) } : {}),
                }
                : frame)
            : event.frames,
        ...(event.user ? { user: scrubUser(event.user, allowed) } : {}),
        ...(event.tags ? { tags: scrubStringMap(event.tags) } : {}),
        ...(event.context ? { context: scrubStringMap(event.context) } : {}),
        ...(event.device ? { device: scrubDevice(event.device) } : {}),
    };
}
