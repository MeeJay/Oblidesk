import {
  PLUGIN_TIMEOUT_MS,
  payloadFacts,
  testPayload,
  type NotificationPayload,
  type NotificationPlugin,
  type NotificationSeverity,
} from '../types';

/**
 * teams — Microsoft Teams Incoming Webhook, Adaptive Card 1.4.
 *
 * Teams ignores arbitrary colours: a card is tinted by `style`, from a fixed
 * vocabulary. Mapping our four severities onto that vocabulary is the only way
 * to get a coloured card, and the mapping is a deliberate lossy choice rather
 * than an oversight — `attention` is the only red Teams offers.
 */
const CONTAINER_STYLE: Readonly<Record<NotificationSeverity, string>> = {
  critical: 'attention',
  warning: 'warning',
  info: 'emphasis',
  success: 'good',
};

function buildAdaptiveCard(payload: NotificationPayload): Record<string, unknown> {
  const facts = payloadFacts(payload).map((fact) => ({ title: fact.label, value: fact.value }));

  const bodyItems: Array<Record<string, unknown>> = [
    {
      type: 'Container',
      style: CONTAINER_STYLE[payload.severity],
      bleed: true,
      items: [
        {
          type: 'TextBlock',
          text: payload.title,
          weight: 'Bolder',
          size: 'Medium',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: `${payload.appName} · ${payload.tenantName}`,
          spacing: 'None',
          isSubtle: true,
          wrap: true,
        },
      ],
    },
    {
      type: 'TextBlock',
      text: payload.body,
      wrap: true,
    },
  ];

  if (facts.length > 0) bodyItems.push({ type: 'FactSet', facts });

  const actions = payload.url
    ? [{ type: 'Action.OpenUrl', title: 'Open in Oblidesk', url: payload.url }]
    : [];

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: bodyItems,
          ...(actions.length > 0 ? { actions } : {}),
          msteams: { width: 'Full' },
        },
      },
    ],
  };
}

export const teamsPlugin: NotificationPlugin = {
  type: 'teams',
  name: 'Microsoft Teams',
  description: 'Post an Adaptive Card to a Teams channel through an Incoming Webhook.',
  supportsRichFormat: true,
  configFields: [
    {
      key: 'webhookUrl',
      label: 'Teams webhook URL',
      type: 'url',
      required: true,
      secret: true,
      placeholder: 'https://xxx.webhook.office.com/webhookb2/…',
    },
  ],

  async send(config, payload) {
    const response = await fetch(String(config.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildAdaptiveCard(payload)),
      signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Teams returned ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }

    // Teams answers 200 with the literal body "1" on success and, maddeningly,
    // 200 with an error string on some failures. Treat a non-"1" 200 as failure
    // so the outbox retries instead of marking a lost card as delivered.
    const text = (await response.text().catch(() => '')).trim();
    if (text && text !== '1' && text.toLowerCase().includes('error')) {
      throw new Error(`Teams accepted the request but reported: ${text.slice(0, 300)}`);
    }
  },

  async sendTest(config) {
    await teamsPlugin.send(config, testPayload());
  },
};

export default teamsPlugin;
