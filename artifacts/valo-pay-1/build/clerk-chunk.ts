import path from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/** Keep Clerk deferred, but expose its built URL so a failed fetch can be retried
 * with a new module URL. Browsers cache failed import() URLs for the page's life. */
export function clerkChunk(): Plugin {
  const name = 'virtual:clerk-session-url';
  let config: ResolvedConfig;
  return {
    name: 'clerk-session-url',
    configResolved(resolved) { config = resolved; },
    resolveId(id) { if (id === name) return '\0' + name; },
    load(id) {
      if (id !== '\0' + name) return;
      if (config.command === 'serve') return `export default ${JSON.stringify(`${config.base}src/lib/clerk-session.tsx`)};`;
      const reference = this.emitFile({ type: 'chunk', id: path.resolve(import.meta.dirname, '../src/lib/clerk-session.tsx'), preserveSignature: 'strict' });
      return `export default import.meta.ROLLUP_FILE_URL_${reference};`;
    },
  };
}
