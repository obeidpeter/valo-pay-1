import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserStorageKey, LEGACY_BROWSER_ORIGIN, migrateLegacyBrowserStore, resolveBrowserEnvironment } from '@/lib/browser-identity';

const now = Date.parse('2026-10-03T12:00:00Z');
const approved = { enabled: 'true', origin: LEGACY_BROWSER_ORIGIN, until: '2026-10-10T12:00:00Z', now, environment: 'production' as const };
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe('generation-specific browser identity', () => {
  it('rejects missing and unknown production environments, independently of workspace mode', () => {
    expect(() => resolveBrowserEnvironment(undefined, 'production', false)).toThrow(/VITE_VALO_PAY_1_ENVIRONMENT/);
    expect(() => resolveBrowserEnvironment('sandbox', 'production', false)).toThrow();
    expect(() => resolveBrowserEnvironment('Production', 'production', false)).toThrow();
    expect(resolveBrowserEnvironment(undefined, 'test', false)).toBe('test');
    expect(resolveBrowserEnvironment(undefined, 'development', true)).toBe('development');
    expect(resolveBrowserEnvironment('staging', 'production', false)).toBe('staging');
    expect(browserStorageKey('theme')).toBe('valo-pay-1:test:theme');
  });

  it('keeps a disposable future identity, another deployment and this product separate', () => {
    localStorage.setItem('valo-pay:production:theme', 'future');
    localStorage.setItem('valo-pay-1:staging:theme', 'staging');
    localStorage.setItem(browserStorageKey('theme'), 'dark');
    expect(new Set(['valo-pay:production:theme', 'valo-pay-1:staging:theme', browserStorageKey('theme')]).size).toBe(3);
    expect(localStorage.getItem('valo-pay:production:theme')).toBe('future');
    expect(localStorage.getItem('valo-pay-1:staging:theme')).toBe('staging');
  });

  it.each([
    { ...approved, enabled: undefined },
    { ...approved, enabled: 'yes' },
    { ...approved, origin: 'https://valo-pay-1.replit.app' },
    { ...approved, origin: 'https://valo-pay.replit.app.example.test' },
    { ...approved, until: '2026-10-03T12:00:00Z' },
  ])('does not consume legacy values without every explicit transition condition (%j)', (options) => {
    localStorage.setItem('valopay-theme', 'dark');
    expect(migrateLegacyBrowserStore(localStorage, 'local', options)).toBe('disabled');
    expect(localStorage.length).toBe(1);
  });

  it.each([undefined, 'not a date'])('blocks an explicitly enabled transition with an invalid expiry (%s)', until => {
    sessionStorage.setItem('valopay-submission:v1:viewer', 'original recovery reference');
    expect(() => migrateLegacyBrowserStore(sessionStorage, 'session', { ...approved, until })).toThrow(/valid UTC expiry/);
    expect(sessionStorage.length).toBe(1);
  });

  it('copies known values once, never overwrites new choices and never consumes future/auth/unknown state', () => {
    localStorage.setItem('valopay-theme', 'dark');
    localStorage.setItem('valopay-start-v1:viewer', 'open');
    localStorage.setItem('valo-pay-1:production:theme', 'light');
    localStorage.setItem('valo-pay:production:theme', 'future');
    localStorage.setItem('__clerk_token', 'not-transferred');
    localStorage.setItem('valopay-future-draft', 'not-transferred');
    expect(migrateLegacyBrowserStore(localStorage, 'local', approved)).toBe('copied');
    expect(localStorage.getItem('valo-pay-1:production:theme')).toBe('light');
    expect(localStorage.getItem('valo-pay-1:production:start-v1:viewer')).toBe('open');
    expect(localStorage.getItem('valopay-start-v1:viewer')).toBe('open');
    expect(localStorage.getItem('valo-pay:production:theme')).toBe('future');
    expect(localStorage.getItem('valo-pay-1:production:__clerk_token')).toBeNull();
    expect(localStorage.getItem('valo-pay-1:production:future-draft')).toBeNull();
    localStorage.setItem('valopay-guide-v2:added-later', 'future legacy-looking state');
    expect(migrateLegacyBrowserStore(localStorage, 'local', approved)).toBe('complete');
    expect(localStorage.getItem('valo-pay-1:production:guide-v2:added-later')).toBeNull();
  });

  it('preserves exact outstanding request identities, viewer scope and interrupted presenter role', () => {
    const scope = JSON.stringify(['viewer', 'actor', 'Finance', 'lender']);
    const request = JSON.stringify([{ key: 'b6a9a5e4-1e8e-403f-9365-2711724153d9', method: 'POST', path: '/v1/actions/confirm', page: '/reconciliation' }]);
    sessionStorage.setItem(`valopay-submission:v1:${scope}`, request);
    sessionStorage.setItem('valopay-preparation-role:lender', 'Admin');
    expect(migrateLegacyBrowserStore(sessionStorage, 'session', approved)).toBe('copied');
    expect(sessionStorage.getItem(`valo-pay-1:production:submission:v1:${scope}`)).toBe(request);
    expect(sessionStorage.getItem(`valopay-submission:v1:${scope}`)).toBe(request);
    expect(sessionStorage.getItem('valo-pay-1:production:preparation-role:lender')).toBe('Admin');
  });

  it('leaves originals recoverable and retries without overwriting completed copies when storage fails', () => {
    sessionStorage.setItem('valopay-lender:viewer', 'lender');
    sessionStorage.setItem('valopay-preparation-role:lender', 'Admin');
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith('preparation-role:lender') && key.startsWith('valo-pay-1:')) throw new Error('Storage full');
      setItem.call(this, key, value);
    });
    expect(() => migrateLegacyBrowserStore(sessionStorage, 'session', approved)).toThrow('Storage full');
    expect(sessionStorage.getItem('valopay-preparation-role:lender')).toBe('Admin');
    expect(sessionStorage.getItem('valo-pay-1:production:legacy-browser-v1')).toBeNull();
    vi.restoreAllMocks();
    expect(migrateLegacyBrowserStore(sessionStorage, 'session', approved)).toBe('copied');
    expect(sessionStorage.getItem('valo-pay-1:production:preparation-role:lender')).toBe('Admin');
  });
});
