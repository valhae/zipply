// Runs PageSpeed Insights API v5 (mobile and desktop, RUNS each) against the public production URL
// and saves each lighthouseResult. Usage: node scripts/performance/pagespeed.mjs <out-dir>
// Env: PAGESPEED_API_KEY (Actions secret), PAGESPEED_TARGET_URL (Actions variable).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed';
const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo'];
const RUNS = 3;
const ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries network errors, 429 and 5xx with 5 s, 10 s, 20 s waits; anything else fails at once. */
export async function fetchWithRetry(call, wait = sleep) {
  for (let attempt = 1; ; attempt++) {
    let problem;
    try {
      const res = await call();
      if (res.ok) return await res.json();
      problem = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) throw new Error(problem);
    } catch (e) {
      if (e instanceof Error && e.message === problem) throw e;
      problem ??= `network error (${e instanceof Error ? e.name : 'unknown'})`;
    }
    if (attempt >= ATTEMPTS) throw new Error(`${problem} after ${ATTEMPTS} attempts`);
    await wait(5000 * 2 ** (attempt - 1));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [out] = process.argv.slice(2);
  const key = process.env.PAGESPEED_API_KEY;
  const target = process.env.PAGESPEED_TARGET_URL;
  if (!out) throw new Error('usage: pagespeed.mjs <out-dir>');
  if (!key) throw new Error('PAGESPEED_API_KEY is not set');
  // Spec §42: only the public deployed site, never localhost or an unpublished preview.
  const url = new URL(target ?? '');
  if (url.protocol !== 'https:' || /^(localhost|127\.|\[::1\])/.test(url.hostname)) {
    throw new Error('PAGESPEED_TARGET_URL must be a public https:// URL');
  }
  mkdirSync(out, { recursive: true });
  for (const strategy of ['mobile', 'desktop']) {
    for (let run = 1; run <= RUNS; run++) {
      const query = new URLSearchParams({ url: url.href, strategy, key });
      for (const c of CATEGORIES) query.append('category', c);
      // The request URL holds the key, so it is never printed.
      const body = await fetchWithRetry(() =>
        fetch(`${ENDPOINT}?${query}`, { signal: AbortSignal.timeout(120_000) }),
      );
      writeFileSync(
        join(out, `psi-${strategy}-${run}.json`),
        JSON.stringify(body.lighthouseResult),
      );
      process.stdout.write(`PageSpeed ${strategy} run ${run}: done\n`);
    }
  }
}
