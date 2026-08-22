import { describe, expect, it } from "vitest";
import vectors from "./scrub-vectors.json";
import { scrubEvent } from "./scrub.ts";
import type { WireEvent } from "./types.ts";

/**
 * Drives the SHARED scrub vectors (scrub-vectors.json) through this SDK's
 * implementation. The same file drives packages/errors-py's tests and
 * packages/db/error-scrub.test.ts; parity across the three is the point,
 * so this test must never grow expectations of its own -- new behavior
 * gets a new vector, which the other two suites pick up automatically.
 */

interface Vector {
  name: string;
  allowFields?: string[];
  event: Partial<WireEvent>;
  expected: Partial<WireEvent>;
}

const BASE: WireEvent = {
  occurredAt: "2026-08-21T00:00:00.000Z",
  message: "",
  exceptionType: null,
  release: null,
  environment: null,
  frames: null,
  request: null,
  fingerprint: null,
  breadcrumbs: null,
  breadcrumbsDropped: 0,
};

describe("scrub vectors (shared with the Python SDK and the server)", () => {
  it("has enough vectors to mean something", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(15);
  });

  for (const vector of vectors.vectors as Vector[]) {
    it(vector.name, () => {
      const input = { ...BASE, ...vector.event } as WireEvent;
      const output = scrubEvent(input, vector.allowFields ?? []);
      const expected = { ...BASE, ...vector.expected } as WireEvent;
      expect(output).toEqual(expected);
    });
  }

  it("never mutates the input event", () => {
    const input = {
      ...BASE,
      message: "sk_live_abcdefgh12345678",
      request: { method: "GET", path: "/x", status: 500, headers: { cookie: "sid=1" } },
    } as WireEvent;
    const snapshot = JSON.parse(JSON.stringify(input));
    scrubEvent(input);
    expect(input).toEqual(snapshot);
  });
});
