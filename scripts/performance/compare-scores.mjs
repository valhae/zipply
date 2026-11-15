// Applies score floors to Lighthouse results (local Lighthouse CI or PageSpeed Insights) and writes
// a Markdown summary. Usage: node scripts/performance/compare-scores.mjs <title> <dir-of-json>
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CATEGORIES = [
  ['performance', 'Performance'],
  ['accessibility', 'Accessibility'],
  ['best-practices', 'Best Practices'],
  ['seo', 'SEO'],
];
const METRICS = [
  ['first-contentful-paint', 'FCP', 'ms'],
  ['largest-contentful-paint', 'LCP', 'ms'],
  ['total-blocking-time', 'TBT', 'ms'],
  ['cumulative-layout-shift', 'CLS', ''],
  ['speed-index', 'Speed Index', 'ms'],
];
const FORM_FACTORS = ['mobile', 'desktop'];

/** Floors from env (docs/PERFORMANCE.md); an unset or empty variable means the default. */
const floor = (env, formFactor, id) => {
  const name =
    id === 'performance'
      ? `PAGESPEED_MIN_${formFactor.toUpperCase()}_PERFORMANCE`
      : `PAGESPEED_MIN_${id.replace('-', '_').toUpperCase()}`;
  const value = Number(env[name] || (id === 'performance' ? 90 : 95));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const valid = (r) =>
  !r.runtimeError && CATEGORIES.every(([id]) => typeof r.categories?.[id]?.score === 'number');

/** @returns {{ markdown: string, failures: string[], warnings: string[] }} */
export function summarize(results, env, title = 'Lighthouse') {
  const all = results.map((r) => r.lighthouseResult ?? r);
  const runs = all.filter(valid);
  const failures = [];
  const warnings = [];
  const cols = {};
  for (const ff of FORM_FACTORS) {
    const mine = runs.filter((r) => r.configSettings?.formFactor === ff);
    if (!mine.length) {
      failures.push(`${ff}: no valid run`);
      continue;
    }
    cols[ff] = { runs: mine.length, scores: {}, metrics: {} };
    for (const [id, label] of CATEGORIES) {
      const scores = mine.map((r) => Math.round(r.categories[id].score * 100));
      const value = median(scores);
      const min = floor(env, ff, id);
      cols[ff].scores[id] = value;
      if (value < min) failures.push(`${ff} ${label} ${value} < ${min}`);
      else if (scores.some((s) => s < min))
        warnings.push(`${ff} ${label}: one run scored ${Math.min(...scores)} (median ${value})`);
    }
    for (const [id] of METRICS) {
      const values = mine.map((r) => r.audits?.[id]?.numericValue).filter(Number.isFinite);
      if (values.length) cols[ff].metrics[id] = median(values);
    }
  }

  const cell = (ff, f) => (cols[ff] ? f(cols[ff]) : '—');
  const fmt = (v, unit) =>
    v === undefined ? '—' : unit ? `${Math.round(v).toLocaleString('en')} ms` : v.toFixed(3);
  const url = all.find((r) => r.finalDisplayedUrl)?.finalDisplayedUrl ?? '';
  const lines = [
    `## ${title}`,
    '',
    `URL: \`${url}\` · median of ${FORM_FACTORS.map((ff) => `${cell(ff, (c) => c.runs)} ${ff}`).join(', ')} run(s); ${all.length - runs.length} run(s) skipped (tool error)`,
    '',
    '| Category | Mobile | Desktop | Floor (mobile/desktop) |',
    '| --- | --- | --- | --- |',
    ...CATEGORIES.map(([id, label]) => {
      const [m, d] = FORM_FACTORS.map((ff) => floor(env, ff, id));
      return `| ${label} | ${cell('mobile', (c) => c.scores[id])} | ${cell('desktop', (c) => c.scores[id])} | ${m === d ? m : `${m}/${d}`} |`;
    }),
    '',
    '| Lab metric (median) | Mobile | Desktop |',
    '| --- | --- | --- |',
    ...METRICS.map(
      ([id, label, unit]) =>
        `| ${label} | ${cell('mobile', (c) => fmt(c.metrics[id], unit))} | ${cell('desktop', (c) => fmt(c.metrics[id], unit))} |`,
    ),
    '',
    failures.length ? `**Below floor:** ${failures.join('; ')}` : '**All floors met.**',
    ...(warnings.length ? ['', `Warnings (single runs): ${warnings.join('; ')}`] : []),
    '',
  ];
  return { markdown: lines.join('\n'), failures, warnings };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [title, dir] = process.argv.slice(2);
  if (!title || !dir) throw new Error('usage: compare-scores.mjs <title> <dir>');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const results = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const { markdown, failures, warnings } = summarize(results, process.env, title);
  process.stdout.write(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  for (const w of warnings) process.stdout.write(`::warning::${w}\n`);
  for (const f of failures) process.stdout.write(`::error::${f}\n`);
  process.exitCode = failures.length ? 1 : 0;
}
