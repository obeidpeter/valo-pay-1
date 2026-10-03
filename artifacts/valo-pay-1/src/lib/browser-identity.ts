/** Deployment identity is deliberately independent of a workspace's sandbox/live mode. */
export const BROWSER_PRODUCT_ID = 'valo-pay-1';
export const browserEnvironments = ['development', 'test', 'staging', 'production'] as const;
export type BrowserEnvironment = typeof browserEnvironments[number];

export function resolveBrowserEnvironment(configured: unknown, mode: string, development: boolean): BrowserEnvironment {
  const value = configured || (mode === 'test' ? 'test' : development ? 'development' : '');
  if (!browserEnvironments.includes(value as BrowserEnvironment)) {
    throw new Error('VITE_VALO_PAY_1_ENVIRONMENT must identify this deployment as development, test, staging or production.');
  }
  return value as BrowserEnvironment;
}

export const browserEnvironment = resolveBrowserEnvironment(import.meta.env.VITE_VALO_PAY_1_ENVIRONMENT, import.meta.env.MODE, import.meta.env.DEV);
export const browserStoragePrefix = `${BROWSER_PRODUCT_ID}:${browserEnvironment}:`;
export const browserStorageKey = (name: string): string => browserStoragePrefix + name;

// This retained origin belongs exclusively to the first-generation application until the documented migration ends.
export const LEGACY_BROWSER_ORIGIN = 'https://valo-pay.replit.app';
const transition = 'legacy-browser-v1';
const mappings = {
  local: [
    ['valopay-theme', 'theme', true],
    ['valopay-start-v1:', 'start-v1:'],
    ['valopay-guide-v2:', 'guide-v2:'],
    ['valopay-queue-views-v2:', 'queue-views-v2:'],
  ],
  session: [
    ['valopay-lender:', 'lender:'],
    ['valopay-submission:v1:', 'submission:v1:'],
    ['valopay-presentation-v1:', 'presentation-v1:'],
    ['valopay-preparation-role:', 'preparation-role:'],
  ],
} satisfies Record<string, Array<[string, string, boolean?]>>;

type TransitionOptions = { enabled: unknown; until: unknown; origin: string; now: number; environment: BrowserEnvironment };
/** Exact-origin, explicitly enabled, time-bounded copy. It never reads authentication tokens or request bodies. */
export function migrateLegacyBrowserStore(storage: Storage, kind: keyof typeof mappings, options: TransitionOptions): 'disabled' | 'complete' | 'copied' {
  if (options.enabled !== 'true' || options.origin !== LEGACY_BROWSER_ORIGIN) return 'disabled';
  const until = typeof options.until === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(options.until) ? Date.parse(options.until) : NaN;
  if (!Number.isFinite(until)) throw new Error('An enabled browser-state migration requires a valid UTC expiry.');
  if (options.now >= until) return 'disabled';
  const prefix = `${BROWSER_PRODUCT_ID}:${options.environment}:`;
  const checkpoint = prefix + transition;
  if (storage.getItem(checkpoint) === LEGACY_BROWSER_ORIGIN) return 'complete';
  // Bound work without partially declaring success. Originals remain available for recovery and reviewed cleanup.
  if (storage.length > 10_000) throw new Error('Browser-state migration needs a reviewed export: too many stored entries.');
  const copies: Array<[string, string]> = [];
  let size = 0;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key) continue;
    const mapping = mappings[kind].find(([legacy, , exact]) => exact ? key === legacy : key.startsWith(legacy));
    if (!mapping) continue;
    const [legacy, target] = mapping;
    const next = prefix + target + key.slice(legacy.length);
    if (storage.getItem(next) !== null) continue; // Never overwrite a newer generation-one choice or recovery reference.
    const value = storage.getItem(key);
    if (value === null) continue;
    size += key.length + value.length;
    if (size > 2_000_000) throw new Error('Browser-state migration needs a reviewed export: stored entries exceed its limit.');
    copies.push([next, value]);
  }
  for (const [key, value] of copies) {
    storage.setItem(key, value);
    if (storage.getItem(key) !== value) throw new Error('Browser-state migration could not verify a saved copy.');
  }
  storage.setItem(checkpoint, LEGACY_BROWSER_ORIGIN);
  if (storage.getItem(checkpoint) !== LEGACY_BROWSER_ORIGIN) throw new Error('Browser-state migration could not save its completion marker.');
  return 'copied';
}

/** Run before mounting the app. A failed enabled transition must not silently hide outstanding request recovery. */
export function migrateLegacyBrowserState(): void {
  const options: TransitionOptions = {
    enabled: import.meta.env.VITE_VALO_PAY_1_MIGRATE_LEGACY_BROWSER_STATE,
    until: import.meta.env.VITE_VALO_PAY_1_LEGACY_BROWSER_STATE_UNTIL,
    origin: window.location.origin, now: Date.now(), environment: browserEnvironment,
  };
  // Do not even access storage when this deployment has not explicitly enabled a transition on the retained origin.
  if (options.enabled !== 'true' || options.origin !== LEGACY_BROWSER_ORIGIN) return;
  migrateLegacyBrowserStore(window.localStorage, 'local', options);
  migrateLegacyBrowserStore(window.sessionStorage, 'session', options);
}
