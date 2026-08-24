import { type SourcemapFile, type UploadSummary } from "./sourcemaps.ts";
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
    /** The project DSN; `REALUPTIME_ERRORS_DSN` is read when omitted. */
    dsn?: string;
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
    build?: {
        outDir?: string;
    };
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
export declare function runSourcemapUpload(options: SourcemapPluginOptions, dir: string, label: string): Promise<UploadSummary | null>;
export declare function realuptimeSourcemaps(options: SourcemapPluginOptions): SourcemapPlugin;
export type { SourcemapFile, UploadSummary };
