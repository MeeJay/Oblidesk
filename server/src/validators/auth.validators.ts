/**
 * auth.validators.ts — zod schemas for every auth and platform-config body.
 *
 * These are the shapes the routes hand to `validate()` (middleware/validate),
 * which replaces `req.body` with the PARSED value — so a handler that reads
 * `req.body as LoginInput` is reading trimmed, coerced, checked data, not what
 * the caller typed.
 *
 * Nothing here enforces password COMPLEXITY beyond a length floor. Complexity
 * rules invented in a validator are rules no operator can configure and no
 * user can predict; the length floor is the one that is defensible without a
 * policy engine behind it.
 */

import { z } from 'zod';

// ── Primitives ───────────────────────────────────────────────────────────────

/** Matches the shape the `tenants.slug` citext column is expected to hold. */
export const tenantSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9-]+$/, 'A tenant slug is lower-case letters, digits and hyphens');

export const usernameSchema = z.string().trim().min(1).max(64);

export const emailSchema = z.string().trim().toLowerCase().email('A valid e-mail address is required').max(255);

export const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(256);

/**
 * A six-digit code. Spaces are stripped first because every authenticator app
 * renders `123 456` and every user pastes it that way.
 */
export const otpCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'The code is six digits'));

// ── Sign-in ──────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1, 'Password is required').max(256),
  /** Cross-app handoff: land the session on this tenant when it is reachable. */
  tenantSlug: tenantSlugSchema.optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  method: z.enum(['totp', 'email']),
  code: otpCodeSchema,
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

// ── Second-factor enrolment ──────────────────────────────────────────────────

export const totpEnableSchema = z.object({ code: otpCodeSchema });
export type TotpEnableInput = z.infer<typeof totpEnableSchema>;

export const emailOtpSetupSchema = z.object({ email: emailSchema });
export type EmailOtpSetupInput = z.infer<typeof emailOtpSetupSchema>;

/**
 * The address is sent again at confirmation, not remembered server-side: the
 * session holds `sha256(address:code)`, so the code only validates for the
 * inbox it was actually delivered to.
 */
export const emailOtpEnableSchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
});
export type EmailOtpEnableInput = z.infer<typeof emailOtpEnableSchema>;

// ── Passwords ────────────────────────────────────────────────────────────────

export const forgotPasswordSchema = z.object({ email: emailSchema });
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetTokenSchema = z.object({
  token: z.string().trim().min(32).max(255),
});
export type ResetTokenInput = z.infer<typeof resetTokenSchema>;

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(32).max(255),
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ── Platform configuration (admin) ───────────────────────────────────────────

export const obligateConfigSchema = z.object({
  url: z.string().trim().url('The Obligate URL must be absolute').max(255).nullable().optional(),
  /** Omit to keep the stored key; pass null to clear it. */
  apiKey: z.string().trim().max(512).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type ObligateConfigInput = z.infer<typeof obligateConfigSchema>;

export const aiConfigSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.enum(['anthropic', 'openai', 'azure', 'local', 'none']).optional(),
  model: z.string().trim().max(128).nullable().optional(),
  apiKey: z.string().trim().max(512).nullable().optional(),
  monthlyBudgetUsd: z.number().nonnegative().max(1_000_000).nullable().optional(),
  /** Per-tenant ceilings, keyed BY SLUG (HARD RULE 13). */
  tenantBudgetsUsd: z.record(tenantSlugSchema, z.number().nonnegative().max(1_000_000)).optional(),
  features: z
    .object({
      summarize: z.boolean().optional(),
      draftReply: z.boolean().optional(),
      suggestKb: z.boolean().optional(),
      triage: z.boolean().optional(),
      dedupe: z.boolean().optional(),
    })
    .optional(),
});
export type AiConfigInput = z.infer<typeof aiConfigSchema>;

export const securityConfigSchema = z.object({
  allow2fa: z.boolean().optional(),
  force2fa: z.boolean().optional(),
  otpSmtpServerId: z.number().int().positive().nullable().optional(),
});
export type SecurityConfigInput = z.infer<typeof securityConfigSchema>;

export const configValueSchema = z.object({ value: z.unknown() });
export type ConfigValueInput = z.infer<typeof configValueSchema>;
