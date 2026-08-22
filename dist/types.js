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
// Mirrored by MAX_ERROR_EVENTS_PER_BATCH etc. in packages/db/error-ingest.ts
// and pinned by wire-contract.test.ts on both sides.
export const MAX_EVENTS_PER_BATCH = 50;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_FRAMES_PER_EVENT = 50;
export const MAX_STRING_LENGTH = 512;
export const MAX_BREADCRUMBS_PER_EVENT = 20;
export const MAX_BREADCRUMB_DATA_ENTRIES = 10;
