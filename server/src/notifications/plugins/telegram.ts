import {
  PLUGIN_TIMEOUT_MS,
  SEVERITY_EMOJI,
  escapeHtml,
  payloadFacts,
  testPayload,
  type NotificationPlugin,
} from '../types';

/**
 * telegram — Bot API `sendMessage`, HTML parse mode.
 *
 * HTML rather than Markdown deliberately: Telegram's MarkdownV2 requires
 * escaping eighteen different characters, and a ticket subject containing a
 * bare `-` or `.` (which is most of them) makes the API reject the message.
 * HTML needs three escapes and `escapeHtml` handles all of them.
 *
 * The API caps a message at 4096 characters and returns 400 above it, so the
 * body is clamped rather than trusted.
 */
const MAX_MESSAGE = 4000;

export const telegramPlugin: NotificationPlugin = {
  type: 'telegram',
  name: 'Telegram',
  description: 'Send a message to a Telegram chat or channel through a bot.',
  supportsRichFormat: false,
  configFields: [
    {
      key: 'botToken',
      label: 'Bot token',
      type: 'password',
      required: true,
      secret: true,
      placeholder: '123456:ABC-DEF…',
    },
    {
      key: 'chatId',
      label: 'Chat ID',
      type: 'text',
      required: true,
      placeholder: '-1001234567890',
      hint: 'Negative for groups and channels; positive for a direct chat.',
    },
    {
      key: 'silent',
      label: 'Send silently',
      type: 'boolean',
      hint: 'Delivers without a notification sound. Useful for informational channels.',
    },
  ],

  async send(config, payload) {
    const lines: string[] = [
      `${SEVERITY_EMOJI[payload.severity]} <b>${escapeHtml(payload.title)}</b>`,
      '',
      escapeHtml(payload.body),
    ];

    const facts = payloadFacts(payload);
    if (facts.length > 0) {
      lines.push('');
      for (const fact of facts) {
        lines.push(`<b>${escapeHtml(fact.label)}:</b> ${escapeHtml(fact.value)}`);
      }
    }

    if (payload.url) {
      lines.push('', `<a href="${escapeHtml(payload.url)}">Open in ${escapeHtml(payload.appName)}</a>`);
    }

    let text = lines.join('\n');
    if (text.length > MAX_MESSAGE) text = `${text.slice(0, MAX_MESSAGE - 1)}…`;

    const response = await fetch(
      `https://api.telegram.org/bot${String(config.botToken)}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          disable_notification: Boolean(config.silent),
        }),
        signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Never echo the URL — it contains the bot token, and an error string
      // ends up in `notification_log.error`, which admins can read.
      throw new Error(`Telegram returned ${response.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
    }
  },

  async sendTest(config) {
    await telegramPlugin.send(config, testPayload());
  },
};

export default telegramPlugin;
