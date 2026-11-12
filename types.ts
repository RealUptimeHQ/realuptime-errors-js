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

/** One stack frame, post-scrub. `inApp` is the SDK's best-effort guess
 * (Node: not under node_modules and not an internal frame); the server
 * trusts it for display and for fingerprinting. */
export interface WireFrame {
  file: string;
  function: string | null;
  line: number | null;
  inApp: boolean;
  /** 1-based column when the runtime provided one (Phase 3). Source-map
   * symbolication needs it; a frame without one renders raw server-side
   * with a stated reason, never silently pretty. */
  column?: number | null;
  /** Source context, captured client-side where the SDK can read source
   * (the Python SDK); pattern-scrubbed before serialization. */
  contextLine?: string | null;
  preContext?: string[];
  postContext?: string[];
  /** v2 (REA-182): this frame's local variables, stringified.
   *
   * OFF BY DEFAULT in both SDKs and hard-capped when on
   * (MAX_LOCAL_VARS_PER_FRAME entries, MAX_LOCAL_VAR_LENGTH characters
   * each), because locals are the single leakiest thing an error tracker
   * can capture: the variable holding the password is, definitionally, in
   * scope at the frame that failed to use it. Values pass the pattern scrub
   * like every other captured string, but the pattern scrub is a net, not a
   * guarantee, which is why the switch defaults to off rather than to
   * "trust the regexes".
   *
   * Captured by the Python SDK only, the same asymmetry `contextLine`
   * already has: a JS stack is a STRING, and the runtime hands the SDK no
   * access to the frames behind it. The field is in the contract on both
   * sides so the scrub, the storage and the UI are one implementation. */
  vars?: Record<string, string> | null;
}

/** v2 (REA-182): who this happened to.
 *
 * `id` is the field the product is built around: an opaque account or user
 * identifier is what makes "how many users hit this" answerable, and it is
 * the customer's own key space, not a person's contact details. It rides
 * the wire as-is (pattern-scrubbed like any other string).
 *
 * `email` and `username` are PERSONAL DATA and are `[scrubbed]` by default,
 * client-side, before serialization. A customer who genuinely needs them
 * opts each one back in BY NAME in SDK config (`allowFields: ["user.email"]`)
 * -- the same per-field, in-code, never-a-global-switch shape the removed
 * headers use, and for the same reason: a one-switch opt-out is how a
 * default dies. There is no server-side way to turn this on, deliberately:
 * a default that a dashboard toggle can disable is a default that leaks
 * before anyone notices. */
export interface WireUser {
  id?: string | null;
  email?: string | null;
  username?: string | null;
}

/** v2 (REA-182): where it ran. Runtime and platform facts the SDK reads out
 * of its own process, never out of the request.
 *
 * Deliberately NOT here: hostname, local IP, container id, or anything else
 * that identifies a machine rather than a runtime. Those are operational
 * identifiers with real re-identification value and no debugging value that
 * `release` + `environment` does not already carry. */
export interface WireDevice {
  /** "node", "python", "browser". */
  runtime?: string;
  /** e.g. "22.4.0", "3.12.1". */
  runtimeVersion?: string;
  /** e.g. "linux", "darwin", "win32". */
  platform?: string;
  /** e.g. "x64", "arm64". */
  arch?: string;
}

/** One breadcrumb (Phase 3): a scrubbed trail entry recorded before the
 * event. Newest last on the wire. */
export interface WireBreadcrumb {
  /** ISO 8601, the customer clock; display-only. */
  timestamp: string | null;
  category: string | null;
  message: string;
  data: Record<string, string> | null;
}

/** Minimal request context: method, path, status by default. Headers appear
 * only for fields the integrator captured deliberately, and the scrub-by-
 * default rules in scrub.ts have already run over everything here before it
 * is serialized. */
export interface WireRequest {
  method?: string;
  path?: string;
  status?: number;
  headers?: Record<string, string>;
  /** v2 (REA-182): the matched ROUTE TEMPLATE, e.g. "/orders/:id", as
   * distinct from the concrete path "/orders/4242". This is the one extra
   * thing a framework adapter genuinely knows and cannot be guessed from
   * the path, it is low-cardinality (it groups), and it carries no
   * user-supplied bytes at all. Adapters forward it and nothing else new:
   * never headers, never cookies, never bodies. Pattern-scrubbed anyway,
   * because a route template is still a string a customer wrote. */
  route?: string;
}

export interface WireEvent {
  /** ISO 8601, the customer process's clock. The server bounds it and never
   * uses it for quota. */
  occurredAt: string;
  message: string;
  exceptionType: string | null;
  release: string | null;
  environment: string | null;
  frames: WireFrame[] | null;
  request: WireRequest | null;
  /** Custom grouping override (`fingerprint: [...]`), the escape hatch for
   * the cases automatic grouping gets wrong. Null means "group for me". */
  fingerprint: string[] | null;
  /** The breadcrumb trail preceding this event, newest last, at most
   * MAX_BREADCRUMBS_PER_EVENT (Phase 3). Null when none were recorded. */
  breadcrumbs: WireBreadcrumb[] | null;
  /** How many older breadcrumbs the bounded client-side ring had evicted
   * when this event was built: the count of what the trail is NOT showing,
   * reported so the server can render "showing the last N; M older
   * dropped" instead of a quietly truncated trail. */
  breadcrumbsDropped: number;

  // ── v2 (REA-182), all optional and all absent from a v1 payload ───────

  /** Who this happened to. See WireUser: id rides as-is, email and username
   * are scrubbed unless opted in per field. */
  user?: WireUser | null;
  /** Short, low-cardinality labels the customer sets (`setTag`), the things
   * an issues list can filter on: "tenant", "plan", "feature-flag". Values
   * pass the pattern scrub. At most MAX_TAGS_PER_EVENT. */
  tags?: Record<string, string> | null;
  /** Free-form custom context the customer sets (`setContext`): the
   * application state that makes an issue diagnosable and that no schema of
   * ours could have anticipated. Values pass the pattern scrub. At most
   * MAX_CONTEXT_ENTRIES. */
  context?: Record<string, string> | null;
  /** Runtime/platform metadata the SDK reads from its own process. */
  device?: WireDevice | null;
  /** REA-257: a client-minted UUID for this event, present ONLY when the
   * integration opted into user feedback (`init({ feedback: {...} })`). It
   * is what a later `POST /api/errors/v1/feedback/<key>` names to attach a
   * user's report to this exact occurrence. An integration that never
   * enables feedback keeps emitting the id-less payload it always did. */
  eventId?: string;
  /** REA-569: severity, Sentry's five-value convention. Per-capture only
   * (CaptureContext.level, not a sticky init()/scope option): unlike
   * environment or release, a severity is a fact about THIS occurrence, not
   * about the process. Absent resolves to "error" server-side. */
  level?: ErrorLevel;
}

/** REA-569: the closed severity set, Sentry's own five values so a
 * migrating customer's rule filters translate directly. */
export type ErrorLevel = "fatal" | "error" | "warning" | "info" | "debug";
export const ERROR_LEVELS: readonly ErrorLevel[] = ["fatal", "error", "warning", "info", "debug"];

export interface WireBatch {
  /** e.g. "realuptime-errors-js/0.1.0" */
  sdk: string;
  /** Events this SDK dropped client-side (bounded buffer overflow) since the
   * last successful delivery. Relayed so even client-side drops reach the
   * product's visible drop counters -- never omitted, never reset without
   * being reported. */
  droppedClient: number;
  events: WireEvent[];
}

/** Success body. `accepted` + `droppedOverQuota` always sum to the batch's
 * event count; `overQuota: true` with `resetsAt` tells the SDK to stop
 * sending until the window resets rather than burning the customer's cycles
 * on refusals. */
export interface WireIngestResult {
  accepted: number;
  droppedOverQuota: number;
  overQuota: boolean;
  quota: { used: number; limit: number; resetsAt: string };
}

/** Machine-readable refusal reasons the SDK understands. Anything else is
 * treated as transient.
 *
 * `oversize_context` (v2, RU-4009) is a 400 like `malformed`, and both SDKs
 * already handle every 400 the same way -- drop the batch, log once, never
 * retry -- so it needs no new client branch. It is a SEPARATE reason string
 * because "your event carried 500 tags" and "your event was not valid JSON"
 * are different bugs in the customer's integration, and telling them apart
 * costs one string. */
export type WireRefusalReason =
  | "over_quota"
  | "rate_limited"
  | "key_revoked"
  | "malformed"
  | "oversize_context";

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

// ── REA-257: user feedback (the report dialog) ──────────────────────────
//
// Opt-in, customer-configured, and deliberately a SEPARATE wire message from
// the event batch: a user's own words about what they were doing are
// personal data the customer chose to collect, so they travel only when the
// customer turned the feature on, and they are scrubbed (the same pattern
// rules) before they leave the page. Mirrored by packages/db/error-feedback.ts
// and pinned by wire-contract.test.ts.

/** `POST /api/errors/v1/feedback/<key>` body. */
export interface WireFeedback {
  /** The client-minted event id the report attaches to (WireEvent.eventId). */
  eventId: string;
  /** What the user typed. Scrubbed client-side before serialization. */
  comments: string;
  /** Optional, only sent when the dialog showed the field and the user
   * filled it. Scrubbed by the same pattern rules. */
  name?: string;
  email?: string;
  /** e.g. "realuptime-errors-js/0.5.0" */
  sdk: string;
}

export const MAX_FEEDBACK_COMMENTS_LENGTH = 4000;
export const MAX_FEEDBACK_NAME_LENGTH = 200;
export const MAX_FEEDBACK_EMAIL_LENGTH = 254;
/** Body size ceiling the server enforces on the feedback endpoint. */
export const MAX_FEEDBACK_BODY_BYTES = 16_384;
