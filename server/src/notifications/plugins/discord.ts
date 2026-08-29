import {
  PLUGIN_TIMEOUT_MS,
  SEVERITY_EMOJI,
  SEVERITY_INT,
  payloadFacts,
  testPayload,
  type NotificationPlugin,
} from '../types';

/**
 * discord — channel webhook, one embed per notification.
 *
 * Discord's embed limits are hard failures, not truncations: 25 fields, 1024
 * characters per field value, 4096 for the description. Exceeding any of them
 * returns 400 and the message is lost. Everything below is clamped rather than
 * trusted, because the desk generates these strings from tenant data we do not
 * control (a ticket subject can be 512 characters; a body can be an entire
 * email).
 */
const MAX_FIELDS = 25;
const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;
const MAX_TITLE = 256;

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export const discordPlugin: NotificationPlugin = {
  type: 'discord',
  name: 'Discord',
  description: 'Post an embed to a Discord channel through a webhook.',
  supportsRichFormat: true,
  configFields: [
    {
      key: 'webhookUrl',
      label: 'Discord webhook URL',
      type: 'url',
      required: true,
      secret: true,
      placeholder: 'https://discord.com/api/webhooks/…',
    },
    {
      key: 'username',
      label: 'Bot display name',
      type: 'text',
      placeholder: 'Oblidesk',
    },
  ],

  async send(config, payload) {
    const facts = payloadFacts(payload).slice(0, MAX_FIELDS);

    const embed: Record<string, unknown> = {
      title: clamp(`${SEVERITY_EMOJI[payload.severity]} ${payload.title}`, MAX_TITLE),
      description: clamp(payload.body, MAX_DESCRIPTION),
      color: SEVERITY_INT[payload.severity],
      fields: facts.map((fact) => ({
        name: clamp(fact.label, 256),
        // Discord rejects an empty field value outright — an em dash keeps the
        // row visible instead of losing the whole message to a 400.
        value: clamp(fact.value || '—', MAX_FIELD_VALUE),
        inline: true,
      })),
      timestamp: payload.occurredAt,
      footer: { text: clamp(`${payload.appName} · ${payload.tenantName}`, 2048) },
    };

    if (payload.url) embed.url = payload.url;

    const body: Record<string, unknown> = { embeds: [embed] };
    if (config.username) body.username = String(config.username);

    const response = await fetch(String(config.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Discord returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
  },

  async sendTest(config) {
    await discordPlugin.send(config, testPayload());
  },
};

export default discordPlugin;
