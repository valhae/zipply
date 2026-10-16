import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Pause decorative animation while the tab is hidden.
document.addEventListener('visibilitychange', () =>
  document.documentElement.toggleAttribute('data-page-hidden', document.hidden),
);

// Dev-only transfer harness. The literal `import.meta.env.DEV` lets the production build drop it.
const DevHarness =
  import.meta.env.DEV && new URLSearchParams(window.location.search).has('harness')
    ? lazy(() => import('./features/connection/DevHarness'))
    : null;

createRoot(root).render(
  <StrictMode>
    {DevHarness ? (
      <Suspense fallback={null}>
        <DevHarness />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
