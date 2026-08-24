import { resolve } from "node:path";
import { runSourcemapUpload } from "./vite.js";
export class RealuptimeSourcemapsPlugin {
    options;
    constructor(options) {
        this.options = options;
    }
    apply(compiler) {
        compiler.hooks.afterEmit.tapPromise("RealuptimeSourcemapsPlugin", async () => {
            const context = compiler.options?.context ?? process.cwd();
            const dir = this.options.dir ? resolve(context, this.options.dir) : (compiler.options?.output?.path ?? resolve(context, "dist"));
            await runSourcemapUpload(this.options, dir, "webpack");
        });
    }
}
