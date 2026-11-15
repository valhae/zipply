// P8-05: gzip size of what index.html loads before any user action (scripts, modulepreloads,
// stylesheets) against the spec §41 budgets; lazy chunks are listed for information.
// Usage: node scripts/performance/budget.mjs apps/web/dist
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = { js: 200_000, css: 40_000 };

const dist = process.argv[2];
if (!dist) throw new Error('usage: budget.mjs <dist>');
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const initial = new Set(
  [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]),
);
const gz = (f) => gzipSync(readFileSync(join(dist, f))).length;
const kb = (n) => `${(n / 1000).toFixed(2)} kB`;

const total = { js: 0, css: 0 };
for (const f of initial) total[f.endsWith('.css') ? 'css' : 'js'] += gz(f);
const lazy = readdirSync(join(dist, 'assets'))
  .map((f) => `assets/${f}`)
  .filter((f) => f.endsWith('.js') && !initial.has(f));

const over = Object.keys(BUDGET).filter((k) => total[k] > BUDGET[k]);
const markdown = [
  '## Initial bundle budget (gzip)',
  '',
  '| Kind | Initial | Budget |',
  '| --- | --- | --- |',
  `| JavaScript | ${kb(total.js)} | ${kb(BUDGET.js)} |`,
  `| CSS | ${kb(total.css)} | ${kb(BUDGET.css)} |`,
  '',
  `Lazy chunks (not in the budget): ${lazy.map((f) => `\`${f.slice(7)}\` ${kb(gz(f))}`).join(', ') || 'none'}`,
  '',
  over.length ? `**Over budget:** ${over.join(', ')}` : '**Within budget.**',
  '',
].join('\n');

process.stdout.write(markdown);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
process.exitCode = over.length ? 1 : 0;
