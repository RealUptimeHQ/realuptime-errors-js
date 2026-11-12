import { scrubString } from "./scrub.js";
import { MAX_FEEDBACK_COMMENTS_LENGTH, MAX_FEEDBACK_EMAIL_LENGTH, MAX_FEEDBACK_NAME_LENGTH, } from "./types.js";
export const DEFAULT_THEME = {
    background: "#ffffff",
    foreground: "#111827",
    muted: "#6b7280",
    border: "#d1d5db",
    accent: "#095dce",
    accentForeground: "#ffffff",
    error: "#b91c1c",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
    borderRadius: "10px",
    overlay: "rgba(17, 24, 39, 0.55)",
};
export const DEFAULT_COPY = {
    title: "It looks like something went wrong",
    subtitle: "Our team has been notified. If you would like to help, tell us what happened below. Anything you type is sent to this site's error tracking.",
    nameLabel: "Name",
    emailLabel: "Email",
    commentsLabel: "What happened?",
    submitLabel: "Send report",
    cancelLabel: "Close",
    successMessage: "Thank you. Your report has been sent.",
    errorMessage: "Your report could not be sent. Please try again.",
    requiredMessage: "Please fill in the required fields.",
};
export const FEEDBACK_RETRY_DELAYS_MS = [1000, 2000, 4000];
/** Turns an ingest DSN into its feedback sibling:
 * `.../api/errors/v1/ingest/<key>` -> `.../api/errors/v1/feedback/<key>`.
 * Returns null for anything else; the caller then declines to send rather
 * than guessing a URL. */
export function feedbackEndpointFor(dsn) {
    const marker = "/api/errors/v1/ingest/";
    const at = dsn.indexOf(marker);
    if (at < 0)
        return null;
    const key = dsn.slice(at + marker.length).replace(/[?#].*$/, "");
    if (!key)
        return null;
    return `${dsn.slice(0, at)}/api/errors/v1/feedback/${key}`;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mints one client event id. crypto.randomUUID where it exists (every
 * modern browser and Node 19+), a getRandomValues-based v4 otherwise. */
export function mintEventId() {
    const c = globalThis.crypto;
    try {
        if (c && typeof c.randomUUID === "function")
            return c.randomUUID();
        if (c && typeof c.getRandomValues === "function") {
            const bytes = new Uint8Array(16);
            c.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
    }
    catch {
        // fall through
    }
    // No CSPRNG at all (an exotic embedded runtime): a weak id is still a
    // usable correlation key, and this branch never runs in a browser.
    let hex = "";
    while (hex.length < 32)
        hex += Math.floor(Math.random() * 16).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function isEventId(value) {
    return typeof value === "string" && UUID_RE.test(value);
}
function clip(value, max) {
    return value.length > max ? value.slice(0, max) : value;
}
/** Builds the wire message: trims, clips, SCRUBS. Pure, exported so the
 * scrub discipline on this path is testable without a DOM. Returns null
 * when there is nothing to send (no comments). */
export function buildFeedback(input, sdk) {
    const comments = scrubString(clip(input.comments.trim(), MAX_FEEDBACK_COMMENTS_LENGTH));
    if (!comments)
        return null;
    const out = { eventId: input.eventId, comments, sdk };
    const name = input.name?.trim();
    if (name)
        out.name = scrubString(clip(name, MAX_FEEDBACK_NAME_LENGTH));
    const email = input.email?.trim();
    if (email)
        out.email = scrubString(clip(email, MAX_FEEDBACK_EMAIL_LENGTH));
    return out;
}
const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Delivery for one report. A report is a human's one-off, not a stream, so
 * this is simpler than the event Transport: a few short retries on a
 * transient failure (network, 5xx, and a 404 `event_not_found`, which is
 * the event batch still in flight ahead of the report), then give up and
 * tell the dialog so it can say so. Any other 4xx is final.
 */
export function createFeedbackTransport(options) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const wait = options.wait ?? defaultWait;
    const log = options.log ?? ((message) => console.error(message));
    let logged = false;
    const logOnce = (message) => {
        if (logged)
            return;
        logged = true;
        log(`[realuptime-errors] ${message}`);
    };
    return {
        async send(feedback) {
            for (let attempt = 0;; attempt++) {
                let response = null;
                try {
                    response = await fetchImpl(options.endpoint, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify(feedback),
                        signal: AbortSignal.timeout(10_000),
                    });
                }
                catch {
                    response = null;
                }
                if (response?.ok)
                    return true;
                let reason;
                if (response) {
                    try {
                        reason = (await response.json()).reason;
                    }
                    catch {
                        reason = undefined;
                    }
                }
                const transient = response === null ||
                    response.status >= 500 ||
                    response.status === 429 ||
                    (response.status === 404 && reason === "event_not_found");
                if (!transient) {
                    if (reason === "feedback_disabled") {
                        logOnce("user feedback is switched off for this project in realuptime Errors settings; the report was not sent. Turn it on there, or remove init({ feedback }).");
                    }
                    else if (reason === "key_revoked") {
                        logOnce("this project's ingest key was revoked; feedback was not sent.");
                    }
                    return false;
                }
                if (attempt >= FEEDBACK_RETRY_DELAYS_MS.length)
                    return false;
                await wait(FEEDBACK_RETRY_DELAYS_MS[attempt]);
            }
        },
    };
}
let openDialog = null;
/** Whether a dialog is currently open (one at a time, by design). */
export function isReportDialogOpen() {
    return openDialog !== null;
}
/** Closes the open dialog, if any. Called by the SDK's `close()`. */
export function closeReportDialog() {
    openDialog?.close();
}
function styles(el, decl) {
    for (const [prop, value] of Object.entries(decl))
        el.style.setProperty(prop, value);
}
/**
 * Renders the dialog into `document.body` and returns a handle. This is
 * the DOM half; `showReportDialog` in index.ts wires it to the SDK state.
 * Exported so the jsdom tests can drive it directly.
 */
export function openReportDialog(options, deps) {
    const doc = deps.document;
    if (!doc?.body)
        return null;
    if (openDialog)
        return openDialog;
    const theme = { ...DEFAULT_THEME, ...(options.theme ?? {}) };
    const fields = options.fields ?? {};
    const opener = doc.activeElement;
    const uid = `ru-feedback-${Math.random().toString(36).slice(2, 8)}`;
    const overlay = doc.createElement("div");
    overlay.className = "ru-feedback-overlay";
    styles(overlay, {
        position: "fixed",
        inset: "0",
        background: theme.overlay,
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        "z-index": "2147483000",
        padding: "16px",
        "box-sizing": "border-box",
    });
    const dialog = doc.createElement("div");
    dialog.className = "ru-feedback-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", `${uid}-title`);
    dialog.setAttribute("aria-describedby", `${uid}-subtitle`);
    styles(dialog, {
        background: theme.background,
        color: theme.foreground,
        "font-family": theme.fontFamily,
        "font-size": "15px",
        "line-height": "1.45",
        "border-radius": theme.borderRadius,
        border: `1px solid ${theme.border}`,
        "box-shadow": "0 20px 50px rgba(0,0,0,0.25)",
        width: "100%",
        "max-width": "440px",
        "max-height": "100%",
        overflow: "auto",
        padding: "22px",
        "box-sizing": "border-box",
    });
    const title = doc.createElement("h2");
    title.id = `${uid}-title`;
    title.className = "ru-feedback-title";
    title.textContent = options.title ?? DEFAULT_COPY.title;
    styles(title, { margin: "0 0 6px", "font-size": "18px", "font-weight": "600" });
    const subtitle = doc.createElement("p");
    subtitle.id = `${uid}-subtitle`;
    subtitle.className = "ru-feedback-subtitle";
    subtitle.textContent = options.subtitle ?? DEFAULT_COPY.subtitle;
    styles(subtitle, { margin: "0 0 16px", color: theme.muted, "font-size": "14px" });
    const form = doc.createElement("form");
    form.className = "ru-feedback-form";
    form.setAttribute("novalidate", "");
    const live = doc.createElement("p");
    live.className = "ru-feedback-status";
    live.setAttribute("role", "status");
    live.setAttribute("aria-live", "polite");
    styles(live, { margin: "0 0 10px", "min-height": "1.2em", color: theme.error, "font-size": "14px" });
    const inputs = {};
    function field(key, labelText, spec, kind, type = "text") {
        if (spec?.hidden)
            return;
        const wrap = doc.createElement("div");
        wrap.className = `ru-feedback-field ru-feedback-field-${key}`;
        styles(wrap, { margin: "0 0 12px" });
        const label = doc.createElement("label");
        label.htmlFor = `${uid}-${key}`;
        label.className = "ru-feedback-label";
        const required = key === "comments" || Boolean(spec?.required);
        label.textContent = `${spec?.label ?? labelText}${required ? "" : " (optional)"}`;
        styles(label, { display: "block", "font-size": "13px", "font-weight": "600", margin: "0 0 4px" });
        const control = doc.createElement(kind);
        control.id = `${uid}-${key}`;
        control.name = key;
        control.className = "ru-feedback-input";
        if (kind === "input")
            control.type = type;
        if (kind === "textarea")
            control.rows = 4;
        if (key === "email")
            control.setAttribute("autocomplete", "email");
        if (key === "name")
            control.setAttribute("autocomplete", "name");
        control.maxLength =
            key === "comments" ? MAX_FEEDBACK_COMMENTS_LENGTH : key === "name" ? MAX_FEEDBACK_NAME_LENGTH : MAX_FEEDBACK_EMAIL_LENGTH;
        if (required)
            control.setAttribute("aria-required", "true");
        if (spec?.value)
            control.value = spec.value;
        styles(control, {
            display: "block",
            width: "100%",
            "box-sizing": "border-box",
            padding: "8px 10px",
            font: "inherit",
            color: theme.foreground,
            background: theme.background,
            border: `1px solid ${theme.border}`,
            "border-radius": "6px",
            resize: kind === "textarea" ? "vertical" : "none",
        });
        wrap.appendChild(label);
        wrap.appendChild(control);
        form.appendChild(wrap);
        inputs[key] = control;
    }
    field("name", DEFAULT_COPY.nameLabel, fields.name, "input", "text");
    field("email", DEFAULT_COPY.emailLabel, fields.email, "input", "email");
    field("comments", DEFAULT_COPY.commentsLabel, fields.comments, "textarea");
    const actions = doc.createElement("div");
    actions.className = "ru-feedback-actions";
    styles(actions, { display: "flex", gap: "8px", "justify-content": "flex-end", "flex-wrap": "wrap" });
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "ru-feedback-cancel";
    cancel.textContent = options.cancelLabel ?? DEFAULT_COPY.cancelLabel;
    styles(cancel, {
        font: "inherit",
        padding: "8px 14px",
        "border-radius": "6px",
        border: `1px solid ${theme.border}`,
        background: "transparent",
        color: theme.foreground,
        cursor: "pointer",
    });
    const submit = doc.createElement("button");
    submit.type = "submit";
    submit.className = "ru-feedback-submit";
    submit.textContent = options.submitLabel ?? DEFAULT_COPY.submitLabel;
    styles(submit, {
        font: "inherit",
        padding: "8px 14px",
        "border-radius": "6px",
        border: `1px solid ${theme.accent}`,
        background: theme.accent,
        color: theme.accentForeground,
        cursor: "pointer",
    });
    actions.appendChild(cancel);
    actions.appendChild(submit);
    form.appendChild(live);
    form.appendChild(actions);
    dialog.appendChild(title);
    dialog.appendChild(subtitle);
    dialog.appendChild(form);
    overlay.appendChild(dialog);
    let closed = false;
    const handle = {
        element: overlay,
        close() {
            if (closed)
                return;
            closed = true;
            try {
                doc.removeEventListener("keydown", onKeydown, true);
                overlay.remove();
            }
            catch {
                // never throws
            }
            if (openDialog === handle)
                openDialog = null;
            try {
                opener?.focus?.();
            }
            catch {
                // never throws
            }
            try {
                options.onClose?.();
            }
            catch {
                // integrator callback; never ours to throw
            }
        },
    };
    function focusables() {
        return Array.from(dialog.querySelectorAll("input, textarea, button, [tabindex]:not([tabindex='-1'])")).filter((el) => !el.hasAttribute("disabled"));
    }
    function onKeydown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            handle.close();
            return;
        }
        if (event.key === "Tab") {
            const list = focusables();
            if (list.length === 0)
                return;
            const first = list[0];
            const last = list[list.length - 1];
            const active = doc.activeElement;
            if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }
    cancel.addEventListener("click", () => handle.close());
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay)
            handle.close();
    });
    doc.addEventListener("keydown", onKeydown, true);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        void (async () => {
            try {
                const comments = inputs.comments?.value ?? "";
                const name = inputs.name?.value ?? "";
                const email = inputs.email?.value ?? "";
                const missing = !comments.trim() ||
                    (fields.name?.required && !name.trim()) ||
                    (fields.email?.required && !email.trim());
                if (missing) {
                    live.textContent = DEFAULT_COPY.requiredMessage;
                    (inputs.comments ?? inputs.name ?? inputs.email)?.focus();
                    return;
                }
                const feedback = buildFeedback({ eventId: options.eventId, comments, name, email }, deps.sdk);
                if (!feedback) {
                    live.textContent = DEFAULT_COPY.requiredMessage;
                    return;
                }
                submit.disabled = true;
                cancel.disabled = true;
                live.textContent = "";
                try {
                    await deps.beforeSend?.();
                }
                catch {
                    // the event flush's failure is its own problem; still try
                }
                const ok = await deps.transport.send(feedback);
                if (ok) {
                    form.remove();
                    subtitle.textContent = options.successMessage ?? DEFAULT_COPY.successMessage;
                    subtitle.setAttribute("role", "status");
                    styles(subtitle, { color: theme.foreground });
                    const done = doc.createElement("button");
                    done.type = "button";
                    done.className = "ru-feedback-done";
                    done.textContent = options.cancelLabel ?? DEFAULT_COPY.cancelLabel;
                    styles(done, {
                        font: "inherit",
                        padding: "8px 14px",
                        "border-radius": "6px",
                        border: `1px solid ${theme.accent}`,
                        background: theme.accent,
                        color: theme.accentForeground,
                        cursor: "pointer",
                    });
                    done.addEventListener("click", () => handle.close());
                    dialog.appendChild(done);
                    done.focus();
                    try {
                        options.onSubmit?.({ eventId: options.eventId });
                    }
                    catch {
                        // integrator callback
                    }
                }
                else {
                    submit.disabled = false;
                    cancel.disabled = false;
                    live.textContent = options.errorMessage ?? DEFAULT_COPY.errorMessage;
                }
            }
            catch (failure) {
                try {
                    deps.log?.(`[realuptime-errors] feedback dialog failed: ${String(failure)}`);
                }
                catch {
                    // never throws
                }
            }
        })();
    });
    doc.body.appendChild(overlay);
    openDialog = handle;
    (inputs.name ?? inputs.email ?? inputs.comments)?.focus();
    return handle;
}
