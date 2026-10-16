import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

// Pause decorative animation while the tab is hidden.
document.addEventListener('visibilitychange', () =>
  document.documentElement.toggleAttribute('data-page-hidden', document.hidden),
);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
