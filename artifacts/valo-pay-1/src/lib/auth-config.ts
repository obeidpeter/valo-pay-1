import { browserEnvironment } from './browser-identity';
import { resolveBrowserAuth } from './browser-auth';

export const browserAuth = resolveBrowserAuth({
  environment: browserEnvironment,
  mode: import.meta.env.VITE_VALO_PAY_1_AUTH_MODE,
  publicKey: import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
  issuer: import.meta.env.VITE_VALO_PAY_1_CLERK_ISSUER_URL,
  origin: import.meta.env.VITE_VALO_PAY_1_APP_ORIGIN,
  actualOrigin: window.location.origin,
  proxy: import.meta.env.VITE_CLERK_PROXY_URL,
});
