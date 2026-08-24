import type { WireEvent } from "./types.ts";
/**
 * Customer-defined ADDITIONAL scrub rules, client side (REA-264). The rules
 * a project's owner set in the realuptime Errors settings are fetched once
 * at init (see index.ts, `fetchScrubRules`) and applied here AFTER the
 * default scrub (scrub.ts), never instead of it. There is nothing in this
 * file that can relax a default: a rule can only add a field name, a key
 * glob, or a value regex that turns more into `[scrubbed]`.
 *
 * DUPLICATED from packages/db/error-scrub-rules.ts, the scrub.ts
 * convention: this package must stay import-free. custom-scrub-vectors.json
 * pins the two (and the Python SDK) to byte-identical output; a semantic
 * change is a three-implementation change.
 *
 * The validator is carried here too, even though rules only ever arrive
 * from our own endpoint, because "only ever" is not a guarantee the host
 * app should depend on: a rule that fails the same safe-subset check the
 * server applies is skipped, so no network response can hand this process
 * a catastrophic-backtracking pattern.
 */
export type CustomScrubRuleKind = "field_name" | "key_glob" | "value_regex";
export interface CustomScrubRule {
    kind: CustomScrubRuleKind;
    pattern: string;
}
/** Most rules a response may carry; matches the server's per-project cap. */
export declare const MAX_CUSTOM_SCRUB_RULES = 50;
export declare function validateCustomScrubRule(input: {
    kind: unknown;
    pattern: unknown;
}): boolean;
export interface CompiledCustomScrubRules {
    matchesKey: (name: string) => boolean;
    valueRegexes: RegExp[];
    count: number;
}
/** Compiles rules, skipping any that fail validation. Never throws. */
export declare function compileCustomScrubRules(rules: readonly unknown[]): CompiledCustomScrubRules;
export declare const NO_CUSTOM_SCRUB_RULES: CompiledCustomScrubRules;
/** Applies compiled rules to an event that has ALREADY been through
 * scrubEvent. Returns a new object; never mutates the input. */
export declare function applyCustomScrubRules(event: WireEvent, compiled: CompiledCustomScrubRules): WireEvent;
/**
 * The rules endpoint for a DSN: the ingest URL with `/ingest/` swapped for
 * `/scrub-rules/`. Returns null for a DSN that is not ingest-shaped, in
 * which case no fetch is attempted and the defaults run alone.
 */
export declare function scrubRulesUrlFor(dsn: string): string | null;
