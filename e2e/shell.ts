import { expect, type Page } from '@playwright/test';

// P7-02 helpers shared by the offline and pairing specs (production build, service worker).

/** First visit: the service worker installs the shell and takes control of the page. */
export async function installShell(page: Page) {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

/** Every Cache Storage entry, as cache name → sorted paths. */
export const cached = (page: Page) =>
  page.evaluate(async () => {
    const out: Record<string, string[]> = {};
    for (const name of await caches.keys()) {
      const requests = await (await caches.open(name)).keys();
      out[name] = requests.map((r) => new URL(r.url).pathname).sort();
    }
    return out;
  });

/** The precache list the build wrote into sw.js. */
export async function shellList(page: Page) {
  const sw = await (await page.request.get('/sw.js')).text();
  return (JSON.parse(/"urls":(\[[^\]]*\])/.exec(sw)![1]!) as string[]).sort();
}
