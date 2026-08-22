# @realuptime/errors

Zero-dependency error tracking SDK for JavaScript and Node: part of
[RealUptime Errors](https://realuptime.io/error-tracking).

This is a **mirror**. It is published from `packages/errors-js` in the
[realuptime monorepo](https://github.com/RealUptimeHQ/realuptime) by
`scripts/publish-sdk-mirrors.mjs` and is not edited directly; open issues
and PRs against this repo, but expect source changes to land here after
they merge upstream.

## Install

Installs straight from GitHub today. npm and PyPI packages are coming; this note disappears the day they ship.

```bash
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

## Version

This mirror tracks SDK_VERSION `0.2.0` in `index.ts`, the string every
event actually carries on the wire.

## License

MIT, see [LICENSE](./LICENSE).
