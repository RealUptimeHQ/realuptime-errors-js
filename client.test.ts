import { describe, expect, it, vi } from "vitest";
import { BUFFER_MAX, EventBuffer } from "./buffer.ts";
import { BACKOFF_START_MS, Transport } from "./client.ts";
import { addBreadcrumb, captureException, close, flush, init, parseStack } from "./index.ts";
import type { WireBatch, WireEvent } from "./types.ts";

function event(message: string): WireEvent {
  return {
    occurredAt: "2026-08-21T00:00:00.000Z",
    message,
    exceptionType: null,
    release: null,
    environment: null,
    frames: null,
    request: null,
    fingerprint: null,
    breadcrumbs: null,
    breadcrumbsDropped: 0,
  };
}

function okResponse(body: unknown = { accepted: 1, droppedOverQuota: 0, overQuota: false, quota: { used: 1, limit: 10_000, resetsAt: "2026-09-01T00:00:00.000Z" } }): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("EventBuffer", () => {
  it("drops oldest when full and counts every drop for the next report", () => {
    const buffer = new EventBuffer();
    for (let i = 0; i < BUFFER_MAX + 7; i++) buffer.push(event(`e${i}`));
    expect(buffer.length).toBe(BUFFER_MAX);
    expect(buffer.peekBatch(1)[0].message).toBe("e7");
    expect(buffer.takeDropped()).toBe(7);
    expect(buffer.takeDropped()).toBe(0);
  });

  it("peek does not remove; commit does", () => {
    const buffer = new EventBuffer();
    buffer.push(event("a"));
    buffer.push(event("b"));
    expect(buffer.peekBatch(2)).toHaveLength(2);
    expect(buffer.length).toBe(2);
    buffer.commit(1);
    expect(buffer.peekBatch(2)[0].message).toBe("b");
  });
});

describe("Transport", () => {
  it("reports client-side drops on the next successful batch", async () => {
    const batches: WireBatch[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(init?.body as string));
      return okResponse();
    });
    const transport = new Transport({ endpoint: "https://x/ingest/rue_a", sdk: "t/1", fetchImpl: fetchImpl as unknown as typeof fetch, log: () => {} });
    for (let i = 0; i < BUFFER_MAX + 3; i++) {
      // Push directly through enqueue; deliveries interleave but every drop
      // must surface in some batch's droppedClient.
      transport.enqueue(event(`e${i}`));
    }
    await transport.flush();
    const totalDropped = batches.reduce((sum, b) => sum + b.droppedClient, 0);
    const totalSent = batches.reduce((sum, b) => sum + b.events.length, 0);
    expect(totalDropped + totalSent).toBe(BUFFER_MAX + 3);
    expect(totalDropped).toBeGreaterThan(0);
  });

  it("pauses until the reset instant on an over-quota refusal and never retries into the cap", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "quota", reason: "over_quota", resetsAt: "2026-09-01T00:00:00.000Z" }), { status: 429 });
    });
    let nowMs = Date.parse("2026-08-21T00:00:00.000Z");
    const transport = new Transport({ endpoint: "https://x/i/rue_a", sdk: "t/1", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowMs, log: () => {} });
    transport.enqueue(event("a"));
    await transport.flush();
    expect(calls).toBe(1);
    transport.enqueue(event("b"));
    await transport.flush();
    expect(calls).toBe(1); // paused: no second request inside the window
    nowMs = Date.parse("2026-09-01T00:00:01.000Z");
    transport.enqueue(event("c"));
    await transport.flush();
    expect(calls).toBe(2); // window reset: delivery resumes
  });

  it("disables itself for the process lifetime on a revoked key, logging once", async () => {
    const logs: string[] = [];
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "revoked", reason: "key_revoked" }), { status: 403 });
    });
    const transport = new Transport({ endpoint: "https://x/i/rue_a", sdk: "t/1", fetchImpl: fetchImpl as unknown as typeof fetch, log: (m) => logs.push(m) });
    transport.enqueue(event("a"));
    await transport.flush();
    transport.enqueue(event("b"));
    await transport.flush();
    expect(calls).toBe(1);
    expect(logs.filter((l) => l.includes("revoked"))).toHaveLength(1);
  });

  it("backs off on network failure and keeps the events", async () => {
    let nowMs = 0;
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNREFUSED");
      return okResponse();
    });
    const transport = new Transport({ endpoint: "https://x/i/rue_a", sdk: "t/1", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => nowMs, log: () => {} });
    transport.enqueue(event("a"));
    await transport.flush();
    expect(calls).toBe(1);
    await transport.flush();
    expect(calls).toBe(1); // still inside backoff
    nowMs = BACKOFF_START_MS + 1;
    await transport.flush();
    expect(calls).toBe(2); // retried the SAME event
    const secondCall = fetchImpl.mock.calls[1] as unknown as [unknown, RequestInit];
    const body = JSON.parse(secondCall[1].body as string) as WireBatch;
    expect(body.events[0].message).toBe("a");
  });
});

describe("breadcrumbs (Phase 3)", () => {
  it("rides the next event, newest last, and reports ring evictions honestly", async () => {
    const batches: WireBatch[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      batches.push(JSON.parse(init?.body as string) as WireBatch);
      return okResponse();
    });
    init({ dsn: "https://x/i/rue_a", captureUnhandled: false, log: () => {}, fetchImpl: fetchImpl as unknown as typeof fetch });

    // 25 breadcrumbs into a 20-slot ring: 5 evicted, and the count says so.
    for (let i = 0; i < 25; i++) addBreadcrumb({ message: `step ${i}`, category: "test" });
    addBreadcrumb({ message: "charging", data: { card: "4242424242424242", order: "ord-1" } });
    captureException(new Error("boom"));
    await flush();
    close();

    const event = batches[0].events[0];
    expect(event.breadcrumbs).toHaveLength(20);
    // 26 recorded, 20 kept -> 6 evictions reported, never silent.
    expect(event.breadcrumbsDropped).toBe(6);
    const last = event.breadcrumbs?.[event.breadcrumbs.length - 1];
    expect(last?.message).toBe("charging");
    // Scrubbed on the way out: the card never leaves the process.
    expect(last?.data?.card).toBe("[scrubbed]");
    expect(last?.data?.order).toBe("ord-1");
    // Oldest six (steps 0-5) fell off; the trail starts at step 6.
    expect(event.breadcrumbs?.[0].message).toBe("step 6");
  });

  it("is a safe no-op before init", () => {
    close();
    expect(() => addBreadcrumb({ message: "x" })).not.toThrow();
  });
});

describe("public API never throws", () => {
  it("captureException before init is a no-op", () => {
    close();
    expect(() => captureException(new Error("x"))).not.toThrow();
  });

  it("init with a broken fetch never lets a failure escape", async () => {
    init({
      dsn: "https://x/i/rue_a",
      captureUnhandled: false,
      log: () => {},
      fetchImpl: (() => {
        throw new Error("fetch exploded synchronously");
      }) as unknown as typeof fetch,
    });
    expect(() => captureException(new Error("boom"))).not.toThrow();
    close();
  });
});

describe("parseStack", () => {
  it("parses V8 frames and flags node_modules as not in-app", () => {
    const stack = [
      "TypeError: x is undefined",
      "    at processOrder (/app/src/checkout.ts:42:13)",
      "    at run (/app/node_modules/lib/index.js:10:5)",
      "    at node:internal/process/task_queues:96:5",
    ].join("\n");
    const frames = parseStack(stack);
    expect(frames).not.toBeNull();
    expect(frames?.[0]).toEqual({
      file: "/app/src/checkout.ts",
      function: "processOrder",
      line: 42,
      // Kept since Phase 3: source-map symbolication needs the column.
      column: 13,
      inApp: true,
    });
    expect(frames?.[1].inApp).toBe(false);
    expect(frames?.[1].column).toBe(5);
  });

  it("returns null for a stackless capture", () => {
    expect(parseStack(undefined)).toBeNull();
    expect(parseStack("no frames here")).toBeNull();
  });
});
