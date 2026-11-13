import { resolve } from "node:path";
import {
  apiKeyAllowedFor,
  collectSourcemapFiles,
  formatProgressLine,
  preflightSourcemapFiles,
  resolveSourcemapUploadUrl,
  type SourcemapFile,
  uploadSourcemaps,
  type UploadSummary,
} from "./sourcemaps.ts";

/**
 * Vite plugin (REA-254): uploads the `.map` files a production build wrote
 * to its outDir, on `closeBundle`, to the project's source-map endpoint.
 *
 *   // vite.config.ts
 *   import { realuptimeSourcemaps } from "@realuptime/errors/vite";
 *   export default defineConfig({
 *     build: { sourcemap: true },
 *     plugins: [
 *       realuptimeSourcemaps({
 *         release: process.env.RELEASE ?? process.env.GITHUB_SHA!,
 *         dsn: process.env.REALUPTIME_ERRORS_DSN,
 *         apiKey: process.env.REALUPTIME_API_KEY,
 *       }),
 *     ],
 *   });
 *
 * It does not import "vite": the hook shapes are matched structurally, so
 * this stays a zero-dependency file in a zero-dependency package (the same
 * rule the framework adapters follow). It never changes the build output:
 * no map stripping, no injected code, no release constant, nothing. It reads
 * the maps Vite already wrote and posts them.
 *
 * Failure policy: an upload failure is logged loudly with the server's own
 * message and the build still succeeds, because a deploy pipeline that
 * cannot reach realuptime should not also fail to ship; set
 * `failOnError: true` to make the build fail instead. Either way the
 * failure is one clear line, never silence.
 */

export interface SourcemapPluginOptions {
  /** The release string the app reports at runtime (`init({ release })`).
   * The maps are matched to events by this exact string. */
  release: string;
  /** The project DSN; `REALUPTIME_ERRORS_DSN` is read when omitted. It names
   * the project the maps belong to. */
  dsn?: string;
  /** An API key with Errors write access, which authorises the upload
   * (`REALUPTIME_API_KEY` when omitted). Keep it in CI secrets; the DSN alone
   * stops being accepted for uploads on February 17, 2027. */
  apiKey?: string;
  /** A bare ingest key (`REALUPTIME_ERRORS_INGEST_KEY` when omitted), used
   * with `origin` when no DSN is set. */
  ingestKey?: string;
  origin?: string;
  /** Prefix artifact names with the public path the bundle is served from
   * (e.g. `~/assets` or `static/js`), when the outDir layout does not match
   * the URL path. Matching is by path suffix, so it is rarely needed. */
  urlPrefix?: string;
  /** Override the directory to collect from; defaults to the resolved
   * build outDir. */
  dir?: string;
  /** Skip the upload without failing (e.g. local builds): when false, the
   * plugin logs one line and does nothing. Default: upload whenever a
   * credential is present. */
  enabled?: boolean;
  failOnError?: boolean;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  env?: Record<string, string | undefined>;
}

/** The slice of Vite's ResolvedConfig this plugin reads. */
interface ResolvedConfigLike {
  root?: string;
  build?: { outDir?: string };
}

export interface SourcemapPlugin {
  name: string;
  apply: "build";
  enforce: "post";
  configResolved(config: ResolvedConfigLike): void;
  closeBundle(): Promise<void>;
}

/** The shared run both plugins call: collect, pre-flight, upload, report.
 * Returns the summary on success, null when skipped or failed (already
 * logged); throws only when `failOnError` is set. */
export async function runSourcemapUpload(
  options: SourcemapPluginOptions,
  dir: string,
  label: string,
): Promise<UploadSummary | null> {
  const log = options.log ?? ((line: string) => console.error(line));
  const env = options.env ?? process.env;
  const prefix = `[realuptime-errors ${label}]`;
  const fail = (message: string): null => {
    if (options.failOnError) throw new Error(`${prefix} ${message}`);
    log(`${prefix} ${message}`);
    return null;
  };
  if (options.enabled === false) {
    log(`${prefix} disabled; no source maps uploaded.`);
    return null;
  }
  const dsn = options.dsn ?? env.REALUPTIME_ERRORS_DSN;
  const ingestKey = options.ingestKey ?? env.REALUPTIME_ERRORS_INGEST_KEY;
  if (!dsn && !ingestKey) {
    log(`${prefix} no REALUPTIME_ERRORS_DSN or ingest key set; no source maps uploaded for ${options.release}.`);
    return null;
  }
  if (!options.release) return fail("release is required; no source maps uploaded.");
  let url: string;
  try {
    url = resolveSourcemapUploadUrl({ dsn, ingestKey, origin: options.origin });
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
  const apiKey = options.apiKey ?? env.REALUPTIME_API_KEY;
  if (apiKey && !apiKeyAllowedFor(url, options.origin)) {
    log(`${prefix} the API key is sent only to realuptime.io over https or the configured origin; not to ${new URL(url).origin}.`);
  }
  const { files, duplicates, missing } = collectSourcemapFiles([dir], { urlPrefix: options.urlPrefix });
  if (missing.length > 0) return fail(`${dir} does not exist; no source maps uploaded.`);
  const problem = preflightSourcemapFiles(files);
  if (problem) return fail(problem);
  for (const name of duplicates) log(`${prefix} duplicate artifact name ${name}; the first occurrence was kept.`);
  try {
    const summary = await uploadSourcemaps({
      url,
      release: options.release,
      files,
      apiKey,
      trustedOrigin: options.origin,
      fetchImpl: options.fetchImpl,
      onProgress: (progress) => log(`${prefix} ${formatProgressLine(progress)}`),
    });
    log(`${prefix} uploaded ${summary.uploaded} source map${summary.uploaded === 1 ? "" : "s"} for release ${summary.release} (stored ${summary.stored}, replaced ${summary.replaced}).`);
    if (summary.removedReleases.length > 0) {
      log(`${prefix} to stay within the project's source-map storage, maps were removed for: ${summary.removedReleases.join(", ")}.`);
    }
    if (summary.warning) log(`${prefix} warning: ${summary.warning}`);
    return summary;
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
}

export function realuptimeSourcemaps(options: SourcemapPluginOptions): SourcemapPlugin {
  let outDir = options.dir ?? "dist";
  return {
    name: "realuptime-errors-sourcemaps",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      if (options.dir) {
        outDir = resolve(config.root ?? process.cwd(), options.dir);
        return;
      }
      outDir = resolve(config.root ?? process.cwd(), config.build?.outDir ?? "dist");
    },
    async closeBundle() {
      await runSourcemapUpload(options, outDir, "vite");
    },
  };
}

export type { SourcemapFile, UploadSummary };
