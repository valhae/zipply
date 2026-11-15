import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize } from './compare-scores.mjs';
import { fetchWithRetry } from './pagespeed.mjs';

const lhr = (formFactor, scores, extra = {}) => ({
  configSettings: { formFactor },
  finalDisplayedUrl: 'https://example.test/',
  categories: Object.fromEntries(Object.entries(scores).map(([id, s]) => [id, { score: s }])),
  audits: { 'largest-contentful-paint': { numericValue: 1200 } },
  ...extra,
});
const good = { performance: 0.95, accessibility: 1, 'best-practices': 1, seo: 1 };

test('passes when every median meets its floor', () => {
  const r = summarize([lhr('mobile', good), lhr('desktop', good)], {});
  assert.deepEqual(r.failures, []);
  assert.match(r.markdown, /\| Performance \| 95 \| 95 \| 90 \|/);
});

test('fails on a median below the floor and on a missing form factor', () => {
  const low = { ...good, performance: 0.8 };
  const r = summarize([lhr('mobile', low), lhr('mobile', low), lhr('mobile', good)], {});
  assert.equal(r.failures.length, 2);
  assert.match(r.failures.join('\n'), /mobile Performance 80 < 90/);
  assert.match(r.failures.join('\n'), /desktop: no valid run/);
});

test('one low run is a warning, not a failure (median of three)', () => {
  const low = { ...good, performance: 0.7 };
  const runs = [lhr('mobile', good), lhr('mobile', low), lhr('mobile', good), lhr('desktop', good)];
  const r = summarize(runs, {});
  assert.deepEqual(r.failures, []);
  assert.equal(r.warnings.length, 1);
});

test('runs with a runtime error or a null score are ignored, not counted as zero', () => {
  const broken = lhr('mobile', { ...good, performance: null }, { runtimeError: { code: 'X' } });
  const r = summarize([broken, lhr('mobile', good), lhr('desktop', good)], {});
  assert.deepEqual(r.failures, []);
  assert.match(r.markdown, /1 run\(s\) skipped/);
});

test('floors come from the environment; empty means the default', () => {
  const env = { PAGESPEED_MIN_DESKTOP_PERFORMANCE: '98', PAGESPEED_MIN_SEO: '' };
  const r = summarize([lhr('mobile', good), lhr('desktop', good)], env);
  assert.deepEqual(r.failures, ['desktop Performance 95 < 98']);
});

test('a PageSpeed response is read through its lighthouseResult', () => {
  const r = summarize([{ lighthouseResult: lhr('mobile', good) }, lhr('desktop', good)], {});
  assert.deepEqual(r.failures, []);
});

const response = (status) => ({ ok: status === 200, status, json: async () => ({ status }) });

test('PSI: retries 429 and 5xx with bounded backoff, then succeeds', async () => {
  const statuses = [429, 503, 200];
  const waits = [];
  const out = await fetchWithRetry(
    async () => response(statuses.shift()),
    async (ms) => void waits.push(ms),
  );
  assert.deepEqual(out, { status: 200 });
  assert.deepEqual(waits, [5000, 10000]);
});

test('PSI: a 400 fails at once and gives up after the last attempt', async () => {
  let calls = 0;
  const bad = async () => (calls++, response(400));
  await assert.rejects(
    fetchWithRetry(bad, async () => {}),
    /HTTP 400/,
  );
  assert.equal(calls, 1);
  calls = 0;
  const down = async () => (calls++, response(500));
  await assert.rejects(
    fetchWithRetry(down, async () => {}),
    /HTTP 500/,
  );
  assert.equal(calls, 4);
});
