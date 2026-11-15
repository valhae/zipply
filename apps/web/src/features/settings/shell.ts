/**
 * Offline app shell (P7-02): registers the service worker built from `apps/web/sw.js`. A new
 * version is never applied by itself, so a running transfer is not reloaded away; the user is
 * offered the update and applying it activates the waiting worker, then reloads this page.
 */
export function registerShell(
  onUpdate: (apply: () => void) => void,
  sw: ServiceWorkerContainer | undefined = navigator.serviceWorker,
  reload = () => location.reload(),
) {
  if (!sw) return;
  sw.register('/sw.js')
    .then((reg) => {
      const offer = () => {
        const waiting = reg.waiting;
        if (!waiting || !sw.controller) return; // the first install needs no reload
        onUpdate(() => {
          sw.addEventListener('controllerchange', reload, { once: true });
          waiting.postMessage('skip-waiting');
        });
      };
      offer();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => w.state === 'installed' && offer());
      });
    })
    .catch(() => {
      // no offline shell (blocked or unsupported); the site works online as before
    });
}
