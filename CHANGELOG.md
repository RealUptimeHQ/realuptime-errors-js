# Changelog

## 0.5.0 (2026-11-08)

### Features

* Scrubbing: a case-insensitive key-name denylist (password, secret, token, api key, authorization, credential, private key, access key, session) is applied to tags, context, device, request headers, breadcrumb data and frame locals before the pattern scrub. Matching is by whole camelCase or snake_case segment, so "tokenizer" is not caught.
* Scrubbing: new pattern rules for AWS access key ids, Stripe webhook signing secrets and credentials in URL userinfo (the host stays readable).
* A `beforeSend` filter that fails closed, used to keep customer personal data out of RealUptime's own telemetry.
* New DSNs name the dedicated intake host, `ingest.realuptime.io`. DSNs already issued keep working.

### Bug Fixes

* The default `fetch` is bound, which fixes "Illegal invocation" in browsers.
* Source-map uploads from a DSN on the intake host go to `realuptime.io`, the host that serves the upload route, instead of getting a 404.

## 0.4.0 (2026-08-24)

First published release.

### Features

* Error capture with bounded buffering and honest drop counters, no runtime dependencies.
* Scrub-by-default for sensitive values before an event leaves the process.
* Wire contract v2: identity, tags, context and device fields.
* Breadcrumbs, custom fingerprints, and Express and Next.js adapters.
* Source-map upload core, with Vite and webpack plugins.
* An opt-in user feedback dialog attached to events, scrubbed like any other event.
* Additive-only custom scrub rules served for the project.
