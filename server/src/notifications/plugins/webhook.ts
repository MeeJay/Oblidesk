import {
  PLUGIN_TIMEOUT_MS,
  testPayload,
  type NotificationPlugin,
} from '../types';

/**
 * webhook — POST the raw payload as JSON.
 *
 * The escape hatch: anything the suite does not ship a plugin for (a PagerDuty
 * bridge, an internal bus, a customer's own automation) consumes this. The body
 * is the `NotificationPayload` verbatim, so the shape is documented by
 * notifications/types.ts rather than by a bespoke schema.
 */
export const webhookPlugin: NotificationPlugin = {
  type: 'webhook',
  name: 'Webhook',
  description: 'POST the notification payload as JSON to any URL.',
  supportsRichFormat: false,
  configFields: [
    {
      key: 'url',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://example.com/hooks/oblidesk',
    },
    {
      key: 'secret',
      label: 'Authorization header',
      type: 'password',
      secret: true,
      placeholder: 'Bearer …',
      hint: 'Sent verbatim as the Authorization header. Leave blank for none.',
    },
    {
      key: 'headerName',
      label: 'Custom header name',
      type: 'text',
      placeholder: 'X-Oblidesk-Token',
      hint: 'Use instead of Authorization when the receiver expects its own header.',
    },
  ],

  async send(config, payload) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Oblidesk',
      'X-Oblidesk-Event': payload.event,
      'X-Oblidesk-Tenant': payload.tenantSlug,
    };

    if (config.secret) {
      const headerName = typeof config.headerName === 'string' && config.headerName.trim()
        ? config.headerName.trim()
        : 'Authorization';
      headers[headerName] = String(config.secret);
    }

    const response = await fetch(String(config.url), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(PLUGIN_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Include the body: a 400 from a webhook receiver almost always explains
      // itself, and losing that text turns a five-second fix into a support call.
      const text = await response.text().catch(() => '');
      throw new Error(`Webhook returned ${response.status}${text ? `: ${text.slice(0, 500)}` : ''}`);
    }
  },

  async sendTest(config) {
    await webhookPlugin.send(config, testPayload());
  },
};

export default webhookPlugin;
