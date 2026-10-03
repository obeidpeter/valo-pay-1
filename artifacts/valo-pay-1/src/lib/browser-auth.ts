import type { BrowserEnvironment } from './browser-identity';

type AuthOptions = { environment: BrowserEnvironment; mode?: string; publicKey?: string; issuer?: string; origin?: string; actualOrigin: string; proxy?: string };
/** A hostname never selects an authentication project. The reviewed public instance must match the explicit key. */
export function resolveBrowserAuth(options: AuthOptions): { enabled: boolean; publicKey: string; proxy?: string } {
  const hosted = options.environment === 'production' || options.environment === 'staging';
  const mode = options.mode || (!hosted && !options.publicKey ? 'disabled' : '');
  if (mode !== 'disabled' && mode !== 'clerk') throw new Error('VITE_VALO_PAY_1_AUTH_MODE must explicitly be disabled or clerk.');
  if (hosted && (!options.origin || !/^https:\/\/[^/?#@]+$/.test(options.origin) || options.origin !== options.actualOrigin)) throw new Error('Valo Pay 1 was opened on an origin that is not assigned to this deployment.');
  if (mode === 'disabled') {
    if (options.publicKey || options.issuer || options.proxy) throw new Error('Disabled authentication must not include a Clerk instance.');
    return { enabled: false, publicKey: '' };
  }
  if (!options.publicKey || !/^pk_(test|live)_[A-Za-z0-9+/=_-]+$/.test(options.publicKey)) throw new Error('An explicit Clerk publishable key is required.');
  let keyHost = '';
  try { keyHost = atob(options.publicKey.replace(/^pk_(test|live)_/, '').replace(/-/g, '+').replace(/_/g, '/')).replace(/\$$/, ''); } catch { /* Refused below without exposing the key. */ }
  let issuer: URL;
  try { issuer = new URL(options.issuer || ''); } catch { throw new Error('VITE_VALO_PAY_1_CLERK_ISSUER_URL is required.'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.port || issuer.search || issuer.hash || issuer.pathname !== '/' || issuer.hostname !== keyHost) {
    throw new Error('The Clerk public key does not match the authentication instance assigned to Valo Pay 1.');
  }
  if (options.proxy && new URL(options.proxy, options.actualOrigin).origin !== options.actualOrigin) throw new Error('The Clerk proxy must remain on this application origin.');
  return { enabled: true, publicKey: options.publicKey, proxy: options.proxy };
}
