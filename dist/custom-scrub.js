import { SCRUBBED } from "./scrub.js";
const KINDS = ["field_name", "key_glob", "value_regex"];
const MAX_PATTERN_LENGTH = 200;
const MAX_QUANTIFIERS = 10;
const MAX_REPEAT = 100;
/** Most rules a response may carry; matches the server's per-project cap. */
export const MAX_CUSTOM_SCRUB_RULES = 50;
export function validateCustomScrubRule(input) {
    if (typeof input?.kind !== "string" || !KINDS.includes(input.kind))
        return false;
    if (typeof input.pattern !== "string")
        return false;
    const pattern = input.pattern;
    if (pattern.trim().length === 0 || pattern.length > MAX_PATTERN_LENGTH)
        return false;
    if (/[\r\n]/.test(pattern))
        return false;
    if (input.kind === "field_name" || input.kind === "key_glob") {
        if (pattern !== pattern.trim())
            return false;
        const hasWildcard = /[*?]/.test(pattern);
        return input.kind === "key_glob" ? hasWildcard : !hasWildcard;
    }
    return safeRegex(pattern);
}
function safeRegex(pattern) {
    const groupHasQuantifier = [];
    let quantifiers = 0;
    let inClass = false;
    let lastClosedGroupHadQuantifier = false;
    let lastWasQuantifier = false;
    let lastWasAtom = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "\\") {
            const next = pattern[i + 1];
            if (next === undefined)
                return false;
            if (/[1-9]/.test(next) || next === "k")
                return false;
            if (next === "p" || next === "P" || next === "u" || next === "c")
                return false;
            i += 1;
            if (!inClass) {
                lastWasAtom = true;
                lastWasQuantifier = false;
                lastClosedGroupHadQuantifier = false;
            }
            continue;
        }
        if (inClass) {
            if (ch === "]")
                inClass = false;
            continue;
        }
        if (ch === "[") {
            inClass = true;
            if (pattern[i + 1] === "^")
                i += 1;
            if (pattern[i + 1] === "]")
                i += 1;
            lastWasAtom = true;
            lastWasQuantifier = false;
            lastClosedGroupHadQuantifier = false;
            continue;
        }
        if (ch === "(") {
            if (pattern[i + 1] === "?") {
                if (pattern[i + 2] !== ":")
                    return false;
                i += 2;
            }
            groupHasQuantifier.push(false);
            lastWasAtom = false;
            lastWasQuantifier = false;
            lastClosedGroupHadQuantifier = false;
            continue;
        }
        if (ch === ")") {
            const had = groupHasQuantifier.pop();
            if (had === undefined)
                return false;
            lastClosedGroupHadQuantifier = had;
            if (had && groupHasQuantifier.length > 0)
                groupHasQuantifier[groupHasQuantifier.length - 1] = true;
            lastWasAtom = true;
            lastWasQuantifier = false;
            continue;
        }
        const isBrace = ch === "{";
        if (ch === "*" || ch === "+" || ch === "?" || isBrace) {
            if (isBrace) {
                const close = pattern.indexOf("}", i);
                const body = close === -1 ? null : pattern.slice(i + 1, close);
                const m = body === null ? null : /^(\d+)(?:,(\d*))?$/.exec(body);
                if (!m) {
                    lastWasAtom = true;
                    lastWasQuantifier = false;
                    lastClosedGroupHadQuantifier = false;
                    continue;
                }
                const lo = Number(m[1]);
                const hi = m[2] === undefined ? lo : m[2] === "" ? Number.POSITIVE_INFINITY : Number(m[2]);
                if (lo > MAX_REPEAT || (Number.isFinite(hi) && hi > MAX_REPEAT))
                    return false;
                if (Number.isFinite(hi) && hi < lo)
                    return false;
                i = close;
            }
            if (ch === "?" && lastWasQuantifier) {
                lastWasQuantifier = false;
                continue;
            }
            if (!lastWasAtom)
                return false;
            if (lastClosedGroupHadQuantifier)
                return false;
            quantifiers += 1;
            if (quantifiers > MAX_QUANTIFIERS)
                return false;
            if (groupHasQuantifier.length > 0)
                groupHasQuantifier[groupHasQuantifier.length - 1] = true;
            lastWasAtom = false;
            lastWasQuantifier = true;
            lastClosedGroupHadQuantifier = false;
            continue;
        }
        if (ch === "|") {
            lastWasAtom = false;
            lastWasQuantifier = false;
            lastClosedGroupHadQuantifier = false;
            continue;
        }
        lastWasAtom = true;
        lastWasQuantifier = false;
        lastClosedGroupHadQuantifier = false;
    }
    if (inClass || groupHasQuantifier.length > 0)
        return false;
    let compiled;
    try {
        compiled = new RegExp(pattern, "g");
    }
    catch {
        return false;
    }
    return !new RegExp(compiled.source).test("");
}
function globToRegExp(glob) {
    let out = "^";
    for (const ch of glob) {
        if (ch === "*")
            out += ".*";
        else if (ch === "?")
            out += ".";
        else
            out += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    }
    return new RegExp(`${out}$`, "i");
}
/** Compiles rules, skipping any that fail validation. Never throws. */
export function compileCustomScrubRules(rules) {
    const names = new Set();
    const globs = [];
    const valueRegexes = [];
    let count = 0;
    for (const raw of rules.slice(0, MAX_CUSTOM_SCRUB_RULES)) {
        const rule = raw;
        if (!rule || typeof rule !== "object" || !validateCustomScrubRule({ kind: rule.kind, pattern: rule.pattern }))
            continue;
        count += 1;
        const pattern = rule.pattern;
        if (rule.kind === "field_name")
            names.add(pattern.toLowerCase());
        else if (rule.kind === "key_glob")
            globs.push(globToRegExp(pattern));
        else
            valueRegexes.push(new RegExp(pattern, "g"));
    }
    return {
        matchesKey: (name) => {
            const lower = name.toLowerCase();
            if (names.has(lower))
                return true;
            for (const glob of globs)
                if (glob.test(lower))
                    return true;
            return false;
        },
        valueRegexes,
        count,
    };
}
export const NO_CUSTOM_SCRUB_RULES = { matchesKey: () => false, valueRegexes: [], count: 0 };
function applyValue(value, compiled) {
    let out = value;
    for (const re of compiled.valueRegexes) {
        re.lastIndex = 0;
        out = out.replace(re, SCRUBBED);
    }
    return out;
}
/** Applies compiled rules to an event that has ALREADY been through
 * scrubEvent. Returns a new object; never mutates the input. */
export function applyCustomScrubRules(event, compiled) {
    if (compiled.count === 0)
        return event;
    const value = (input) => applyValue(input, compiled);
    const entry = (name, input) => (compiled.matchesKey(name) ? SCRUBBED : value(input));
    const map = (input, prefix = "") => {
        const out = {};
        for (const [name, v] of Object.entries(input))
            out[name] = typeof v === "string" ? entry(prefix + name, v) : v;
        return out;
    };
    return {
        ...event,
        message: value(event.message),
        request: event.request
            ? {
                ...event.request,
                ...(typeof event.request.path === "string" ? { path: value(event.request.path) } : {}),
                ...(typeof event.request.route === "string" ? { route: value(event.request.route) } : {}),
                ...(event.request.headers ? { headers: map(event.request.headers) } : {}),
            }
            : event.request,
        breadcrumbs: event.breadcrumbs
            ? event.breadcrumbs.map((crumb) => ({
                ...crumb,
                message: value(crumb.message),
                ...(crumb.data ? { data: map(crumb.data) } : {}),
            }))
            : event.breadcrumbs,
        frames: event.frames
            ? event.frames.map((frame) => frame.contextLine != null || frame.preContext?.length || frame.postContext?.length || frame.vars
                ? {
                    ...frame,
                    ...(frame.contextLine != null ? { contextLine: value(frame.contextLine) } : {}),
                    ...(frame.preContext ? { preContext: frame.preContext.map(value) } : {}),
                    ...(frame.postContext ? { postContext: frame.postContext.map(value) } : {}),
                    ...(frame.vars ? { vars: map(frame.vars) } : {}),
                }
                : frame)
            : event.frames,
        ...(event.user ? { user: map(event.user, "user.") } : {}),
        ...(event.tags ? { tags: map(event.tags) } : {}),
        ...(event.context ? { context: map(event.context) } : {}),
        ...(event.device ? { device: map(event.device) } : {}),
    };
}
/**
 * The rules endpoint for a DSN: the ingest URL with `/ingest/` swapped for
 * `/scrub-rules/`. Returns null for a DSN that is not ingest-shaped, in
 * which case no fetch is attempted and the defaults run alone.
 */
export function scrubRulesUrlFor(dsn) {
    const marker = "/api/errors/v1/ingest/";
    const at = dsn.indexOf(marker);
    if (at === -1)
        return null;
    return `${dsn.slice(0, at)}/api/errors/v1/scrub-rules/${dsn.slice(at + marker.length)}`;
}
