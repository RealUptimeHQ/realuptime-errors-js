import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_BREADCRUMB_DATA_ENTRIES,
  MAX_BREADCRUMBS_PER_EVENT,
  MAX_EVENTS_PER_BATCH,
  MAX_FRAMES_PER_EVENT,
  MAX_MESSAGE_LENGTH,
  MAX_STRING_LENGTH,
  type WireBatch,
  type WireBreadcrumb,
  type WireEvent,
  type WireFrame,
} from "./types.ts";

/**
 * Pins the wire contract and the dependency discipline, the
 * apps/agent/wire-contract.test.ts convention: the types are DUPLICATED
 * from the server side rather than imported (see types.ts's header), so
 * drift is caught here by name-for-name field pinning, and the zero-dep
 * promise is enforced as a test rather than trusted.
 */

const SOURCE_FILES = ["types.ts", "scrub.ts", "buffer.ts", "client.ts", "index.ts"];

describe("dependency hygiene", () => {
  it("has no runtime dependencies at all", () => {
    const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies).sort()).toEqual(["@types/node", "typescript", "vitest"]);
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
    ]);
    expect(Object.keys(breadcrumb).sort()).toEqual(["category", "data", "message", "timestamp"]);
  });

  it("pins the limits the server mirrors", () => {
    expect(MAX_EVENTS_PER_BATCH).toBe(50);
    expect(MAX_MESSAGE_LENGTH).toBe(4000);
    expect(MAX_FRAMES_PER_EVENT).toBe(50);
    expect(MAX_STRING_LENGTH).toBe(512);
    expect(MAX_BREADCRUMBS_PER_EVENT).toBe(20);
    expect(MAX_BREADCRUMB_DATA_ENTRIES).toBe(10);
  });
});
