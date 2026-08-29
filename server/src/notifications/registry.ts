/**
 * notifications/registry.ts — the plugin table.
 *
 * Same shape as the sibling apps: a Map keyed by `plugin.type`, populated at
 * import time with the built-ins, plus `registerPlugin()` so a deployment can
 * add one without editing this file.
 *
 * `notification_channels.type` holds that same key, so a channel whose plugin
 * is missing (a plugin removed in an upgrade, a typo in an imported bundle)
 * resolves to `undefined` rather than throwing. Callers must handle that —
 * `notificationService` logs it and marks the delivery `skipped` instead of
 * failing the whole fan-out, because one broken channel must not stop the
 * other three from telling someone the SLA just breached.
 */

import type { NotificationPlugin, NotificationPluginMeta } from './types';
import { smtpPlugin } from './plugins/smtp';
import { webhookPlugin } from './plugins/webhook';
import { slackPlugin } from './plugins/slack';
import { teamsPlugin } from './plugins/teams';
import { discordPlugin } from './plugins/discord';
import { telegramPlugin } from './plugins/telegram';

const plugins = new Map<string, NotificationPlugin>();

const BUILT_IN: readonly NotificationPlugin[] = [
  smtpPlugin,
  webhookPlugin,
  slackPlugin,
  teamsPlugin,
  discordPlugin,
  telegramPlugin,
];

for (const plugin of BUILT_IN) {
  plugins.set(plugin.type, plugin);
}

export function getPlugin(type: string): NotificationPlugin | undefined {
  return plugins.get(type);
}

export function hasPlugin(type: string): boolean {
  return plugins.has(type);
}

export function getAllPlugins(): NotificationPlugin[] {
  return [...plugins.values()];
}

/** Every channel type this installation can deliver to. */
export function getPluginTypes(): string[] {
  return [...plugins.keys()].sort();
}

/** What the channel editor renders. Config fields included; no secrets. */
export function getPluginMetas(): NotificationPluginMeta[] {
  return getAllPlugins()
    .map((plugin) => ({
      type: plugin.type,
      name: plugin.name,
      description: plugin.description,
      configFields: plugin.configFields,
      supportsRichFormat: plugin.supportsRichFormat ?? false,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Register (or replace) a plugin. Last writer wins, by design. */
export function registerPlugin(plugin: NotificationPlugin): void {
  plugins.set(plugin.type, plugin);
}

/**
 * Validate a channel config against its plugin's declared fields.
 * Returns the missing REQUIRED keys — the channel editor shows them inline and
 * the service refuses to save a channel that would fail on first delivery.
 */
export function missingRequiredFields(
  type: string,
  config: Record<string, unknown>,
): string[] {
  const plugin = plugins.get(type);
  if (!plugin) return [];
  return plugin.configFields
    .filter((field) => field.required)
    .filter((field) => {
      const value = config[field.key];
      return value === undefined || value === null || value === '';
    })
    .map((field) => field.key);
}

/** The config keys a plugin treats as secrets — redacted on every read path. */
export function secretFieldKeys(type: string): string[] {
  const plugin = plugins.get(type);
  if (!plugin) return [];
  return plugin.configFields
    .filter((field) => field.secret || field.type === 'password')
    .map((field) => field.key);
}
