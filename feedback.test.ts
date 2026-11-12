// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFeedback,
  createFeedbackTransport,
  feedbackEndpointFor,
  isEventId,
  isReportDialogOpen,
  mintEventId,
} from "./feedback.ts";
import {
  captureException,
  captureMessage,
  close,
  flush,
  init,
  lastEventId,
  SDK_VERSION,
  showReportDialog,
} from "./index.ts";
import type { WireBatch, WireFeedback } from "./types.ts";

/**
 * The user feedback dialog (REA-257), driven in jsdom. What this proves:
 *
 *   1. OPT-IN: no `feedback` in init means no event ids on the wire, no
 *      lastEventId, and showReportDialog is a logged no-op. The id-less v1
 *      payload is still what an untouched integration sends.
 *   2. With feedback enabled, events carry a UUID `eventId`, capture returns
 *      it, and the dialog posts `{eventId, comments, name?, email?, sdk}` to
 *      the DSN's `/feedback/<key>` sibling.
 *   3. SCRUB: what the user typed passes the pattern rules before it is
 *      serialized (a card number in "what happened" never leaves the page).
 *   4. Accessible + CSP-friendly: role=dialog, labelled, focus moves in and
 *      back out, Escape closes, and not one `style=` attribute or `<style>`
 *      element is written (all styling goes through the CSSOM).
 *   5. Auto-show runs ONLY when asked, and only after an unhandled error.
 */

const DSN = "https://realuptime.io/api/errors/v1/ingest/rue_0123456789abcdef0123456789abcdef";
const OK = () =>
  new Response(
    JSON.stringify({
      accepted: 1,
      droppedOverQuota: 0,
      overQuota: false,
      quota: { used: 1, limit: 10_000, resetsAt: "2026-09-01T00:00:00.000Z" },
    }),
    { status: 200 },
  );

function setup(feedback?: Record<string, unknown>, log = vi.fn()) {
  const posts: { url: string; body: unknown }[] = [];
  init({
    dsn: DSN,
    sendDeviceInfo: false,
    captureUnhandled: true,
    ...(feedback ? { feedback } : {}),
    log,
    fetchImpl: vi.fn(async (url: string, opts: { body: string }) => {
      posts.push({ url, body: JSON.parse(opts.body) });
      return url.includes("/feedback/")
        ? new Response(JSON.stringify({ accepted: true }), { status: 202 })
        : OK();
    }) as unknown as typeof fetch,
  });
  return { posts, log };
}

afterEach(() => {
  close();
  document.body.innerHTML = "";
});

describe("feedback is opt-in", () => {
  it("an integration without feedback emits no eventId and cannot open the dialog", async () => {
    const { posts, log } = setup();
    const id = captureMessage("boom");
    await flush();
    expect(id).toBeNull();
    expect(lastEventId()).toBeNull();
    const batch = posts[0].body as WireBatch;
    expect("eventId" in batch.events[0]).toBe(false);
    expect(showReportDialog()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("feedback is not enabled"));
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("with feedback enabled, events carry a UUID eventId and capture returns it", async () => {
    const { posts } = setup({});
    const id = captureException(new Error("boom"));
    await flush();
    expect(isEventId(id)).toBe(true);
    expect(lastEventId()).toBe(id);
    const batch = posts[0].body as WireBatch;
    expect(batch.events[0].eventId).toBe(id);
  });

  it("derives the feedback endpoint from the DSN and nothing else", () => {
    expect(feedbackEndpointFor(DSN)).toBe(
      "https://realuptime.io/api/errors/v1/feedback/rue_0123456789abcdef0123456789abcdef",
    );
    expect(feedbackEndpointFor("https://example.com/not-a-dsn")).toBeNull();
  });

  it("mints RFC 4122 v4 ids", () => {
    const id = mintEventId();
    expect(isEventId(id)).toBe(true);
    expect(id[14]).toBe("4");
  });
});

describe("buildFeedback scrubs before serialization", () => {
  it("runs the pattern rules over comments, name and email, and clips", () => {
    const out = buildFeedback(
      {
        eventId: "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b",
        comments: "I paid with 4242 4242 4242 4242 and it failed; token sk_live_abcdefghijklmnop",
        name: " Alice ",
        email: "alice@example.com",
      },
      `realuptime-errors-js/${SDK_VERSION}`,
    );
    expect(out).toEqual({
      eventId: "0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b",
      comments: "I paid with [scrubbed] and it failed; token [scrubbed]",
      name: "Alice",
      email: "alice@example.com",
      sdk: `realuptime-errors-js/${SDK_VERSION}`,
    });
  });

  it("returns null with nothing to say, and omits empty optional fields", () => {
    expect(buildFeedback({ eventId: "x", comments: "   " }, "s")).toBeNull();
    const out = buildFeedback({ eventId: "x", comments: "c", name: "", email: " " }, "s");
    expect(Object.keys(out ?? {}).sort()).toEqual(["comments", "eventId", "sdk"]);
  });

  it("clips comments to the cap", () => {
    const out = buildFeedback({ eventId: "x", comments: "word ".repeat(1000) }, "s");
    expect(out?.comments.length).toBeLessThanOrEqual(4000);
    expect(out?.comments.length).toBeGreaterThan(3990);
  });
});

describe("the dialog", () => {
  it("renders accessibly, posts the scrubbed report, and never writes inline styles", async () => {
    const { posts } = setup({});
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    // CSP: styling must go through the CSSOM, never a `style="..."` string
    // (which a `style-src` policy without 'unsafe-inline' refuses) and
    // never a <style> element.
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    const id = captureException(new Error("boom")) as string;
    const onSubmit = vi.fn();
    const handle = showReportDialog({
      onSubmit,
      fields: { email: { value: "alice@example.com" } },
    });
    expect(handle).not.toBeNull();
    expect(isReportDialogOpen()).toBe(true);

    const dialog = document.querySelector<HTMLElement>("[role=dialog]");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog?.getAttribute("aria-labelledby");
    expect(document.getElementById(titleId ?? "")?.textContent).toContain("something went wrong");
    // Every control has a label.
    for (const control of document.querySelectorAll<HTMLElement>("input, textarea")) {
      expect(document.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
    }
    // Focus moved into the dialog.
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(setAttribute.mock.calls.some(([name]) => String(name).toLowerCase() === "style")).toBe(
      false,
    );
    expect(document.querySelectorAll("style").length).toBe(0);
    // ...but the CSSOM was used.
    expect(dialog?.style.getPropertyValue("background")).not.toBe("");
    setAttribute.mockRestore();

    const comments = document.querySelector<HTMLTextAreaElement>("textarea[name=comments]");
    const email = document.querySelector<HTMLInputElement>("input[name=email]");
    expect(email?.value).toBe("alice@example.com");
    if (!comments) throw new Error("no comments field");
    comments.value = "clicked pay, card 4242424242424242, spinner forever";
    document.querySelector<HTMLFormElement>("form.ru-feedback-form")?.requestSubmit();
    await vi.waitFor(() => expect(posts.some((p) => p.url.includes("/feedback/"))).toBe(true));

    const post = posts.find((p) => p.url.includes("/feedback/"));
    expect(post?.url).toBe(
      "https://realuptime.io/api/errors/v1/feedback/rue_0123456789abcdef0123456789abcdef",
    );
    const body = post?.body as WireFeedback;
    expect(body).toEqual({
      eventId: id,
      comments: "clicked pay, card [scrubbed], spinner forever",
      email: "alice@example.com",
      sdk: `realuptime-errors-js/${SDK_VERSION}`,
    });
    // The event batch was flushed BEFORE the report (beforeSend), so the
    // report never outruns its event on the wire.
    expect(posts.findIndex((p) => p.url.includes("/ingest/"))).toBeLessThan(
      posts.findIndex((p) => p.url.includes("/feedback/")),
    );

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ eventId: id }));
    expect(document.querySelector("form.ru-feedback-form")).toBeNull();
    expect(document.querySelector(".ru-feedback-subtitle")?.textContent).toContain("Thank you");

    document.querySelector<HTMLButtonElement>(".ru-feedback-done")?.click();
    expect(isReportDialogOpen()).toBe(false);
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("refuses to submit without comments and says so in the live region", async () => {
    const { posts } = setup({});
    captureException(new Error("boom"));
    showReportDialog();
    document.querySelector<HTMLFormElement>("form.ru-feedback-form")?.requestSubmit();
    await vi.waitFor(() =>
      expect(document.querySelector("[role=status]")?.textContent).toContain("required"),
    );
    expect(posts.some((p) => p.url.includes("/feedback/"))).toBe(false);
  });

  it("Escape closes; only one dialog opens at a time; hidden fields are not rendered", () => {
    setup({ fields: { name: { hidden: true } } });
    captureException(new Error("boom"));
    const first = showReportDialog();
    expect(first).not.toBeNull();
    expect(showReportDialog()).toBeNull();
    expect(document.querySelectorAll("[role=dialog]").length).toBe(1);
    expect(document.querySelector("input[name=name]")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(isReportDialogOpen()).toBe(false);
  });

  it("honors theme and copy overrides", () => {
    setup({ title: "Oops", submitLabel: "Send it", theme: { accent: "rgb(1, 2, 3)" } });
    captureException(new Error("boom"));
    showReportDialog();
    expect(document.querySelector(".ru-feedback-title")?.textContent).toBe("Oops");
    expect(document.querySelector<HTMLButtonElement>(".ru-feedback-submit")?.textContent).toBe(
      "Send it",
    );
    expect(
      document
        .querySelector<HTMLButtonElement>(".ru-feedback-submit")
        ?.style.getPropertyValue("background"),
    ).toBe("rgb(1, 2, 3)");
  });

  it("shows the error copy and re-enables the form when delivery fails for good", async () => {
    const log = vi.fn();
    const posts: string[] = [];
    init({
      dsn: DSN,
      sendDeviceInfo: false,
      feedback: {},
      log,
      fetchImpl: vi.fn(async (url: string) => {
        posts.push(url);
        if (url.includes("/feedback/")) {
          return new Response(JSON.stringify({ error: "off", reason: "feedback_disabled" }), {
            status: 403,
          });
        }
        return OK();
      }) as unknown as typeof fetch,
    });
    captureException(new Error("boom"));
    showReportDialog();
    const comments = document.querySelector<HTMLTextAreaElement>("textarea[name=comments]");
    if (comments) comments.value = "it broke";
    document.querySelector<HTMLFormElement>("form.ru-feedback-form")?.requestSubmit();
    await vi.waitFor(() =>
      expect(document.querySelector("[role=status]")?.textContent).toContain("could not be sent"),
    );
    expect(document.querySelector<HTMLButtonElement>(".ru-feedback-submit")?.disabled).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("switched off for this project"));
  });
});

describe("auto-show", () => {
  it("opens after an unhandled window error only when autoShow is set", async () => {
    // jsdom re-reports a dispatched ErrorEvent to the harness as an uncaught
    // exception; swallow it for this test only.
    const swallow = (event: Event) => event.preventDefault();
    window.addEventListener("error", swallow);
    try {
      const { posts } = setup({});
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new Error("unhandled"),
          message: "unhandled",
          cancelable: true,
        }),
      );
      await flush();
      // The window handler captured it (ids are minted: feedback is on)...
      expect((posts[0]?.body as WireBatch)?.events[0]?.eventId).toBeDefined();
      // ...but did not open anything, because autoShow was not asked for.
      expect(document.querySelector("[role=dialog]")).toBeNull();
      close();

      setup({ autoShow: true });
      window.dispatchEvent(
        new ErrorEvent("error", {
          error: new Error("unhandled"),
          message: "unhandled",
          cancelable: true,
        }),
      );
      expect(document.querySelector("[role=dialog]")).not.toBeNull();
    } finally {
      window.removeEventListener("error", swallow);
    }
    // A manual capture does not auto-show; that is the integrator's call.
    close();
    document.body.innerHTML = "";
    setup({ autoShow: true });
    captureException(new Error("handled"));
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});

describe("the feedback transport", () => {
  it("retries event_not_found and 5xx a few times, then gives up; other 4xx are final", async () => {
    const statuses = [404, 500, 202];
    let calls = 0;
    const transport = createFeedbackTransport({
      endpoint: "https://x/api/errors/v1/feedback/rue_x",
      sdk: "s",
      wait: async () => {},
      fetchImpl: vi.fn(async () => {
        const status = statuses[calls++];
        return new Response(JSON.stringify(status === 404 ? { reason: "event_not_found" } : {}), {
          status,
        });
      }) as unknown as typeof fetch,
    });
    expect(await transport.send({ eventId: "e", comments: "c", sdk: "s" })).toBe(true);
    expect(calls).toBe(3);

    let finalCalls = 0;
    const final = createFeedbackTransport({
      endpoint: "https://x/api/errors/v1/feedback/rue_x",
      sdk: "s",
      wait: async () => {},
      fetchImpl: vi.fn(async () => {
        finalCalls++;
        return new Response(JSON.stringify({ reason: "malformed" }), { status: 400 });
      }) as unknown as typeof fetch,
    });
    expect(await final.send({ eventId: "e", comments: "c", sdk: "s" })).toBe(false);
    expect(finalCalls).toBe(1);
  });
});
