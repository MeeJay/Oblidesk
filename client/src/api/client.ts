/**
 * client.ts — the single axios instance every `*.api.ts` module goes through.
 *
 * ── ObliTools ───────────────────────────────────────────────────────────────
 * The desktop shell hosts the app in a cross-site WebView2 iframe, where Chrome
 * drops every cookie. So when we detect that context we replay the session id
 * in `X-Auth-Token` (AUTH_TOKEN_HEADER) instead. The token IS the session —
 * signing out destroys it server-side, and there is no second credential with
 * its own lifetime to leak or expire out of step.
 *
 * ── The 401 interceptor ─────────────────────────────────────────────────────
 * A hard redirect to /login on any 401 is wrong on the pages that legitimately
 * get one: the login screen itself (a bad password is a 401), and the SSO
 * landing pages, where a redirect mid-handshake loses the authorisation code
 * and the user bounces forever. Those paths clear local state and let React
 * Router decide.
 */

import axios, { type AxiosError, type AxiosInstance } from 'axios';
import {
  API_PREFIX,
  AUTH_TOKEN_HEADER,
  ROW_VERSION_HEADER,
  STORAGE_KEYS,
  TENANT_OVERRIDE_HEADER,
  type ApiErrorCode,
} from '@oblidesk/shared';

/**
 * True inside the ObliTools shell — either framed cross-site, or flagged by the
 * native host. The `window.top` read throws on a cross-origin parent, and that
 * throw is itself the answer: we are framed.
 */
export const isInObliTools =
  (() => {
    try {
      return window !== window.top;
    } catch {
      return true;
    }
  })() || !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

export const OBLITOOLS_TOKEN_KEY = STORAGE_KEYS.obliToolsToken;

/** Store / clear the replayed session id. Called by the auth store on login. */
export function setAuthToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(OBLITOOLS_TOKEN_KEY, token);
    else sessionStorage.removeItem(OBLITOOLS_TOKEN_KEY);
  } catch {
    // sessionStorage unavailable — cookies had better be working.
  }
}

export function getAuthToken(): string | null {
  try {
    return sessionStorage.getItem(OBLITOOLS_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Platform admins may act inside a tenant other than their session's, via
 * `X-Tenant-Id`. Held here rather than read from a store so this module stays
 * at the bottom of the import graph — a store importing the client and the
 * client importing the store is a cycle that bites at module-init time.
 */
let tenantOverride: number | null = null;

export function setTenantOverride(tenantId: number | null): void {
  tenantOverride = tenantId;
}

export function getTenantOverride(): number | null {
  return tenantOverride;
}

const apiClient: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}${API_PREFIX}` : API_PREFIX,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  if (isInObliTools) {
    const token = getAuthToken();
    if (token) config.headers[AUTH_TOKEN_HEADER] = token;
  }
  if (tenantOverride !== null) {
    config.headers[TENANT_OVERRIDE_HEADER] = String(tenantOverride);
  }
  return config;
});

/** Paths where a 401 is an expected answer, not a dead session. */
const NO_REDIRECT_PATHS = ['/login', '/auth/foreign', '/auth/callback', '/forgot-password', '/reset-password'];

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      if (isInObliTools) {
        // Clear the stale token but never hard-navigate: the shell owns its own
        // history and a location assignment would drop out of the app frame.
        setAuthToken(null);
      } else {
        const { pathname } = window.location;
        const exempt =
          NO_REDIRECT_PATHS.some((path) => pathname === path) || pathname.startsWith('/portal');
        if (!exempt) window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

// ═════════════════════════════════════════════════════════════════════════════
// Error shaping
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A server failure, unwrapped once so no call site has to dig through
 * `err.response.data.error` and guess. `code` is what the UI branches on —
 * `version_conflict` shows the conflict dialog, `transition_blocked` shows the
 * missing fields, everything else shows the message.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | string | null;
  readonly fieldErrors: Record<string, string> | null;
  /** The extra body a typed failure carries — the current row, the evaluation. */
  readonly payload: Record<string, unknown> | null;

  constructor(
    message: string,
    options: {
      status: number;
      code?: ApiErrorCode | string | null;
      fieldErrors?: Record<string, string> | null;
      payload?: Record<string, unknown> | null;
    },
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.code = options.code ?? null;
    this.fieldErrors = options.fieldErrors ?? null;
    this.payload = options.payload ?? null;
  }

  get isConflict(): boolean {
    return this.status === 409 || this.code === 'version_conflict';
  }

  get isTransitionBlocked(): boolean {
    return this.code === 'transition_blocked' || this.code === 'required_fields_missing';
  }

  get isForbidden(): boolean {
    return this.status === 403 || this.code === 'forbidden';
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.code === 'not_found';
  }
}

interface ServerFailure {
  success?: false;
  error?: string;
  code?: string;
  fieldErrors?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Turn anything thrown by axios into an `ApiError`. Always returns one, so a
 * caller can `catch (err) { throw toApiError(err) }` and never widen to unknown.
 */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  const axiosError = error as AxiosError<ServerFailure>;
  const response = axiosError?.response;

  if (response) {
    const body = (response.data ?? {}) as ServerFailure;
    const { error: message, code, fieldErrors, success, ...payload } = body;
    void success;
    return new ApiError(message ?? axiosError.message ?? 'Request failed', {
      status: response.status,
      code: code ?? null,
      fieldErrors: fieldErrors ?? null,
      payload: Object.keys(payload).length > 0 ? payload : null,
    });
  }

  if (axiosError?.request) {
    return new ApiError('Le serveur est injoignable / The server is unreachable', {
      status: 0,
      code: 'network_error',
    });
  }

  return new ApiError(
    error instanceof Error ? error.message : 'Unexpected error',
    { status: 0, code: 'internal_error' },
  );
}

/** The human message to put in a toast. Never a raw stack, never '[object …]'. */
export function errorMessage(error: unknown, fallback = 'Une erreur est survenue / Something went wrong'): string {
  const apiError = toApiError(error);
  return apiError.message || fallback;
}

// ═════════════════════════════════════════════════════════════════════════════
// Envelope helpers
// ═════════════════════════════════════════════════════════════════════════════

/** The success envelope, plus whatever list metadata the route rode along with. */
export interface Envelope<T> {
  success: true;
  data: T;
  [key: string]: unknown;
}

/**
 * Unwrap `{ success, data }`. Throws an `ApiError` when the body says failure
 * with a 200 — which should not happen, but a silent `undefined` propagating
 * into a store is much worse than a loud throw here.
 */
export function unwrap<T>(body: Envelope<T> | { success: false; error?: string }): T {
  if (body && (body as Envelope<T>).success === true) return (body as Envelope<T>).data;
  throw new ApiError((body as { error?: string })?.error ?? 'Malformed response', {
    status: 500,
    code: 'internal_error',
  });
}

/** Header carrying the optimistic-concurrency base version on a mutation. */
export function rowVersionHeader(baseRowVersion: number): Record<string, string> {
  return { [ROW_VERSION_HEADER]: String(baseRowVersion) };
}

/**
 * Serialise a query object the way the server's zod schemas parse it: arrays
 * become comma-separated (the `csv()` helper), objects become JSON, and
 * null/undefined/'' are dropped rather than sent as the string "undefined".
 */
export function toQuery(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = value.join(',');
    } else if (typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export default apiClient;
