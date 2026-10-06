/**
 * GAP-30 — SocketLabs chosen as the email provider (client decision,
 * 2026-09-24, sending domain qosfc.com). Talks to SocketLabs' Injection API
 * (HTTP, not SMTP — the same shape as every other live adapter here) to send
 * transactional email.
 *
 * The port hands this adapter an opaque `memberRef`, not an address — T-9.5:
 * personal data belongs to whatever fetches it immediately before use, never
 * persisted into Temporal history. This adapter is what resolves it, looking
 * the member up in Postgres at send time, which is why it (uniquely among
 * this package's adapters) takes a `Pool`.
 *
 * Only 'email' is implemented — 'sms' | 'post' | 'via_agent' are rejected
 * outright rather than silently dropped, and an unrecognised templateId is
 * rejected rather than sent as blank content (same honesty convention as
 * `ThirdPartyCardPortalGateway`: refuse rather than pretend).
 *
 * `fetchDeliveryEvents` is NOT wired: bounce/complaint data needs either
 * SocketLabs' separate Reporting API (different credentials from the
 * Injection API key this adapter holds) or a webhook receiver, neither of
 * which exists yet. It refuses explicitly rather than returning an empty
 * list, which would silently read as "nothing bounced" instead of "not built".
 */
import type { Pool } from '@qosfc/db';
import {
  PermanentProviderError,
  TransientProviderError,
  type DeliveryOutcome,
  type Notifier,
  type NotificationRequest,
} from '@qosfc/ports';

const PROVIDER = 'live:socketlabs';
const INJECTION_URL = 'https://inject.socketlabs.com/api/v1/email';

export interface SocketLabsConfig {
  readonly serverId: string;
  readonly apiKey: string;
  readonly fromEmail: string;
  readonly fromName?: string | undefined;
  readonly timeoutMs?: number;
}

interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Content lives here, in version control, rather than in SocketLabs' hosted
 * template feature — a template change is then a reviewable diff like any
 * other, and nothing about sending depends on SocketLabs' dashboard state.
 */
const TEMPLATES: Readonly<Record<string, (mergeData: Readonly<Record<string, string>>) => RenderedEmail>> = {
  welcome_signup: (m) => {
    const forename = m['forename']?.trim() || 'there';
    return {
      subject: 'Welcome to the QOSFC Lottery',
      text:
        `Hi ${forename},\n\n` +
        `Your QOSFC Lottery account is set up. Log in any time to pick your numbers, check draw results, and manage your entries.\n\n` +
        `Good luck!\nQOSFC`,
      html:
        `<p>Hi ${escapeHtml(forename)},</p>` +
        `<p>Your QOSFC Lottery account is set up. Log in any time to pick your numbers, check draw results, and manage your entries.</p>` +
        `<p>Good luck!<br>QOSFC</p>`,
    };
  },
  password_reset: (m) => {
    const forename = m['forename']?.trim() || 'there';
    const resetUrl = m['resetUrl'] ?? '';
    return {
      subject: 'Reset your QOSFC Lottery password',
      text:
        `Hi ${forename},\n\n` +
        `We received a request to reset your QOSFC Lottery password. Use the link below within the next hour:\n\n` +
        `${resetUrl}\n\n` +
        `If you didn't ask for this, you can safely ignore this email — your password will not change.\n\nQOSFC`,
      html:
        `<p>Hi ${escapeHtml(forename)},</p>` +
        `<p>We received a request to reset your QOSFC Lottery password. Use the link below within the next hour:</p>` +
        `<p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p>` +
        `<p>If you didn't ask for this, you can safely ignore this email — your password will not change.</p><p>QOSFC</p>`,
    };
  },
  entry_confirmation: (m) => {
    const forename = m['forename']?.trim() || 'there';
    const numbers = m['numbers'] ?? '';
    const amount = m['amount'] ?? '';
    // What was done with the purchase (more weeks on existing numbers, or an
    // extra entry, and any Direct Debit pause) — the same words the member saw.
    const summary = m['summary'] ?? '';
    return {
      subject: `Payment received — your numbers ${numbers}`,
      text: `Hi ${forename},

Thanks — we've received your payment of ${amount} for the numbers ${numbers}.

${summary}

Good luck!
QOSFC`,
      html:
        `<p>Hi ${escapeHtml(forename)},</p>` +
        `<p>Thanks — we've received your payment of <b>${escapeHtml(amount)}</b> for the numbers <b>${escapeHtml(numbers)}</b>.</p>` +
        `<p>${escapeHtml(summary)}</p>` +
        `<p>Good luck!<br>QOSFC</p>`,
    };
  },
  // GAP-13: numbers picked at random for a member who chose none within a week.
  numbers_allocated: (m) => {
    const forename = m['forename']?.trim() || 'there';
    const lines = m['lines'] ?? '';
    return {
      subject: 'Your QOSFC Lottery numbers',
      text:
        `Hi ${forename},\n\n` +
        `You hadn't chosen your lottery numbers, so we've picked them for you at random using RANDOM.ORG: ${lines}.\n\n` +
        `These stay the same in every draw you're entered in. If you'd like different numbers, just get in touch with us.\n\n` +
        `Good luck!\nQOSFC`,
      html:
        `<p>Hi ${escapeHtml(forename)},</p>` +
        `<p>You hadn't chosen your lottery numbers, so we've picked them for you at random using RANDOM.ORG: <b>${escapeHtml(lines)}</b>.</p>` +
        `<p>These stay the same in every draw you're entered in. If you'd like different numbers, just get in touch with us.</p>` +
        `<p>Good luck!<br>QOSFC</p>`,
    };
  },
  draw_winner: (m) => {
    const forename = m['forename']?.trim() || 'there';
    const drawNumber = m['drawNumber'] ?? '';
    const amount = m['amount'] ?? '';
    return {
      subject: `You won! Draw ${drawNumber}`,
      text:
        `Hi ${forename},\n\n` +
        `Congratulations — your numbers came up in Draw ${drawNumber}! You've won ${amount}.\n\n` +
        `We'll be in touch about getting this to you. Thanks for playing, and well done!\n\nQOSFC`,
      html:
        `<p>Hi ${escapeHtml(forename)},</p>` +
        `<p>Congratulations — your numbers came up in Draw ${escapeHtml(drawNumber)}! You've won <b>${escapeHtml(amount)}</b>.</p>` +
        `<p>We'll be in touch about getting this to you. Thanks for playing, and well done!</p><p>QOSFC</p>`,
    };
  },
};

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface SocketLabsMessageResult {
  readonly Index: number;
  readonly ErrorCode: string;
}

/**
 * `ErrorCode` is "Success" only when every message in the request was
 * accepted; "Warning" (still HTTP 200) means at least one message has a
 * per-message error in `MessageResults` — e.g. an unparseable recipient
 * address or a missing subject. There is no per-message id: `MessageResults`
 * can come back an empty array even on a fully successful send, so
 * `TransactionReceipt` (present on every response) is the only stable
 * provider reference.
 */
interface SocketLabsSendResponse {
  readonly ErrorCode: string;
  readonly TransactionReceipt?: string;
  readonly MessageResults?: readonly SocketLabsMessageResult[] | null;
}

export class SocketLabsNotifier implements Notifier {
  readonly providerName = PROVIDER;
  private readonly timeoutMs: number;

  constructor(private readonly pool: Pool, private readonly config: SocketLabsConfig) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async send(request: NotificationRequest): Promise<DeliveryOutcome> {
    if (request.channel !== 'email') {
      return {
        status: 'rejected',
        reasonCode: 'unsupported_channel',
        reason: `${PROVIDER} only sends email; got channel "${request.channel}".`,
      };
    }

    const template = TEMPLATES[request.templateId];
    if (!template) {
      return {
        status: 'rejected',
        reasonCode: 'unknown_template',
        reason: `No template registered for templateId "${request.templateId}".`,
      };
    }

    const { rows } = await this.pool.query<{ email: string | null; forename: string | null }>(
      `SELECT email, forename FROM member WHERE id = $1`,
      [request.memberRef],
    );
    const member = rows[0];
    if (!member?.email) {
      return { status: 'rejected', reasonCode: 'no_email_on_file', reason: 'Member has no email address on file.' };
    }

    const { subject, html, text } = template({ forename: member.forename ?? '', ...request.mergeData });

    const payload = await this.postMessage({
      serverId: Number(this.config.serverId),
      messages: [
        {
          to: [{ emailAddress: member.email }],
          from: { emailAddress: this.config.fromEmail, friendlyName: this.config.fromName },
          subject,
          htmlBody: html,
          textBody: text,
          customHeaders: [{ name: 'X-Idempotency-Key', value: request.idempotencyKey }],
        },
      ],
    });

    if (payload.ErrorCode !== 'Success') {
      const reasonCode = payload.MessageResults?.[0]?.ErrorCode ?? payload.ErrorCode;
      return { status: 'rejected', reasonCode, reason: `SocketLabs did not accept the message (${reasonCode}).` };
    }

    return { status: 'accepted', providerRef: payload.TransactionReceipt ?? request.idempotencyKey };
  }

  private async postMessage(body: unknown): Promise<SocketLabsSendResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(INJECTION_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // SocketLabs decommissioned the old apiKey-in-body Injection API
          // auth in favour of a bearer-token API key with granular
          // permissions (client note, 2026-09-24) — the injection permission
          // on this key is what authorises sending here.
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();

      if (res.status >= 500 || res.status === 429) {
        throw new TransientProviderError(`${res.status} ${res.statusText}: ${raw.slice(0, 300)}`, PROVIDER);
      }
      if (!res.ok) {
        // 401/403/400 here mean the request or credentials are wrong, not that
        // the recipient declined — that is a config problem, never worth retrying.
        throw new PermanentProviderError(`${res.status} ${res.statusText}: ${raw.slice(0, 300)}`, PROVIDER, `http_${res.status}`);
      }
      return raw ? (JSON.parse(raw) as SocketLabsSendResponse) : { ErrorCode: 'Unknown' };
    } catch (error) {
      if (error instanceof PermanentProviderError || error instanceof TransientProviderError) throw error;
      // Timeouts, DNS failures, connection resets — all worth another attempt.
      throw new TransientProviderError(error instanceof Error ? error.message : String(error), PROVIDER, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  fetchDeliveryEvents(
    _since: string,
  ): Promise<readonly { readonly providerRef: string; readonly status: 'delivered' | 'bounced' | 'complained'; readonly at: string }[]> {
    throw new Error(
      `${PROVIDER}: fetchDeliveryEvents() has no data source — SocketLabs' Reporting API needs separate ` +
        'credentials from the Injection API key this adapter holds, and no webhook receiver exists yet. ' +
        'Wire one of those, then implement this.',
    );
  }
}
