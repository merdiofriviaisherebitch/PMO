// Notifier port (CLAUDE.md §11, §12, §20 C3).
//
// The escalation engine depends on this INTERFACE, never on Resend directly.
// Adapters:
//   * ResendNotifier   — real email (now).
//   * InMemoryNotifier — tests (assert what was sent without touching Resend).
//   * (Phase 8)        — a Teams/Graph adapter is added behind this same port;
//                        the engine and the Edge Function need no change.

export type NotifyMessage = {
  to: string
  subject: string
  body: string
}

export type NotifyResult = { ok: true } | { ok: false; error: string }

export interface Notifier {
  send(message: NotifyMessage): Promise<NotifyResult>
}

// ── Resend adapter (real email) ──────────────────────────────────────────────
export class ResendNotifier implements Notifier {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: NotifyMessage): Promise<NotifyResult> {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: message.to,
          subject: message.subject,
          text: message.body,
        }),
      })
      if (!res.ok) {
        const detail = await res.text()
        return { ok: false, error: `resend ${res.status}: ${detail.slice(0, 500)}` }
      }
      return { ok: true }
    } catch (e) {
      // A transport failure is still a failure to record — never swallowed (§6).
      return {
        ok: false,
        error: `resend transport error: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
}

// ── In-memory adapter (tests) ────────────────────────────────────────────────
export class InMemoryNotifier implements Notifier {
  readonly sent: NotifyMessage[] = []
  /** Optional predicate to simulate a delivery failure for specific messages. */
  failWhen?: (message: NotifyMessage) => boolean

  // deno-lint-ignore require-await
  async send(message: NotifyMessage): Promise<NotifyResult> {
    if (this.failWhen?.(message)) {
      return { ok: false, error: "simulated failure" }
    }
    this.sent.push(message)
    return { ok: true }
  }
}
