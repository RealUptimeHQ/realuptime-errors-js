import { type SourcemapPluginOptions } from "./vite.ts";
/**
 * webpack plugin (REA-254), same core as the Vite plugin: after webpack
 * emits its assets, the `.map` files in `output.path` are uploaded to the
 * project's source-map endpoint for the given release.
 *
 *   // webpack.config.js
 *   const { RealuptimeSourcemapsPlugin } = require("@realuptime/errors/webpack");
 *   module.exports = {
 *     devtool: "source-map",
 *     plugins: [new RealuptimeSourcemapsPlugin({ release: process.env.GITHUB_SHA })],
 *   };
 *
 * Works with webpack 4 and 5 and with Rspack: it only uses
 * `compiler.hooks.afterEmit.tapPromise` and `compiler.options.output.path`,
 * both matched structurally (no "webpack" import, zero dependencies). It
 * never changes the emitted assets. Failure policy is the Vite plugin's:
 * loud log, build still succeeds, unless `failOnError: true`.
 */
interface CompilerLike {
    options?: {
        output?: {
            path?: string;
        };
        context?: string;
    };
    hooks: {
        afterEmit: {
            tapPromise(name: string, fn: () => Promise<void>): void;
        };
    };
}
export declare class RealuptimeSourcemapsPlugin {
    private readonly options;
    constructor(options: SourcemapPluginOptions);
    apply(compiler: CompilerLike): void;
}
export type { SourcemapPluginOptions };
