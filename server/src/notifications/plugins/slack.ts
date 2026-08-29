import {
  PLUGIN_TIMEOUT_MS,
  SEVERITY_EMOJI,
  SEVERITY_HEX,
  payloadFacts,
  testPayload,
  type NotificationPlugin,
} from '../types';

/**
 * slack — Incoming Webhook, Block Kit body with a colour rail.
 *
 * The attachment wrapper exists purely for the coloured left border: Block Kit
 * alone has no colour, and on a busy channel the rail is what lets someone tell
 * a breach from an acknowledgement without reading a word.
 */
export const slackPlugin: NotificationPlugin = {
  type: 'slack',
  name: 'Slack',
  description: 'Post to a Slack channel through an Incoming Webhook.',
  supportsRichFormat: true,
  configFields: [
    {
      key: 'webhookUrl',
      label: 'Slack webhook URL',
      type: 'url',
      required: true,
      secret: true,
      placeholder: 'https://hooks.slack.com/services/…',
    },
    {
      key: 'channel',
      label: 'Channel override',
      type: 'text',
      placeholder: '#service-desk',
      hint: 'Optional. Most workspaces pin the channel to the webhook itself.',
    },
    {
      key: 'username',
      label: 'Bot display name',
      type: 'text',
      placeholder: 'Oblidesk',
    },
  ],

  async send(config, payload) {
    const emoji = SEVERITY_EMOJI[payload.severity];
    const facts = payloadFacts(payload);

    const blocks: Array<Record<string, unknown>> = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${payload.title}*\n${payload.body}`,
        },
      },
    ];

    if (facts.length > 0) {
      // Slack caps a `fields` array at 10 entries and silently drops the rest —
      // slice explicitly so the truncation is ours and predictable.
      blocks.push({
        type: 'section',
        fields: facts.slice(0, 10).map((fact) => ({
          type: 'mrkdwn',
          text: `*${fact.label}*\n${fact.value}`,
        })),
      });
    }

    if (payload.url) {
      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open in Oblidesk' },
            url: payload.url,
          },
        ],
      });
    }

    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${payload.appName} · ${payload.tenantName} · ${payload.occurredAt}`,
        },
      ],
    });

    const body: Record<string, unknown> = {
      // `text` is the notification preview and the accessibility fallback —
      // without it Slack shows "This content can't be displayed" on mobile.
      text: `${emoji} ${payload.title}`,
      attachments: [{ color: SEVERITY_HEX[payload.severity], blocks }],
    };

    if (config.channel) body.channel = String(config.channel);
    if (config.username) body.username = String(config.username);

    const response = await fetch(String(config.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Slack returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
  },

  async sendTest(config) {
    await slackPlugin.send(config, testPayload());
  },
};

export default slackPlugin;
