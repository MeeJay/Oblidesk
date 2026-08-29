import nodemailer from 'nodemailer';
import {
  SEVERITY_EMOJI,
  SEVERITY_HEX,
  escapeHtml,
  payloadFacts,
  testPayload,
  type NotificationPayload,
  type NotificationPlugin,
} from '../types';

/**
 * smtp — outbound e-mail through a configured SMTP server.
 *
 * The channel stores an `smtpServerId`, never credentials: the host, port, TLS
 * flag, username and (decrypted) password are injected by
 * `notificationService.resolveChannelConfig()` before `send()` runs. That keeps
 * one copy of every credential in `smtp_servers`, encrypted at rest, instead of
 * a copy per channel that nobody remembers to rotate.
 *
 * Threading: when the notification service supplies `messageId` /
 * `inReplyTo` / `references` (it does for ticket correspondence), they are set
 * as real headers so the requester's reply lands back on the SAME ticket
 * instead of opening a second one. An e-mail notification without threading
 * headers is how a desk ends up with four tickets for one conversation.
 */

interface ResolvedSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  password?: string | null;
  from: string;
  fromName?: string | null;
  to: string;
  replyTo?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string | string[] | null;
}

function renderHtml(payload: NotificationPayload): string {
  if (payload.bodyHtml) return payload.bodyHtml;

  const accent = SEVERITY_HEX[payload.severity];
  const facts = payloadFacts(payload);

  const factRows = facts
    .map(
      (fact) =>
        `<tr>` +
        `<td style="padding:4px 12px 4px 0;color:#6b7280;font-size:13px;white-space:nowrap">${escapeHtml(fact.label)}</td>` +
        `<td style="padding:4px 0;color:#111827;font-size:13px">${escapeHtml(fact.value)}</td>` +
        `</tr>`,
    )
    .join('');

  // Inline styles only, and a table for the fact list: every mail client that
  // matters still strips <style> blocks and mangles flexbox.
  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px">`,
    `<div style="border-left:4px solid ${accent};padding-left:12px;margin-bottom:16px">`,
    `<h2 style="margin:0 0 4px;font-size:18px;color:#111827">${escapeHtml(payload.title)}</h2>`,
    `<div style="font-size:12px;color:#6b7280">${escapeHtml(payload.appName)} · ${escapeHtml(payload.tenantName)}</div>`,
    `</div>`,
    `<div style="font-size:14px;color:#111827;line-height:1.6;white-space:pre-wrap">${escapeHtml(payload.body)}</div>`,
    factRows ? `<table style="margin-top:16px;border-collapse:collapse">${factRows}</table>` : '',
    payload.url
      ? `<p style="margin-top:20px"><a href="${escapeHtml(payload.url)}" style="background:${accent};color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;display:inline-block">Open in ${escapeHtml(payload.appName)}</a></p>`
      : '',
    `<p style="margin-top:24px;font-size:11px;color:#9ca3af">${escapeHtml(payload.occurredAt)}</p>`,
    `</div>`,
  ]
    .filter(Boolean)
    .join('');
}

function renderText(payload: NotificationPayload): string {
  const facts = payloadFacts(payload);
  return [
    payload.title,
    '',
    payload.body,
    facts.length > 0 ? '' : null,
    ...facts.map((fact) => `${fact.label}: ${fact.value}`),
    payload.url ? '' : null,
    payload.url ? `Open: ${payload.url}` : null,
    '',
    `${payload.appName} · ${payload.tenantName} · ${payload.occurredAt}`,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export const smtpPlugin: NotificationPlugin = {
  type: 'smtp',
  name: 'Email (SMTP)',
  description: 'Send an e-mail through one of the configured SMTP servers.',
  supportsRichFormat: true,
  configFields: [
    {
      key: 'smtpServerId',
      label: 'SMTP server',
      type: 'smtp_server_select',
      required: true,
      hint: 'Credentials live in Admin → SMTP servers, encrypted at rest.',
    },
    {
      key: 'to',
      label: 'Recipients',
      type: 'text',
      required: true,
      placeholder: 'desk@example.com, oncall@example.com',
      hint: 'Comma-separated. Templates addressed to the requester override this.',
    },
    {
      key: 'fromOverride',
      label: 'From address override',
      type: 'text',
      placeholder: 'Leave blank to use the server default',
    },
    {
      key: 'replyTo',
      label: 'Reply-To',
      type: 'text',
      placeholder: 'support@example.com',
      hint: 'Point this at the ticket mailbox so replies come back to the desk.',
    },
  ],

  async send(rawConfig, payload) {
    const config = rawConfig as unknown as ResolvedSmtpConfig;

    if (!config.host) {
      throw new Error('smtp: no server resolved — is smtpServerId still pointing at a live server?');
    }

    const to = payload.to ?? config.to;
    if (!to) throw new Error('smtp: no recipient (neither payload.to nor channel config.to)');

    const transport = nodemailer.createTransport({
      host: config.host,
      port: Number(config.port),
      secure: Boolean(config.secure),
      auth: config.username
        ? { user: String(config.username), pass: String(config.password ?? '') }
        : undefined,
    });

    const from = config.fromName
      ? `"${String(config.fromName).replace(/"/g, '')}" <${config.from}>`
      : config.from;

    await transport.sendMail({
      from,
      to,
      replyTo: config.replyTo ?? undefined,
      subject: `${SEVERITY_EMOJI[payload.severity]} ${payload.title}`,
      text: renderText(payload),
      html: renderHtml(payload),
      // Threading — see the header comment. Omitted keys are simply not sent.
      messageId: config.messageId ?? undefined,
      inReplyTo: config.inReplyTo ?? undefined,
      references: config.references ?? undefined,
      headers: {
        'X-Oblidesk-Event': payload.event,
        'X-Oblidesk-Tenant': payload.tenantSlug,
        // Lets a requester's mail client (and our own IMAP intake) recognise an
        // automated message and not bounce-loop on it.
        'Auto-Submitted': 'auto-generated',
      },
    });
  },

  async sendTest(config) {
    await smtpPlugin.send(config, testPayload());
  },
};

export default smtpPlugin;
