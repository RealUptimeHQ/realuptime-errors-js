import { resolve } from "node:path";
import { collectSourcemapFiles, formatProgressLine, preflightSourcemapFiles, resolveSourcemapUploadUrl, uploadSourcemaps, } from "./sourcemaps.js";
/** The shared run both plugins call: collect, pre-flight, upload, report.
 * Returns the summary on success, null when skipped or failed (already
 * logged); throws only when `failOnError` is set. */
export async function runSourcemapUpload(options, dir, label) {
    const log = options.log ?? ((line) => console.error(line));
    const env = options.env ?? process.env;
    const prefix = `[realuptime-errors ${label}]`;
    const fail = (message) => {
        if (options.failOnError)
            throw new Error(`${prefix} ${message}`);
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
    if (!options.release)
        return fail("release is required; no source maps uploaded.");
    let url;
    try {
        url = resolveSourcemapUploadUrl({ dsn, ingestKey, origin: options.origin });
    }
    catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
    }
    const { files, duplicates, missing } = collectSourcemapFiles([dir], { urlPrefix: options.urlPrefix });
    if (missing.length > 0)
        return fail(`${dir} does not exist; no source maps uploaded.`);
    const problem = preflightSourcemapFiles(files);
    if (problem)
        return fail(problem);
    for (const name of duplicates)
        log(`${prefix} duplicate artifact name ${name}; the first occurrence was kept.`);
    try {
        const summary = await uploadSourcemaps({
            url,
            release: options.release,
            files,
            fetchImpl: options.fetchImpl,
            onProgress: (progress) => log(`${prefix} ${formatProgressLine(progress)}`),
        });
        log(`${prefix} uploaded ${summary.uploaded} source map${summary.uploaded === 1 ? "" : "s"} for release ${summary.release} (stored ${summary.stored}, replaced ${summary.replaced}).`);
        return summary;
    }
    catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
    }
}
export function realuptimeSourcemaps(options) {
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
