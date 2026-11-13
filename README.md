# @realuptime/errors

Zero-dependency error tracking SDK for JavaScript and Node: part of
[RealUptime Errors](https://realuptime.io/error-tracking).

This is a **mirror**. It is published from `errors-js` in the
[realuptime monorepo](https://github.com/RealUptimeHQ/realuptime) by
`scripts/publish-sdk-mirrors.mjs` and is not edited directly; open issues
and PRs against this repo, but expect source changes to land here after
they merge upstream.

## Install

Installable from the package registry (primary) or straight from this mirror's git history (e.g. to pin an exact commit).

```bash
npm install @realuptime/errors
```

```bash
# or, straight from this mirror
npm install github:RealUptimeHQ/realuptime-errors-js
```

## Usage

```js
import * as realuptimeErrors from "@realuptime/errors";

realuptimeErrors.init({
  dsn: "https://realuptime.io/api/errors/v1/ingest/rue_...", // from your project's dashboard
  release: "v2.4.1",
  environment: "production",
});

realuptimeErrors.captureException(someError);
```

WSGI/ASGI equivalents live in the Python SDK,
[realuptime-errors-py](https://github.com/RealUptimeHQ/realuptime-errors-py).

## Source maps (Vite / webpack plugins)

Upload the `.map` files a production build writes, for the release your
app reports at runtime, so minified JS frames symbolicate on the issue page.
Both plugins read the maps the bundler already wrote and POST them to your
project's source-map endpoint (authenticated by the DSN, the one secret CI
already has). They change nothing in the build output.

```js
// vite.config.js
import { realuptimeSourcemaps } from "@realuptime/errors/vite";
export default {
  build: { sourcemap: true },
  plugins: [realuptimeSourcemaps({ release: process.env.GITHUB_SHA, dsn: process.env.REALUPTIME_ERRORS_DSN })],
};

// webpack.config.js
const { RealuptimeSourcemapsPlugin } = require("@realuptime/errors/webpack");
module.exports = { devtool: "source-map", plugins: [new RealuptimeSourcemapsPlugin({ release: process.env.GITHUB_SHA })] };
```

An upload failure is logged with the server's own message and the build
still succeeds; pass `failOnError: true` to fail the build instead. With no
DSN set (local builds) the plugin logs one line and uploads nothing. Limits:
2MB per map, 50 maps per release, 10 files per request (batched for you).

## What this SDK actually does

- **Never crashes your app.** Every public function catches everything;
  a broken SDK logs once (prefixed `[realuptime-errors]`) and goes quiet.
  An error tracker that crashes the app it watches is worse than none.
- **Scrubs PII by default, client-side**, before anything serializes:
  `Authorization`/`Proxy-Authorization`/`Cookie`/`Set-Cookie` headers are
  replaced whole; card-shaped digit runs (Luhn-checked), JWTs, prefixed API
  keys, and long hex/base64 runs are pattern-scrubbed anywhere they appear
  in the message, request context, breadcrumbs, or captured source lines.
  Opt one field back in with `allowFields: ["x-request-id"]`; there is no
  global "disable scrubbing" switch, by design, and an allowed field's value
  still passes the pattern rules.
- **Never silently drops.** The in-memory buffer (200 events) evicts the
  oldest event when full, counts every eviction, and reports the count on
  the next successful batch, so drops show up on your dashboard instead of
  disappearing.
- **Zero runtime dependencies.** `dependencies` in `package.json` is
  always `{}`, enforced by `wire-contract.test.ts` in this repo, not just
  claimed in prose.

## Config (`init`)

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `dsn` | `string` | required | Your project's ingest URL, shown once at creation. Safe in client-side code: it can only submit events to that one project. |
| `release` | `string?` | none | e.g. a git SHA or version tag. |
| `environment` | `string?` | none | e.g. `"production"`. |
| `allowFields` | `string[]?` | `[]` | Lower-cased header/field names to opt back into capture. |
| `captureUnhandled` | `boolean` | `true` | Installs process/window handlers for uncaught exceptions and rejections. |

## Source and build

`index.ts`, `client.ts`, `buffer.ts`, `scrub.ts`, `custom-scrub.ts`, and
`types.ts` are the real, tested source (see the `.test.ts` files beside them). `dist/` is a
plain compile of that source (TypeScript's own compiler, no bundler, ES2022
modules, declarations included) and is what `package.json` actually points
`import`/`types` at, so a plain `npm install` plus `import` works with no
extra build step or type-stripping flag on the consumer's side.

## Version

This mirror tracks SDK_VERSION `0.6.0` in `index.ts`, the string every
event actually carries on the wire.

## Running the tests

The suite sits beside the code in this repository (Node.js 22 or newer):

```bash
npm install
npm test
```

## License

MIT, see [LICENSE](./LICENSE).
