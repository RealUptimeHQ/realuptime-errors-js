/**
 * The Errors wire contract (the internal-docs repo's errors-plan.md, "The SDKs: two
 * languages, one contract").
 *
 * DUPLICATED, not imported. Same convention as apps/agent/types.ts and for
 * the same reason: this package ships into customer bundles and processes,
 * so its dependency graph must stay auditable at a glance -- zero imports
 * beyond the platform. The cost (a server-side rename does not break this
 * build) is paid by wire-contract.test.ts, which pins every field name, and
 * by the shared scrub vectors (scrub-vectors.json), which pin the scrub
 * semantics across this SDK, the Python SDK, and the server's second net.
 * The server-side mirror of these limits lives in
 * packages/db/error-ingest.ts.
 *
 * ## v2 (REA-182): identity, tags, custom context, device metadata
 *
 * STRICTLY ADDITIVE, and that word is load-bearing rather than decorative.
 * Every v1 field keeps its name, its type and its meaning; every v2 field is
 * OPTIONAL and absent from a v1 payload. A v1 batch produced by an SDK that
 * predates this file still ingests byte-for-byte unchanged, which
 * route.test.ts pins with a frozen golden v1 body.
 *
 * **There is deliberately no `version` field on the wire, and that is a
 * decision, not an omission.** A version discriminant would have to be
 * REQUIRED to be worth reading, and a required field is by construction not
 * additive: every already-deployed SDK in a customer's process omits it, so
 * the server would have to treat "absent" as v1 anyway -- which is exactly
 * what optional-field presence already tells it, with no field to keep in
 * sync. The `sdk` string ("realuptime-errors-js/0.3.0") remains the honest
 * record of what produced a payload. A future change that is NOT additive
 * (a removed field, a changed meaning) gets a versioned PATH, the way the
 * fingerprint algorithm gets a version rather than mutating history.
 */
// Mirrored by MAX_ERROR_EVENTS_PER_BATCH etc. in packages/db/error-ingest.ts
// and pinned by wire-contract.test.ts on both sides.
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_FRAMES_PER_EVENT = 50;
export const MAX_STRING_LENGTH = 512;
export const MAX_BREADCRUMBS_PER_EVENT = 20;
export const MAX_BREADCRUMB_DATA_ENTRIES = 10;
// ── v2 (REA-182) caps ───────────────────────────────────────────────────
//
// Two tiers, deliberately:
//
//   SOFT caps (the constants below) are what an honest integration lives
//   inside. Going past one is not an error: the server keeps the first N
//   entries, COUNTS what it dropped, and stores the count so the issue
//   detail can say "3 context entries were dropped (size cap)". Truncating
//   silently is the exact lie this product was founded against, so the
//   count is first-class data rather than a log line.
//
//   The HARD bound (HARD_MAX_MAP_ENTRIES) is where a payload stops being an
//   over-eager integration and starts being a bug or an attack; that one
//   REFUSES the batch with RU-4009 rather than quietly keeping 20 of 5,000.
/** Tags per event kept; extras are dropped and counted. */
export const MAX_TAGS_PER_EVENT = 20;
/** Custom-context entries per event kept; extras are dropped and counted. */
export const MAX_CONTEXT_ENTRIES = 20;
/** Tag and context KEY length. Shorter than MAX_STRING_LENGTH because a key
 * is a label, not a payload; a 512-character key is a value in disguise. */
export const MAX_CONTEXT_KEY_LENGTH = 64;
/** Local variables kept per frame when the (off-by-default) capture is on. */
export const MAX_LOCAL_VARS_PER_FRAME = 20;
/** Per-value cap for a local variable, tighter than MAX_STRING_LENGTH: a
 * local is captured for its shape, not its contents. */
export const MAX_LOCAL_VAR_LENGTH = 256;
/** Combined serialized budget for user + tags + context + device on ONE
 * event, enforced server-side inside the ingest transaction. Entries past
 * it are dropped and counted, same honesty rule as the soft caps. */
export const MAX_CONTEXT_BYTES = 4096;
/** The refusal boundary: more entries than this in any one map is a bug in
 * the caller, not an over-eager integration. */
export const HARD_MAX_MAP_ENTRIES = 200;
export const MAX_FEEDBACK_COMMENTS_LENGTH = 4000;
export const MAX_FEEDBACK_NAME_LENGTH = 200;
export const MAX_FEEDBACK_EMAIL_LENGTH = 254;
/** Body size ceiling the server enforces on the feedback endpoint. */
export const MAX_FEEDBACK_BODY_BYTES = 16_384;
