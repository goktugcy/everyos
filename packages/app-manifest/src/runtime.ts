/*
 * How every desktop app document runs (docs/app-sdk/architecture.md): in an iframe with these
 * sandbox flags and no `allow-same-origin` (an opaque origin), served with this content security
 * policy. The desktop, the API and the developer server of `everyos-app dev` use the same values,
 * so an app that runs in development runs the same way on EveryOS.
 */

/** Scripts in the frame's own opaque origin, forms, its own dialogs, popups and downloads. */
export const APP_FRAME_SANDBOX =
  "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

/** The CSP of every file of an app: its own files only, no remote code, no network beyond them. */
export const APP_RUNTIME_CSP = [
  `sandbox ${APP_FRAME_SANDBOX}`,
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");
