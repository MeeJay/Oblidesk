/**
 * appConfig.routes.ts — platform configuration, mounted at `/api/admin/config`.
 *
 * `app_config` holds the INSTALLATION's settings — the Obligate gateway, the
 * AI provider, the 2FA policy. Tenant settings are a different thing entirely
 * (`settings` and `config_objects`), so everything here is admin-only, with
 * one deliberate exception: the collection GET is open to any authenticated
 * user, because the profile page must know whether 2FA is allowed before it
 * can offer the enrolment button. That response carries no secret — the
 * service reduces every stored key to `apiKeySet: boolean`.
 *
 * Every write is audited with the secret redacted: the row records THAT a key
 * changed and what the visible settings became, never the key itself.
 */

import { Router } from 'express';
import type { Request } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { auditService } from '../services/audit.service';
import { appConfigService } from '../services/appConfig.service';
import { authService, clientIp, clientUserAgent } from '../services/auth.service';
import { obligateService } from '../services/obligate.service';
import {
  aiConfigSchema,
  configValueSchema,
  obligateConfigSchema,
  securityConfigSchema,
} from '../validators/auth.validators';
import type {
  AiConfigInput,
  ConfigValueInput,
  ObligateConfigInput,
  SecurityConfigInput,
} from '../validators/auth.validators';

const router = Router();


/** Audit a configuration write. `before`/`after` must already be redacted. */
async function auditConfig(
  req: Request,
  key: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  const userId = req.session.userId ?? null;
  const tenantId = req.session.currentTenantId ?? (await authService.auditTenantFor(userId));
  if (tenantId === null) return;

  await auditService.recordSafe({
    tenantId,
    actorId: userId,
    actorType: 'user',
    action: 'config.update',
    entityType: 'app_config',
    entityId: key,
    before,
    after,
    ip: clientIp(req),
    userAgent: clientUserAgent(req),
  });
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/config
 * Any authenticated user: the profile page needs `allow2fa` / `force2fa`.
 */
router.get('/', requireAuth, async (_req, res, next) => {
  try {
    res.json({ success: true, data: await appConfigService.getAll() });
  } catch (err) {
    next(err);
  }
});

// ── Obligate SSO gateway ─────────────────────────────────────────────────────

router.get('/obligate', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    res.json({ success: true, data: await appConfigService.getObligateConfig() });
  } catch (err) {
    next(err);
  }
});

router.put('/obligate', requireAuth, requireRole('admin'), validate(obligateConfigSchema), async (req, res, next) => {
  try {
    const before = await appConfigService.getObligateConfig();
    const after = await appConfigService.patchObligateConfig(req.body as ObligateConfigInput);

    // `ObligateConfig` carries `apiKeySet`, never the key — so this is already
    // the redacted view, and there is no path here that could log the secret.
    await auditConfig(req, 'obligate_config', { ...before }, { ...after });

    // A gateway that has just become usable gets this app's capability
    // catalogue immediately, so an operator can map permissions without
    // restarting the server to trigger the boot-time sync.
    if (after.enabled && after.url && after.apiKeySet) {
      void obligateService.syncCapabilitySchemas();
    }

    res.json({ success: true, data: after });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/config/obligate/test — the reachability probe for the form. */
router.post('/obligate/test', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    res.json({ success: true, data: await obligateService.getSsoConfig() });
  } catch (err) {
    next(err);
  }
});

/** POST /api/admin/config/obligate/sync-capabilities — re-publish the catalogue. */
router.post('/obligate/sync-capabilities', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    await obligateService.syncCapabilitySchemas();
    res.json({ success: true, data: { synced: true } });
  } catch (err) {
    next(err);
  }
});

// ── AI provider ──────────────────────────────────────────────────────────────

router.get('/ai', requireAuth, requireRole('admin'), async (_req, res, next) => {
  try {
    res.json({ success: true, data: await appConfigService.getAiConfig() });
  } catch (err) {
    next(err);
  }
});

router.put('/ai', requireAuth, requireRole('admin'), validate(aiConfigSchema), async (req, res, next) => {
  try {
    const before = await appConfigService.getAiConfig();
    const after = await appConfigService.patchAiConfig(req.body as AiConfigInput);
    await auditConfig(req, 'ai_config', { ...before }, { ...after });
    res.json({ success: true, data: after });
  } catch (err) {
    next(err);
  }
});

// ── Security policy (2FA + the OTP mail server) ──────────────────────────────

router.put('/security', requireAuth, requireRole('admin'), validate(securityConfigSchema), async (req, res, next) => {
  try {
    const patch = req.body as SecurityConfigInput;
    const before = await appConfigService.getAll();

    if (patch.allow2fa !== undefined) await appConfigService.set('allow_2fa', patch.allow2fa);
    if (patch.force2fa !== undefined) await appConfigService.set('force_2fa', patch.force2fa);
    if (patch.otpSmtpServerId !== undefined) {
      await appConfigService.set('otp_smtp_server_id', patch.otpSmtpServerId);
    }

    const after = await appConfigService.getAll();
    await auditConfig(
      req,
      'security',
      { allow2fa: before.allow2fa, force2fa: before.force2fa, otpSmtpServerId: before.otpSmtpServerId },
      { allow2fa: after.allow2fa, force2fa: after.force2fa, otpSmtpServerId: after.otpSmtpServerId },
    );

    res.json({ success: true, data: after });
  } catch (err) {
    next(err);
  }
});

// ── Generic key setter ───────────────────────────────────────────────────────

/**
 * The keys that hold an encrypted secret. They are refused here so a value can
 * never be written past the typed endpoint that encrypts it — a plain-text API
 * key sitting in `app_config` is exactly the leak the encryption exists to
 * prevent, and `PUT /:key` would be the quiet way to create one.
 */
const PROTECTED_KEYS = new Set(['obligate_config', 'ai_config']);

/**
 * PUT /api/admin/config/:key — MUST stay last: `/:key` matches everything
 * declared after it.
 */
router.put('/:key', requireAuth, requireRole('admin'), validate(configValueSchema), async (req, res, next) => {
  try {
    const key = req.params.key;

    if (PROTECTED_KEYS.has(key)) {
      throw new AppError(400, `Use the dedicated endpoint for "${key}" — it holds an encrypted secret`, {
        code: 'forbidden',
      });
    }
    if (key.length > 64) {
      throw new AppError(400, 'That configuration key is too long (64 characters maximum)', {
        code: 'validation_failed',
      });
    }

    const { value } = req.body as ConfigValueInput;
    const before = await appConfigService.get(key);
    await appConfigService.set(key, value);
    await auditConfig(req, key, { value: before }, { value });

    res.json({ success: true, data: { key, value } });
  } catch (err) {
    next(err);
  }
});

export default router;
