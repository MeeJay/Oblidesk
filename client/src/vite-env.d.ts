/// <reference types="vite/client" />

/**
 * Injected by `vite.config.ts` → `define.__APP_VERSION__` from the client
 * package.json. Declared here so the topbar's version pill type-checks without
 * an `any` cast.
 */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Absolute API origin. Empty in dev — Vite proxies `/api` to :3001. */
  readonly VITE_API_URL?: string;
  readonly VITE_APP_NAME?: string;
  /** Public portal base path, when the portal is served from another host. */
  readonly VITE_PORTAL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * The ObliTools desktop shell (WebView2) sets this on the page it hosts. It is
 * how the client knows cookies will be dropped and the `X-Auth-Token` header
 * has to carry the session instead — see `api/client.ts`.
 */
interface Window {
  __obliview_is_native_app?: boolean;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
