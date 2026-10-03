import { describe, expect, it } from 'vitest';
import { resolveBrowserAuth } from '@/lib/browser-auth';

const origin = 'https://valo-pay-1.example.test';
const issuer = 'https://reviewed.clerk.accounts.dev';
const publicKey = 'pk_test_' + btoa('reviewed.clerk.accounts.dev$');
const reviewed = { environment: 'production' as const, mode: 'clerk', publicKey, issuer, origin, actualOrigin: origin };

describe('browser authentication boundary', () => {
  it('requires an explicit hosted authentication choice and approved application origin', () => {
    expect(() => resolveBrowserAuth({ environment: 'production', actualOrigin: origin })).toThrow(/AUTH_MODE/);
    expect(() => resolveBrowserAuth({ ...reviewed, origin: undefined })).toThrow(/origin/);
    expect(() => resolveBrowserAuth({ ...reviewed, actualOrigin: 'https://future.example.test' })).toThrow(/origin/);
  });
  it('allows deliberate sandbox-only hosting without inheriting an authentication instance', () => {
    expect(resolveBrowserAuth({ environment: 'production', mode: 'disabled', origin, actualOrigin: origin }).enabled).toBe(false);
    expect(() => resolveBrowserAuth({ ...reviewed, mode: 'disabled' })).toThrow(/Disabled authentication/);
    expect(resolveBrowserAuth({ environment: 'development', actualOrigin: 'http://localhost:5176' }).enabled).toBe(false);
  });
  it('pins the explicit public key to the reviewed provider instance', () => {
    expect(resolveBrowserAuth(reviewed)).toMatchObject({ enabled: true, publicKey });
    expect(() => resolveBrowserAuth({ ...reviewed, issuer: 'https://future.clerk.accounts.dev' })).toThrow(/does not match/);
    expect(() => resolveBrowserAuth({ ...reviewed, publicKey: undefined })).toThrow(/publishable key/);
    expect(() => resolveBrowserAuth({ ...reviewed, issuer: undefined })).toThrow(/ISSUER/);
    expect(() => resolveBrowserAuth({ ...reviewed, issuer: issuer + '/unreviewed' })).toThrow(/does not match/);
    expect(() => resolveBrowserAuth({ ...reviewed, issuer: issuer.replace('https:', 'http:') })).toThrow(/does not match/);
  });
  it('never broadens a proxy to another application origin', () => {
    expect(resolveBrowserAuth({ ...reviewed, proxy: '/__clerk' }).proxy).toBe('/__clerk');
    expect(() => resolveBrowserAuth({ ...reviewed, proxy: 'https://future.example.test/__clerk' })).toThrow(/proxy/);
  });
});
