/**
 * app.ts — the Express application: middleware order, sessions, the API mount.
 *
 * ── Middleware order is load-bearing ────────────────────────────────────────
 *   helmet                security headers before anything can respond
 *   cors                  before the routes that need the preflight to pass
 *   express.json          before anything reads req.body
 *   cookieParser          before session (session reads the cookie)
 *   authTokenBridge       before session (it manufactures the cookie)
 *   session               before the rate limiter, which skips signed-in users
 *   apiLimiter            before the routes it is meant to protect
 *   routes                the actual work
 *   errorHandler          LAST — a handler mounted after it never runs
 *
 * Get that order wrong and nothing crashes; things merely stop working in ways
 * that look like other bugs. The rate limiter mounted before the session, for
 * instance, sees every request as anonymous and throttles the whole support
 * team behind one proxy IP.
 */
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import path from 'path';
import { AUTH_TOKEN_HEADER, LIMITS } from '@oblidesk/shared';
import { config } from './config';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';
import { logger } from './utils/logger';
import { SESSION_COOKIE_NAME, signSessionCookie } from './utils/crypto';
import routes from './routes';
import obligateCallbackRoutes from './routes/obligateCallback.routes';
import { getServerVersion } from './routes/system.routes';

const PgSession = connectPgSimple(session);

export interface CreatedApp {
  app: Express;
  /**
   * The very session middleware instance mounted below. `createSocketServer`
   * runs it over the websocket handshake so a socket and a request share one
   * notion of who the caller is — a second `session()` with the same options
   * would use a different store instance and would silently drift apart the
   * first time the options changed.
   */
  sessionMiddleware: RequestHandler;
}

/**
 * ObliTools runs Oblidesk inside a cross-site WebView2, where Chrome refuses to
 * send cookies at all. The shell therefore keeps the session id it was handed
 * at login and returns it in `X-Auth-Token`.
 *
 * Rather than growing a second authentication path — one more thing to get
 * wrong, and one more place a future change has to remember — the header is
 * folded back into the cookie the session middleware already understands.
 * Everything downstream (routes, RBAC, the socket layer) sees an ordinary
 * session and knows nothing about ObliTools.
 *
 * The token is not a credential in itself: the signature is recomputed from
 * SESSION_SECRET, and the session store still decides whether that id exists
 * and is live. A real cookie always wins over the header.
 */
export function authTokenBridge(req: Request, _res: Response, next: NextFunction): void {
  const token = req.get(AUTH_TOKEN_HEADER);
  if (!token) {
    next();
    return;
  }
  if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`${SESSION_COOKIE_NAME}=`)) {
    next();
    return;
  }
  const cookie = signSessionCookie(token);
  req.headers.cookie = req.headers.cookie ? `${req.headers.cookie}; ${cookie}` : cookie;
  next();
}

export function createApp(): CreatedApp {
  // The production configuration gate runs in main(), BEFORE migrations and
  // seeding — see the comment there. Calling it again here would be harmless
  // but would suggest this is where it matters, and it is not.
  const app = express();

  // One reverse-proxy hop, so req.ip is the client's address from
  // X-Forwarded-For rather than the proxy's. Rate limiting depends on it.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // ── Security headers ─────────────────────────────────────────────────────
  app.use(
    helmet({
      // ObliTools embeds the app in an iframe, so framing must stay possible;
      // `frame-ancestors` is deliberately absent for the same reason.
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // Tailwind and the theme layer inject inline style attributes.
          styleSrc: ["'self'", "'unsafe-inline'"],
          // data: for avatars stored as data URIs, blob: for client-side
          // attachment previews before upload.
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          fontSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin: config.clientOrigin,
      credentials: true,
      exposedHeaders: ['X-Row-Version'],
    }),
  );

  // ── Body parsing ─────────────────────────────────────────────────────────
  // Sized against LIMITS.bodyMaxBytes: a journal entry may legitimately be a
  // long pasted log. Attachments do NOT come through here — they are multipart
  // and are handled by the attachments router's own multer config.
  const jsonLimit = `${Math.max(1, Math.ceil(LIMITS.bodyMaxBytes / (1024 * 1024)))}mb`;
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: true, limit: jsonLimit }));
  app.use(cookieParser());

  // Must sit between cookieParser and session — see authTokenBridge.
  app.use(authTokenBridge);

  // ── Sessions ─────────────────────────────────────────────────────────────
  // The `session` table is created by migration 001, never by the store:
  // createTableIfMissing would race two replicas starting at once, and a table
  // whose shape is owned by two places drifts.
  const store = new PgSession({
    conString: config.databaseUrl,
    tableName: config.sessionTable,
    createTableIfMissing: false,
  });
  store.on('error', (err: Error) => {
    // Without this, a dropped database connection surfaces to the user as
    // "Invalid username or password" and to the operator as nothing at all.
    logger.error(err, 'Session store error — sign-in will fail until the database recovers');
  });

  const sessionMiddleware = session({
    store,
    name: SESSION_COOKIE_NAME,
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      // Production always requires HTTPS; development still allows plain HTTP
      // so a local install works without a certificate. Keying this off
      // FORCE_HTTPS alone once meant an operator who forgot the flag shipped
      // session cookies in clear behind a TLS proxy.
      secure: config.isProd ? true : config.forceHttps,
      httpOnly: true,
      maxAge: config.sessionMaxAge,
      sameSite: 'lax',
    },
  });
  app.use(sessionMiddleware);

  // ── Rate limiting (after session, so signed-in users are skipped) ─────────
  app.use(apiLimiter);

  // ── Health check ─────────────────────────────────────────────────────────
  // Public and cheap: Docker's healthcheck polls it, and the login screen reads
  // the version from it before there is any session to speak of.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      app: 'oblidesk',
      version: getServerVersion(),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Obligate SSO redirect target ─────────────────────────────────────────
  // Outside /api on purpose: Obligate redirects the browser straight here, and
  // a redirect into an /api path would be rejected by the rate limiter's
  // anonymous bucket on a busy sign-in morning.
  app.use('/auth', obligateCallbackRoutes);

  // ── The API ──────────────────────────────────────────────────────────────
  app.use('/api', routes);

  // ── Static client (production single-container deployments) ──────────────
  if (!config.isDev) {
    const clientDist = path.join(__dirname, '../../client/dist');
    app.use(express.static(clientDist, { maxAge: '1h', index: false }));
    // SPA fallback. Registered after /api so it can never shadow a real route.
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // ── Errors — LAST ────────────────────────────────────────────────────────
  app.use(errorHandler);

  return { app, sessionMiddleware };
}
