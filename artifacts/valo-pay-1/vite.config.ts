import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import { resolveBrowserAuth } from './src/lib/browser-auth';
import type { BrowserEnvironment } from './src/lib/browser-identity';
import { clerkChunk } from './build/clerk-chunk';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

export default defineConfig(async ({ mode }) => {
  const frontendEnv = { ...loadEnv(mode, path.resolve(import.meta.dirname), 'VITE_'), ...process.env };
  const browserEnvironment = frontendEnv.VITE_VALO_PAY_1_ENVIRONMENT || (process.env.NODE_ENV !== 'production' ? 'development' : '');
  if (!['development', 'test', 'staging', 'production'].includes(browserEnvironment)) {
    throw new Error('VITE_VALO_PAY_1_ENVIRONMENT must identify this build as development, test, staging or production.');
  }
  // Refuse a hosted build with ambiguous authentication configuration before it can be published.
  resolveBrowserAuth({
    environment: browserEnvironment as BrowserEnvironment,
    mode: frontendEnv.VITE_VALO_PAY_1_AUTH_MODE,
    publicKey: frontendEnv.VITE_CLERK_PUBLISHABLE_KEY,
    issuer: frontendEnv.VITE_VALO_PAY_1_CLERK_ISSUER_URL,
    origin: frontendEnv.VITE_VALO_PAY_1_APP_ORIGIN,
    actualOrigin: frontendEnv.VITE_VALO_PAY_1_APP_ORIGIN || 'http://localhost',
    proxy: frontendEnv.VITE_CLERK_PROXY_URL,
  });
  const rawPort = process.env.PORT;

  if (!rawPort) {
    throw new Error(
      'PORT environment variable is required but was not provided.',
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const basePath = process.env.BASE_PATH;

  if (!basePath) {
    throw new Error(
      'BASE_PATH environment variable is required but was not provided.',
    );
  }

  // Outside Replit, whose router sends /api to the API server, the development
  // server forwards /api to the API process itself, keeping the browser on one
  // origin as the API's origin rule requires. VALO_PAY_1_DEV_API_ORIGIN names that
  // process; by default the API server's port, 8181, on this machine.
  const apiOrigin = process.env.VALO_PAY_1_DEV_API_ORIGIN || 'http://127.0.0.1:8181';

  if (!/^https?:\/\/[^/?#]+$/.test(apiOrigin)) {
    throw new Error(
      'VALO_PAY_1_DEV_API_ORIGIN must be an http or https origin such as http://127.0.0.1:8181, without a path.',
    );
  }

  return {
    base: basePath,
    define: { 'import.meta.env.VITE_VALO_PAY_1_ENVIRONMENT': JSON.stringify(browserEnvironment) },
    plugins: [
      { name: 'valo-pay-1-browser-identity', transformIndexHtml: (html: string) => html.replaceAll('__VALO_PAY_1_ENVIRONMENT__', browserEnvironment) },
      clerkChunk(),
      react(),
      tailwindcss(),
      runtimeErrorOverlay(),
      ...(process.env.NODE_ENV !== 'production' &&
      process.env.REPL_ID !== undefined
        ? [
            await import('@replit/vite-plugin-cartographer').then((m) =>
              m.cartographer({
                root: path.resolve(import.meta.dirname, '..'),
              }),
            ),
            await import('@replit/vite-plugin-dev-banner').then((m) =>
              m.devBanner(),
            ),
          ]
        : []),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, 'src'),
        '@assets': path.resolve(
          import.meta.dirname,
          '..',
          '..',
          'attached_assets',
        ),
      },
      dedupe: ['react', 'react-dom'],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, 'dist/public'),
      emptyOutDir: true,
    },
    server: {
      port,
      strictPort: true,
      host: '0.0.0.0',
      allowedHosts: true,
      // The Host header is kept, so the API sees the console's own origin.
      proxy: { '/api': { target: apiOrigin } },
      fs: {
        strict: true,
      },
    },
    preview: {
      port,
      host: '0.0.0.0',
      allowedHosts: true,
    },
  };
});
