import { createRoot } from 'react-dom/client';

import App from './App';
import { migrateLegacyBrowserState } from '@/lib/browser-identity';
import { ErrorBoundary } from '@/components/error-boundary';
import { initTheme } from '@/lib/theme';

import './fonts.css';
import './index.css';

// Light or dark, from the device or the choice kept in this browser; index.html did the same before the first paint.
try {
  migrateLegacyBrowserState();
} catch {
  const notice = document.createElement('p');
  notice.setAttribute('role', 'alert');
  notice.textContent = 'Valo Pay 1 could not preserve this browser’s earlier request-recovery records. Nothing was sent. Allow site storage and reload, or ask your administrator to recover the browser records before continuing.';
  document.getElementById('root')!.replaceChildren(notice);
  throw new Error('Valo Pay 1 browser-state migration could not finish.');
}
initTheme();

createRoot(document.getElementById('root')!, {
  // Keeps caught errors off reportError(), which would raise the dev overlay.
  onCaughtError: (error, errorInfo) => {
    console.error(error, errorInfo.componentStack);
  },
}).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
