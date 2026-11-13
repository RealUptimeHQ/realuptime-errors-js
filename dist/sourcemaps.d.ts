/**
 * Source-map upload core (REA-254), shared by the CLI command
 * (`realuptime errors sourcemaps upload`, packages/cli/commands/errors.ts)
 * and the bundler plugins beside this file (`vite.ts`, `webpack.ts`).
 *
 * It wraps exactly one endpoint, `POST /api/errors/v1/sourcemaps/<key>`
 * (apps/web/app/api/errors/v1/sourcemaps/[key]/route.ts), and nothing else.
 * The endpoint is authenticated by the project's INGEST key, so the only
 * secret a CI step needs is the DSN the app already has; this module derives
 * the upload URL from that DSN (or from a bare key plus an origin).
 *
 * Only the main host serves that route. A DSN issued since the hostname split
 * names the intake host, which takes error events and nothing as heavy as an
 * upload (up to 10 files of 2 MB each), so a DSN on the intake host uploads to
 * the main host. The intake answers an upload that still arrives there with a
 * redirect to the main host (apps/ingest), for clients published before this.
 *
 * Honesty rules, same as the rest of the SDK:
 *  - Local refusals happen BEFORE any byte is sent (a file over the per-file
 *    cap, more files than a release may hold, no `.map` files found), and
 *    the message names the file. A half-uploaded release is a symbolication
 *    lottery, so this module never starts an upload it already knows the
 *    server will refuse.
 *  - Every file is content-addressed: its sha256 is computed locally and
 *    reported in the progress output, so two runs over the same build are
 *    visibly the same upload. Re-uploading is idempotent server-side (a
 *    same-named file for the same release is replaced, never duplicated); the
 *    summary reports `stored` and `replaced` exactly as the server answered,
 *    never a local guess.
 *  - Zero dependencies: Node builtins only (enforced by the errors-js
 *    dependency-hygiene test).
 */
/** Mirrors packages/db/error-sourcemaps.ts; the server is the authority and
 * the upload response carries its live `limits`, these are the local
 * pre-flight copies. */
export declare const MAX_SOURCEMAP_BYTES: number;
export declare const MAX_ARTIFACTS_PER_RELEASE = 50;
export declare const MAX_ARTIFACTS_PER_UPLOAD = 10;
export declare const DEFAULT_API_ORIGIN = "https://realuptime.io";
/** The intake host every DSN issued since the hostname split names
 * (`ingestBaseUrl` in packages/db/errors-dsn.ts). Source maps are not
 * uploaded there; see the module comment. */
export declare const INGEST_HOSTNAME = "ingest.realuptime.io";
export declare class SourcemapUploadError extends Error {
    /** Non-2xx answers carry the server's own status and RU- code verbatim. */
    readonly httpStatus?: number;
    readonly code?: string;
    constructor(message: string, opts?: {
        httpStatus?: number;
        code?: string;
    });
}
export interface UploadTarget {
    /** The project DSN, e.g. `https://ingest.realuptime.io/api/errors/v1/ingest/rue_...`. */
    dsn?: string;
    /** A bare ingest key, used with `origin` when no DSN is at hand. */
    ingestKey?: string;
    /** Origin for the bare-key form; defaults to https://realuptime.io. */
    origin?: string;
}
/**
 * `https://host/api/errors/v1/ingest/<key>` -> `https://host/api/errors/v1/sourcemaps/<key>`,
 * except that a DSN on the intake host (`ingest.realuptime.io`) uploads to the
 * main host, `https://realuptime.io`, because only the main host stores maps.
 * Any other DSN host (a pre-split `realuptime.io` DSN, a self-hosted or local
 * one) keeps its own origin. A DSN wins over a bare key when both are given;
 * either is enough.
 */
export declare function resolveSourcemapUploadUrl(target: UploadTarget): string;
export interface SourcemapFile {
    /** The artifact name sent to the server: the path relative to the
     * directory it was collected from, with `urlPrefix` (if any) in front.
     * Symbolication matches this against a frame's file by path suffix
     * (packages/db/error-sourcemaps.ts `artifactMatchesFrameFile`). */
    name: string;
    /** Absolute path on disk, for messages. */
    path: string;
    content: string;
    bytes: number;
    sha256: string;
}
/** Joins a URL-ish prefix and a relative file path with exactly one slash
 * and forward slashes throughout (artifact names are compared against URL
 * paths, never OS paths). */
export declare function artifactName(relativePath: string, urlPrefix?: string): string;
/**
 * Collects `.map` files from each given path: a directory is walked
 * recursively (node_modules and .git skipped) and each map is named relative
 * to THAT directory; a file is taken as-is and named by its basename
 * (relative to its own directory). Names are de-duplicated; the first
 * occurrence wins and later duplicates are reported back so the caller can
 * say so rather than silently dropping one.
 */
export declare function collectSourcemapFiles(paths: readonly string[], options?: {
    cwd?: string;
    urlPrefix?: string;
}): {
    files: SourcemapFile[];
    duplicates: string[];
    missing: string[];
};
/** Local pre-flight: the refusals the server would answer anyway, caught
 * before a single batch leaves, so a bad set never half-uploads. Returns the
 * first problem as a message, or null. */
export declare function preflightSourcemapFiles(files: readonly SourcemapFile[]): string | null;
export declare function batchSourcemapFiles<T>(files: readonly T[], size?: number): T[][];
export interface UploadProgress {
    batch: number;
    batches: number;
    files: readonly SourcemapFile[];
    /** Filled in after the batch's response arrives. */
    stored?: number;
    replaced?: number;
}
export interface UploadSummary {
    release: string;
    uploaded: number;
    /** Summed across batches, exactly as the server answered each one. */
    stored: number;
    replaced: number;
    /** The endpoint, with the key masked (this lands in CI logs). */
    url: string;
    /** The server's post-upload view of the release's files. */
    releaseFiles: {
        name: string;
        size: number;
    }[];
    limits: {
        maxFilesPerRelease: number;
        maxBytesPerFile: number;
        maxBytesPerProject?: number;
        maxReleasesPerProject?: number;
    } | null;
    files: {
        name: string;
        bytes: number;
        sha256: string;
    }[];
    /** Releases whose maps the server removed to keep the project within its
     * storage (the least recently active ones). */
    removedReleases: string[];
    /** The server's warning, when it sent one (an upload authorised by the DSN
     * alone is answered with one until that stops being accepted). */
    warning: string | null;
}
export interface UploadOptions {
    url: string;
    release: string;
    files: readonly SourcemapFile[];
    /** An API key with Errors write access, sent as `Authorization: Bearer`.
     * The DSN in `url` names the project; the key authorises the upload. Sent
     * only where `apiKeyAllowedFor` allows. */
    apiKey?: string;
    /** An origin the key may also go to (the CLI's configured API URL). */
    trustedOrigin?: string;
    fetchImpl?: typeof fetch;
    onProgress?: (progress: UploadProgress) => void;
}
/**
 * Uploads in batches of MAX_ARTIFACTS_PER_UPLOAD, sequentially (the per-key
 * upload budget is 10/min and the server takes a per-release lock; parallel
 * batches would only race that). Stops at the first refusal and throws with
 * the server's own message and code; an earlier batch that succeeded is
 * reported in the thrown error's message so the caller knows the release is
 * now partially updated rather than untouched.
 */
/**
 * Whether the API key may go to `url`: realuptime.io (or a host under it)
 * over https, or exactly `trustedOrigin`. A DSN on another host (self-hosted,
 * local) keeps its own upload origin, and an account API key must not follow
 * it there.
 */
export declare function apiKeyAllowedFor(url: string, trustedOrigin?: string): boolean;
export declare function uploadSourcemaps(options: UploadOptions): Promise<UploadSummary>;
/** One human line per progress event, for the CLI's stderr and the plugins'
 * logger. Hashes are shortened to 12 chars; full hashes are in the summary. */
export declare function formatProgressLine(progress: UploadProgress): string;
