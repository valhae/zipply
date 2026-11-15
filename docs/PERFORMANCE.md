# Zipply — Performance

Two different things are measured, and neither is a guarantee:

- **Website loading** (how fast the page opens and how well it scores in Lighthouse): bundle budgets, a Lighthouse gate on every push, and PageSpeed Insights on the deployed site.
- **File transfer** (throughput and memory): a separate benchmark, because Lighthouse and PageSpeed Insights do not measure WebRTC transfers.

## Budgets and floors

| What                                          | Limit                                         | Enforced by                                                                    |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| Initial JavaScript (before any user action)   | ≤ 200 kB gzip                                 | `scripts/performance/budget.mjs` in the Lighthouse CI workflow                 |
| Initial CSS                                   | ≤ 40 kB gzip                                  | same                                                                           |
| Lighthouse Performance (mobile and desktop)   | ≥ 90 (median of 3 runs)                       | `.github/workflows/lighthouse-ci.yml`, every push and pull request             |
| Lighthouse Accessibility, Best Practices, SEO | ≥ 95 (median of 3 runs)                       | same                                                                           |
| PageSpeed Insights, production URL            | the same floors by default (median of 3 runs) | `.github/workflows/pagespeed.yml`, daily, manual and after a production deploy |

Goals above the floors, from the spec (§14, §41), which are aimed for but not promised: PageSpeed mobile Performance 95, desktop 98, Accessibility 100, Best Practices and SEO 95; Core Web Vitals at the 75th percentile LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 where field data exists.

"Initial" means what `index.html` loads: its module script, module preloads and stylesheet. The QR encoder, the QR decoder (jsQR) and the local-pairing panel load only when used, and are listed separately in the budget report.

## Latest measurements

Local, 2026-11-15, Windows 11 laptop (the owner's 8 GB test machine), production build served by `vite preview` with the security headers, Lighthouse 13.6.0 on Playwright's Chromium 156:

| Category       | Mobile | Desktop |
| -------------- | ------ | ------- |
| Performance    | 97     | 100     |
| Accessibility  | 100    | 100     |
| Best Practices | 100    | 100     |
| SEO            | 100    | 100     |

Medians of 3 runs. Mobile lab metrics: FCP 0.76 s, LCP 2.17 s, TBT 132 ms, CLS 0. Initial bundle: 101.3 kB gzip JavaScript, 6.2 kB gzip CSS. React and React DOM are most of the JavaScript; the app's own code is the rest.

Single mobile runs on this laptop ranged from 74 to 97, and a one-line static page also scored as low as 90 here, so one run says little: the gate uses the median of three. GitHub's runners and PageSpeed's servers give their own numbers; read them in the workflow summaries.

PageSpeed Insights results exist only after a production deploy (see below).

## Running the checks locally

```sh
npm ci
npx playwright install chromium                           # Lighthouse uses Playwright's pinned Chromium
VITE_SIGNALING_URL=ws://localhost:8787/ws npm run build -w @zipply/web
node scripts/performance/budget.mjs apps/web/dist

# two terminals
npm run dev -w @zipply/signaling -- --port 8787 --var ALLOWED_ORIGINS:http://localhost:4173
npm run preview -w @zipply/web -- --strictPort --port 4173

node scripts/performance/lighthouse.mjs http://localhost:4173/ reports/lighthouse
node scripts/performance/compare-scores.mjs "Lighthouse (local)" reports/lighthouse
```

In PowerShell, set the variable first: `$env:VITE_SIGNALING_URL='ws://localhost:8787/ws'`. The signaling service runs so the page reaches its normal online state instead of logging connection errors. `reports/` is ignored by git.

Lighthouse 13.6.0 does not work with Google Chrome 157 (every run fails with `NO_NAVSTART`), which is one reason the scripts use Playwright's Chromium. The same error also happens now and then with Chromium 156, so `lighthouse.mjs` retries a run that fails that way, up to three times.

## Where to read the reports

- **Pull requests and pushes:** the "Lighthouse CI" workflow. Its job summary shows the bundle table and the score table. The full JSON reports are in the `lighthouse-reports` artifact, kept 14 days. Open one at [googlechrome.github.io/lighthouse/viewer](https://googlechrome.github.io/lighthouse/viewer/), which works in your browser.
- **Production:** the "PageSpeed Insights" workflow. It has the same summary, and the `pagespeed-reports` artifact is kept 30 days. These summaries and artifacts are the trend record; there is no database.
- **Warnings and failures:** a single run below a floor shows as a warning. A median below a floor fails the workflow. So does a form factor with no valid run, or an API error that persists after retries.

## PageSpeed Insights setup (owner)

1. Google Cloud: enable the PageSpeed Insights API and create an API key restricted to that API (spec §42).
2. GitHub → Settings → Secrets and variables → Actions → **Secrets**: `PAGESPEED_API_KEY`. The key is used only by the workflow runner. It is never put in a `VITE_*` variable, in the frontend or in a committed file, and the script never prints the request URL that contains it.
3. **Variables**: `PAGESPEED_TARGET_URL` = the public production URL, set after the production deploy. Until it is set, the workflow is skipped.
4. Optional variables to change a floor: `PAGESPEED_MIN_MOBILE_PERFORMANCE`, `PAGESPEED_MIN_DESKTOP_PERFORMANCE`, `PAGESPEED_MIN_ACCESSIBILITY`, `PAGESPEED_MIN_BEST_PRACTICES`, `PAGESPEED_MIN_SEO`. Empty means the default (90, 90, 95, 95, 95). The Lighthouse CI workflow uses the same defaults.

The workflow runs daily at 03:17 UTC, on demand (Actions → PageSpeed Insights → Run workflow), and on a successful GitHub `deployment_status` for the `Production` environment (Vercel's GitHub integration sends these; not yet observed here, because this repository deploys manually, so use the manual run after a deploy). After a deployment event it waits 60 seconds for the production alias to switch. It makes 6 API calls per run (3 mobile, 3 desktop) and retries a 429, a 5xx or a network error at most three times (after 5, 10 and 20 seconds).

## Changing a threshold responsibly

- Raise a floor once the measured medians have stayed clearly above it.
- Lower a floor only with a written reason in `docs/PHASE_STATUS.md` (or the release notes). The reason must name the report that shows the cause and the fix planned. A noisy run is not a reason; that is what the median and the warning are for.
- Never pass a gate by turning an audit off or skipping a category.

## File transfer performance

Transfer speed depends on the devices, the browsers and the network path. Zipply does not claim a speed. Benchmarks run with `npm run bench` (not part of `npm run e2e`) and are saved in `docs/benchmarks/` with their environment:

- Chunk size × watermark sweep over a loopback DataChannel in one page (2026-11-14, this laptop): about 10–13 MiB/s; no setting was reliably better than the defaults (64 KiB chunks).
- 1 GiB through the real app between two pages, including the read-back check (2026-11-14, this laptop): 7.6 MiB/s.

These numbers are low and were measured on one slow machine. The cause has not been measured; per-chunk SHA-256 and the read-back run on each page's main thread (R22). A faster path must keep every integrity check, and it is not part of this release.
