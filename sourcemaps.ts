import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
export const MAX_SOURCEMAP_BYTES = 2 * 1024 * 1024;
export const MAX_ARTIFACTS_PER_RELEASE = 50;
export const MAX_ARTIFACTS_PER_UPLOAD = 10;

export const DEFAULT_API_ORIGIN = "https://realuptime.io";

const INGEST_KEY_SHAPE = /^rue_[0-9a-f]{32,128}$/;

export class SourcemapUploadError extends Error {
  /** Non-2xx answers carry the server's own status and RU- code verbatim. */
  readonly httpStatus?: number;
  readonly code?: string;
  constructor(message: string, opts: { httpStatus?: number; code?: string } = {}) {
    super(message);
    this.name = "SourcemapUploadError";
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
  }
}

export interface UploadTarget {
  /** The project DSN, e.g. `https://realuptime.io/api/errors/v1/ingest/rue_...`. */
  dsn?: string;
  /** A bare ingest key, used with `origin` when no DSN is at hand. */
  ingestKey?: string;
  /** Origin for the bare-key form; defaults to https://realuptime.io. */
  origin?: string;
}

/**
 * `https://host/api/errors/v1/ingest/<key>` -> `https://host/api/errors/v1/sourcemaps/<key>`.
 * A DSN wins over a bare key when both are given; either is enough.
 */
export function resolveSourcemapUploadUrl(target: UploadTarget): string {
  if (target.dsn) {
    let url: URL;
    try {
      url = new URL(target.dsn);
    } catch {
      throw new SourcemapUploadError("The DSN is not a valid URL.");
    }
    const match = /^(.*\/api\/errors\/v1)\/ingest\/(rue_[0-9a-f]+)\/?$/.exec(url.pathname);
    if (!match) {
      throw new SourcemapUploadError("The DSN does not look like a realuptime errors DSN (expected .../api/errors/v1/ingest/rue_...).");
    }
    return `${url.origin}${match[1]}/sourcemaps/${match[2]}`;
  }
  if (target.ingestKey) {
    if (!INGEST_KEY_SHAPE.test(target.ingestKey)) {
      throw new SourcemapUploadError("The ingest key does not look like a realuptime errors ingest key (rue_...).");
    }
    const origin = (target.origin ?? DEFAULT_API_ORIGIN).replace(/\/+$/, "");
    return `${origin}/api/errors/v1/sourcemaps/${target.ingestKey}`;
  }
  throw new SourcemapUploadError("No ingest credential: pass a DSN (REALUPTIME_ERRORS_DSN) or an ingest key (REALUPTIME_ERRORS_INGEST_KEY).");
}

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

function walkMaps(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkMaps(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      out.push(full);
    }
  }
}

/** Joins a URL-ish prefix and a relative file path with exactly one slash
 * and forward slashes throughout (artifact names are compared against URL
 * paths, never OS paths). */
export function artifactName(relativePath: string, urlPrefix?: string): string {
  const rel = relativePath.split(sep).join("/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!urlPrefix) return rel;
  const prefix = urlPrefix.replace(/^~\/?/, "").replace(/\/+$/, "");
  return prefix.length > 0 ? `${prefix}/${rel}` : rel;
}

/**
 * Collects `.map` files from each given path: a directory is walked
 * recursively (node_modules and .git skipped) and each map is named relative
 * to THAT directory; a file is taken as-is and named by its basename
 * (relative to its own directory). Names are de-duplicated; the first
 * occurrence wins and later duplicates are reported back so the caller can
 * say so rather than silently dropping one.
 */
export function collectSourcemapFiles(
  paths: readonly string[],
  options: { cwd?: string; urlPrefix?: string } = {},
): { files: SourcemapFile[]; duplicates: string[]; missing: string[] } {
  const cwd = options.cwd ?? process.cwd();
  const files: SourcemapFile[] = [];
  const duplicates: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const given of paths) {
    const abs = isAbsolute(given) ? given : resolve(cwd, given);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(abs);
    } catch {
      missing.push(given);
      continue;
    }
    const candidates: { full: string; base: string }[] = [];
    if (stat.isDirectory()) {
      const found: string[] = [];
      walkMaps(abs, found);
      for (const full of found.sort()) candidates.push({ full, base: abs });
    } else {
      candidates.push({ full: abs, base: resolve(abs, "..") });
    }
    for (const { full, base } of candidates) {
      const name = artifactName(relative(base, full), options.urlPrefix);
      if (seen.has(name)) {
        duplicates.push(name);
        continue;
      }
      seen.add(name);
      const content = readFileSync(full, "utf8");
      files.push({
        name,
        path: full,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  }
  return { files, duplicates, missing };
}

/** Local pre-flight: the refusals the server would answer anyway, caught
 * before a single batch leaves, so a bad set never half-uploads. Returns the
 * first problem as a message, or null. */
export function preflightSourcemapFiles(files: readonly SourcemapFile[]): string | null {
  if (files.length === 0) return "No .map files found in the given paths.";
  if (files.length > MAX_ARTIFACTS_PER_RELEASE) {
    return `${files.length} source maps found; a release holds at most ${MAX_ARTIFACTS_PER_RELEASE}. Narrow the paths (or pass only the maps for your entry chunks).`;
  }
  for (const file of files) {
    if (file.bytes > MAX_SOURCEMAP_BYTES) {
      return `${file.name} is ${file.bytes} bytes; the per-file limit is ${MAX_SOURCEMAP_BYTES}. Nothing was uploaded.`;
    }
  }
  return null;
}

export function batchSourcemapFiles<T>(files: readonly T[], size = MAX_ARTIFACTS_PER_UPLOAD): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < files.length; i += size) batches.push(files.slice(i, i + size));
  return batches;
}

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
  releaseFiles: { name: string; size: number }[];
  limits: { maxFilesPerRelease: number; maxBytesPerFile: number } | null;
  files: { name: string; bytes: number; sha256: string }[];
}

export interface UploadOptions {
  url: string;
  release: string;
  files: readonly SourcemapFile[];
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
export async function uploadSourcemaps(options: UploadOptions): Promise<UploadSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const batches = batchSourcemapFiles(options.files);
  let stored = 0;
  let replaced = 0;
  let releaseFiles: UploadSummary["releaseFiles"] = [];
  let limits: UploadSummary["limits"] = null;
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const progress: UploadProgress = { batch: index + 1, batches: batches.length, files: batch };
    options.onProgress?.(progress);
    let response: Response;
    try {
      response = await fetchImpl(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          release: options.release,
          files: batch.map((file) => ({ name: file.name, content: file.content })),
        }),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new SourcemapUploadError(`Could not reach the upload endpoint: ${reason}${partialNote(index, batches.length)}`);
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const message = typeof body.error === "string" ? body.error : `Upload failed with status ${response.status}.`;
      const retry = response.headers.get("retry-after");
      throw new SourcemapUploadError(`${message}${retry ? ` Retry after ${retry}s.` : ""}${partialNote(index, batches.length)}`, {
        httpStatus: response.status,
        code: typeof body.code === "string" ? body.code : undefined,
      });
    }
    const batchStored = typeof body.stored === "number" ? body.stored : batch.length;
    const batchReplaced = typeof body.replaced === "number" ? body.replaced : 0;
    stored += batchStored;
    replaced += batchReplaced;
    if (Array.isArray(body.files)) releaseFiles = body.files as UploadSummary["releaseFiles"];
    if (body.limits && typeof body.limits === "object") limits = body.limits as UploadSummary["limits"];
    progress.stored = batchStored;
    progress.replaced = batchReplaced;
    options.onProgress?.(progress);
  }
  return {
    release: options.release,
    // The key is a secret; the summary lands in CI logs, so it is masked.
    url: options.url.replace(/rue_[0-9a-f]+/, "rue_..."),
    uploaded: options.files.length,
    stored,
    replaced,
    releaseFiles,
    limits,
    files: options.files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
  };
}

function partialNote(failedIndex: number, batches: number): string {
  if (failedIndex === 0) return " Nothing was uploaded.";
  return ` Batches 1-${failedIndex} of ${batches} were already stored; the release is partially updated. Re-run to finish (re-uploads replace, never duplicate).`;
}

/** One human line per progress event, for the CLI's stderr and the plugins'
 * logger. Hashes are shortened to 12 chars; full hashes are in the summary. */
export function formatProgressLine(progress: UploadProgress): string {
  const names = progress.files.map((file) => `${file.name} (sha256 ${file.sha256.slice(0, 12)}, ${file.bytes} bytes)`);
  if (progress.stored === undefined) {
    return `uploading batch ${progress.batch}/${progress.batches}: ${names.join(", ")}`;
  }
  return `batch ${progress.batch}/${progress.batches} ok: stored ${progress.stored}, replaced ${progress.replaced}`;
}
