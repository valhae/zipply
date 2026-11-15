// Runs Lighthouse (pinned) 3× mobile and 3× desktop on Playwright's pinned Chromium, retrying a run
// that ends in a Lighthouse runtime error (NO_NAVSTART is intermittent, even on a static page).
// Usage: node scripts/performance/lighthouse.mjs <url> <out-dir>
import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LIGHTHOUSE = 'lighthouse@13.6.0';
const RUNS = 3;
const TRIES = 3;

const [url, out] = process.argv.slice(2);
if (!url || !out) throw new Error('usage: lighthouse.mjs <url> <out-dir>');
// The command goes through a shell: allow only plain URL and path characters.
if (!/^https?:\/\/[\w.:/-]+$/.test(url) || /["$`]/.test(out)) throw new Error('unsafe argument');
mkdirSync(out, { recursive: true });
// CI: Ubuntu's AppArmor blocks Chromium's sandbox for unprivileged users; the page is our own build.
const flags = `--headless${process.env.CI ? ' --no-sandbox' : ''}`;

for (const ff of ['mobile', 'desktop']) {
  for (let run = 1; run <= RUNS; run++) {
    const file = join(out, `lighthouse-${ff}-${run}.json`);
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try {
        const args = [LIGHTHOUSE, url, ...(ff === 'desktop' ? ['--preset=desktop'] : [])];
        args.push('--only-categories=performance,accessibility,best-practices,seo', '--quiet');
        args.push(`--chrome-flags=${flags}`, '--output=json', `--output-path=${file}`);
        // One quoted command string: npx is a .cmd on Windows, which needs a shell.
        execSync(['npx', '--yes', ...args].map((a) => `"${a}"`).join(' '), {
          stdio: 'inherit',
          env: { ...process.env, CHROME_PATH: chromium.executablePath() },
        });
      } catch {
        // A runtime error still writes the report; checked below.
      }
      let error;
      try {
        error = JSON.parse(readFileSync(file, 'utf8')).runtimeError?.code;
      } catch {
        error = 'NO_REPORT';
      }
      process.stdout.write(`Lighthouse ${ff} run ${run} attempt ${attempt}: ${error ?? 'ok'}\n`);
      if (!error) break;
    }
  }
}
