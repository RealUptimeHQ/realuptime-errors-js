import { type WireFeedback } from "./types.ts";
/**
 * The user feedback dialog (REA-257): a tiny, dependency-free "tell us what
 * happened" form a browser app can show after an error, posting the user's
 * words to `POST /api/errors/v1/feedback/<key>` where they attach to the
 * exact occurrence they describe.
 *
 * ## What this is deliberately NOT
 *
 *   - Not on by default. Nothing here runs unless the integrator passes
 *     `init({ feedback: {...} })` AND the project's feedback switch is on in
 *     realuptime Errors settings. Either one missing means no dialog, no
 *     ids on the wire, no endpoint accepting anything.
 *   - Not a bypass of the scrub. `comments`, `name` and `email` pass the
 *     same five pattern rules every other captured string passes, HERE,
 *     before serialization, and the server applies them again. A card
 *     number typed into "what happened" never lands in our store.
 *   - Not a tracker. No cookies, no storage, no fingerprinting; the
 *     request carries exactly the four fields in WireFeedback.
 *
 * ## CSP-friendly, on purpose
 *
 * Every style is applied through the CSSOM (`element.style.setProperty`),
 * never through a `<style>` element or a `style="..."` attribute string,
 * so a page running `style-src 'self'` (no 'unsafe-inline') renders the
 * dialog exactly the same. No inline script, no eval, no external asset.
 * Integrators who want their own look get stable class names
 * (`ru-feedback-*`) and a `theme` object; both are honored together.
 *
 * ## Accessible, on purpose
 *
 * `role="dialog"` + `aria-modal`, labelled by its title, focus moves to
 * the first field on open and back to the opener on close, Tab cycles
 * inside the dialog, Escape closes, every field has a real `<label>`, and
 * validation errors are announced through an `aria-live` region.
 *
 * Like the rest of the SDK: never throws. Every public function catches
 * everything and fails quiet.
 */
export interface ReportDialogField {
    /** Visible label. */
    label?: string;
    /** Prefilled value (e.g. the signed-in user's email). */
    value?: string;
    /** Whether the field must be filled before submit. `comments` is always
     * required; this flag is read for name and email only. */
    required?: boolean;
    /** Hide the field entirely. A hidden field is never sent. */
    hidden?: boolean;
}
export interface ReportDialogTheme {
    background: string;
    foreground: string;
    muted: string;
    border: string;
    accent: string;
    accentForeground: string;
    error: string;
    fontFamily: string;
    borderRadius: string;
    overlay: string;
}
export interface ReportDialogOptions {
    /** The event to attach to. Defaults to the last captured event's id. */
    eventId?: string;
    title?: string;
    subtitle?: string;
    submitLabel?: string;
    cancelLabel?: string;
    /** Shown (in place of the form) after a successful submit. */
    successMessage?: string;
    /** Shown when the report could not be delivered. */
    errorMessage?: string;
    fields?: {
        name?: ReportDialogField;
        email?: ReportDialogField;
        comments?: ReportDialogField;
    };
    theme?: Partial<ReportDialogTheme>;
    /** Called after a successful delivery. */
    onSubmit?: (feedback: {
        eventId: string;
    }) => void;
    /** Called whenever the dialog closes, submitted or not. */
    onClose?: () => void;
}
/** `init({ feedback })`: the integrator's standing configuration. Presence
 * of the object is the opt-in; `autoShow` additionally opens the dialog on
 * its own after an UNHANDLED browser exception. */
export interface FeedbackOptions extends Omit<ReportDialogOptions, "eventId"> {
    /** Open the dialog automatically after an unhandled window error or
     * rejection. Default false: even with feedback enabled, most apps want to
     * decide when to ask. */
    autoShow?: boolean;
}
export declare const DEFAULT_THEME: ReportDialogTheme;
export declare const DEFAULT_COPY: {
    readonly title: "It looks like something went wrong";
    readonly subtitle: "Our team has been notified. If you would like to help, tell us what happened below. Anything you type is sent to this site's error tracking.";
    readonly nameLabel: "Name";
    readonly emailLabel: "Email";
    readonly commentsLabel: "What happened?";
    readonly submitLabel: "Send report";
    readonly cancelLabel: "Close";
    readonly successMessage: "Thank you. Your report has been sent.";
    readonly errorMessage: "Your report could not be sent. Please try again.";
    readonly requiredMessage: "Please fill in the required fields.";
};
export declare const FEEDBACK_RETRY_DELAYS_MS: number[];
export interface FeedbackTransport {
    /** Resolves true on acceptance, false on a permanent refusal. Rejects
     * (or resolves false) on a transient failure after retries. */
    send(feedback: WireFeedback): Promise<boolean>;
}
export interface FeedbackDeliveryOptions {
    endpoint: string;
    sdk: string;
    fetchImpl?: typeof fetch;
    /** Test seam: resolves after a delay. */
    wait?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
}
/** Turns an ingest DSN into its feedback sibling:
 * `.../api/errors/v1/ingest/<key>` -> `.../api/errors/v1/feedback/<key>`.
 * Returns null for anything else; the caller then declines to send rather
 * than guessing a URL. */
export declare function feedbackEndpointFor(dsn: string): string | null;
/** Mints one client event id. crypto.randomUUID where it exists (every
 * modern browser and Node 19+), a getRandomValues-based v4 otherwise. */
export declare function mintEventId(): string;
export declare function isEventId(value: unknown): value is string;
/** Builds the wire message: trims, clips, SCRUBS. Pure, exported so the
 * scrub discipline on this path is testable without a DOM. Returns null
 * when there is nothing to send (no comments). */
export declare function buildFeedback(input: {
    eventId: string;
    comments: string;
    name?: string;
    email?: string;
}, sdk: string): WireFeedback | null;
/**
 * Delivery for one report. A report is a human's one-off, not a stream, so
 * this is simpler than the event Transport: a few short retries on a
 * transient failure (network, 5xx, and a 404 `event_not_found`, which is
 * the event batch still in flight ahead of the report), then give up and
 * tell the dialog so it can say so. Any other 4xx is final.
 */
export declare function createFeedbackTransport(options: FeedbackDeliveryOptions): FeedbackTransport;
export interface DialogDeps {
    document: Document;
    transport: FeedbackTransport;
    sdk: string;
    /** Resolves when the event batch carrying `eventId` has been attempted,
     * so the report rarely arrives ahead of its event. */
    beforeSend?: () => Promise<void>;
    log?: (message: string) => void;
}
export interface ReportDialogHandle {
    close(): void;
    readonly element: HTMLElement;
}
/** Whether a dialog is currently open (one at a time, by design). */
export declare function isReportDialogOpen(): boolean;
/** Closes the open dialog, if any. Called by the SDK's `close()`. */
export declare function closeReportDialog(): void;
/**
 * Renders the dialog into `document.body` and returns a handle. This is
 * the DOM half; `showReportDialog` in index.ts wires it to the SDK state.
 * Exported so the jsdom tests can drive it directly.
 */
export declare function openReportDialog(options: ReportDialogOptions & {
    eventId: string;
}, deps: DialogDeps): ReportDialogHandle | null;
