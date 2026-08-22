/**
 * The Errors wire contract, v1 (docs/errors-plan.md, "The SDKs: two
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
}

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
 * treated as transient. */
export type WireRefusalReason = "over_quota" | "rate_limited" | "key_revoked" | "malformed";

// Mirrored by MAX_ERROR_EVENTS_PER_BATCH etc. in packages/db/error-ingest.ts
// and pinned by wire-contract.test.ts on both sides.
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_FRAMES_PER_EVENT = 50;
export const MAX_STRING_LENGTH = 512;
export const MAX_BREADCRUMBS_PER_EVENT = 20;
export const MAX_BREADCRUMB_DATA_ENTRIES = 10;
