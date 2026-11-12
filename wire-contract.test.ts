import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SDK_VERSION } from "./index.ts";
import {
  ERROR_LEVELS,
  HARD_MAX_MAP_ENTRIES,
  MAX_BREADCRUMB_DATA_ENTRIES,
  MAX_BREADCRUMBS_PER_EVENT,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_ENTRIES,
  MAX_CONTEXT_KEY_LENGTH,
  MAX_EVENTS_PER_BATCH,
  MAX_FRAMES_PER_EVENT,
  MAX_LOCAL_VAR_LENGTH,
  MAX_LOCAL_VARS_PER_FRAME,
  MAX_MESSAGE_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TAGS_PER_EVENT,
  type WireBatch,
  type WireBreadcrumb,
  type WireDevice,
  type WireEvent,
  type WireFeedback,
  MAX_FEEDBACK_BODY_BYTES,
  MAX_FEEDBACK_COMMENTS_LENGTH,
  MAX_FEEDBACK_EMAIL_LENGTH,
  MAX_FEEDBACK_NAME_LENGTH,
  type WireFrame,
  type WireUser,
} from "./types.ts";

/**
 * Pins the wire contract and the dependency discipline, the
 * apps/agent/wire-contract.test.ts convention: the types are DUPLICATED
 * from the server side rather than imported (see types.ts's header), so
 * drift is caught here by name-for-name field pinning, and the zero-dep
 * promise is enforced as a test rather than trusted.
 */

const SOURCE_FILES = ["types.ts", "scrub.ts", "buffer.ts", "client.ts", "index.ts", "feedback.ts"];

describe("dependency hygiene", () => {
  it("has no runtime dependencies at all", () => {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    // jsdom is test-only (feedback.test.ts drives the report dialog in a
    // DOM); the mirror script copies neither devDependencies nor that test.
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "jsdom", "typescript", "vitest"]);
  });

  it("never imports another workspace package", () => {
    for (const file of SOURCE_FILES) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1];
        expect(
          specifier.startsWith("./") || specifier.startsWith("node:"),
          `${file} imports "${specifier}" -- this SDK ships into customer bundles and must stay dependency-free`,
        ).toBe(true);
      }
    }
  });
});

describe("wire contract pinning (mirrored by packages/db/error-ingest.ts)", () => {
  it("pins the batch and event field names", () => {
    const frame: Required<WireFrame> = {
      file: "f",
      function: "g",
      line: 1,
      inApp: true,
      column: 10,
      contextLine: "x",
      preContext: [],
      postContext: [],
      vars: {},
    };
    const breadcrumb: Required<WireBreadcrumb> = {
      timestamp: "2026-08-21T00:00:00.000Z",
      category: "http",
      message: "GET /",
      data: {},
    };
    const event: WireEvent = {
      occurredAt: "2026-08-21T00:00:00.000Z",
      message: "m",
      exceptionType: null,
      release: null,
      environment: null,
      frames: [frame],
      request: { method: "GET", path: "/", status: 200, headers: {} },
      fingerprint: null,
      breadcrumbs: [breadcrumb],
      breadcrumbsDropped: 0,
    };
    const batch: WireBatch = { sdk: "realuptime-errors-js/0.2.0", droppedClient: 0, events: [event] };

    expect(Object.keys(batch).sort()).toEqual(["droppedClient", "events", "sdk"]);
    expect(Object.keys(event).sort()).toEqual([
      "breadcrumbs",
      "breadcrumbsDropped",
      "environment",
      "exceptionType",
      "fingerprint",
      "frames",
      "message",
      "occurredAt",
      "release",
      "request",
    ]);
    expect(Object.keys(frame).sort()).toEqual([
      "column",
      "contextLine",
      "file",
      "function",
      "inApp",
      "line",
      "postContext",
      "preContext",
      "vars",
    ]);
    expect(Object.keys(breadcrumb).sort()).toEqual(["category", "data", "message", "timestamp"]);
  });

  it("pins the v2 field names (REA-182)", () => {
    const user: Required<WireUser> = { id: "acct_1", email: null, username: null };
    const device: Required<WireDevice> = {
      runtime: "node",
      runtimeVersion: "22.4.0",
      platform: "linux",
      arch: "arm64",
    };
    const event: Required<WireEvent> = {
      occurredAt: "2026-08-22T00:00:00.000Z",
      message: "m",
      exceptionType: null,
      release: null,
      environment: null,
      frames: null,
      request: { method: "GET", path: "/", route: "/", status: 200, headers: {} },
      fingerprint: null,
      breadcrumbs: null,
      breadcrumbsDropped: 0,
      user,
      tags: {},
      context: {},
      device,
      eventId: "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b",
      level: "fatal",
    };
    expect(Object.keys(user).sort()).toEqual(["email", "id", "username"]);
    expect(Object.keys(device).sort()).toEqual(["arch", "platform", "runtime", "runtimeVersion"]);
    expect(Object.keys(event).sort()).toEqual([
      "breadcrumbs",
      "breadcrumbsDropped",
      "context",
      "device",
      "environment",
      "eventId",
      "exceptionType",
      "fingerprint",
      "frames",
      "level",
      "message",
      "occurredAt",
      "release",
      "request",
      "tags",
      "user",
    ]);
  });

  it("pins the level enum (REA-569)", () => {
    expect(ERROR_LEVELS).toEqual(["fatal", "error", "warning", "info", "debug"]);
  });

  it("keeps every v2 field OPTIONAL, so a v1 event still satisfies the contract", () => {
    // The additive guarantee expressed as a type assertion: this object has
    // the exact v1 key set and nothing more, and it must still be a
    // WireEvent. If any v2 field ever becomes required, this stops
    // compiling -- which is the point.
    const v1Event: WireEvent = {
      occurredAt: "2026-08-21T00:00:00.000Z",
      message: "m",
      exceptionType: null,
      release: null,
      environment: null,
      frames: null,
      request: null,
      fingerprint: null,
      breadcrumbs: null,
      breadcrumbsDropped: 0,
    };
    expect(Object.keys(v1Event)).toHaveLength(10);
  });

  it("pins the limits the server mirrors", () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(50);
    expect(MAX_MESSAGE_LENGTH).toBe(4000);
    expect(MAX_FRAMES_PER_EVENT).toBe(50);
    expect(MAX_STRING_LENGTH).toBe(512);
    expect(MAX_BREADCRUMBS_PER_EVENT).toBe(20);
    expect(MAX_BREADCRUMB_DATA_ENTRIES).toBe(10);
  });

  it("pins the v2 caps the server mirrors (REA-182)", () => {
    expect(MAX_TAGS_PER_EVENT).toBe(20);
    expect(MAX_CONTEXT_ENTRIES).toBe(20);
    expect(MAX_CONTEXT_KEY_LENGTH).toBe(64);
    expect(MAX_LOCAL_VARS_PER_FRAME).toBe(20);
    expect(MAX_LOCAL_VAR_LENGTH).toBe(256);
    expect(MAX_CONTEXT_BYTES).toBe(4096);
    expect(HARD_MAX_MAP_ENTRIES).toBe(200);
  });

  it("pins the feedback message shape and caps the server mirrors (REA-257)", () => {
    const feedback: Required<WireFeedback> = {
      eventId: "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b",
      comments: "c",
      name: "n",
      email: "e",
      sdk: `realuptime-errors-js/${SDK_VERSION}`,
    };
    expect(Object.keys(feedback).sort()).toEqual(["comments", "email", "eventId", "name", "sdk"]);
    expect(MAX_FEEDBACK_COMMENTS_LENGTH).toBe(4000);
    expect(MAX_FEEDBACK_NAME_LENGTH).toBe(200);
    expect(MAX_FEEDBACK_EMAIL_LENGTH).toBe(254);
    expect(MAX_FEEDBACK_BODY_BYTES).toBe(16_384);
  });
});
