# Phase status

| #   | Phase                                                                    | Status                                       | Approved by user   | Exit evidence                                                  |
| --- | ------------------------------------------------------------------------ | -------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| 1   | Project foundation and development tooling                               | COMPLETE                                     | 2026-10-16         | Phase 1 evidence below; CI green on GitHub (run for `5f2ce91`) |
| 2   | Responsive UI/UX and radar interface                                     | COMPLETE — READY FOR REVIEW (owner approval) | 2026-10-16 (start) | Phase 2 evidence below (uncommitted, branch `phase-2-ui`)      |
| 3   | Core WebRTC file transfer                                                | NOT STARTED                                  | —                  | —                                                              |
| 4   | Online device discovery using Cloudflare                                 | NOT STARTED                                  | —                  | —                                                              |
| 5   | Security, peer authentication, and receiver consent                      | NOT STARTED                                  | —                  | —                                                              |
| 6   | Large-file optimization, integrity verification, and resumable transfers | NOT STARTED                                  | —                  | —                                                              |
| 7   | Offline QR/manual pairing and offline website caching                    | NOT STARTED                                  | —                  | —                                                              |
| 8   | Comprehensive testing, performance optimization, and release readiness   | NOT STARTED                                  | —                  | —                                                              |

## Phase 2 task log

Environment: Windows 11, Node v24.22.0, npm 11.15.0, Playwright 1.64.1 (Chromium, Firefox, WebKit builds bundled with it). Date: 2026-10-16. Branch `phase-2-ui`; changes left uncommitted for the owner.

| Task  | Status | Notes/limits                                                                                                                                                                           |
| ----- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-01 | DONE   | Tailwind v4 with default palette removed (`--color-*: initial`); light/dark/system theme persisted with storage-failure fallback; inline no-flash script (needs a CSP hash in P5-08)   |
| P2-02 | DONE   | Geist, Geist Mono, Geist Pixel Square self-hosted from `geist@1.8.1` (OFL, no reserved names), subset to Latin with fontTools 4.65.0: 168 KB → 85 KB; `OFL.txt` alongside              |
| P2-03 | DONE   | Button, Chip, Dialog (native `<dialog>`, bottom sheet below 640px — the "Sheet" primitive is this Dialog presentation), LiveRegion                                                     |
| P2-04 | DONE   | Header status badge (text, never colour-only), Discoverable switch default off, visibility explainer dialog, landmarks                                                                 |
| P2-05 | DONE   | SVG radar (decorative, `aria-hidden`, deterministic placement, 24-marker cap) mirrors the accessible PeerList; sweep only while connecting/online; reduced motion and hidden-tab pause |
| P2-06 | DONE   | Playwright + axe; 10-viewport matrix; CI job `e2e` added (not yet run on GitHub)                                                                                                       |
| P2-07 | DONE   | Bundle sizes recorded below                                                                                                                                                            |

### Phase 2 evidence (exact commands → actual results)

- TDD (RED observed before GREEN for each):
  - `theme.test.ts`: 10 failed against a stub → 15 passed.
  - `layout.test.ts`: tightened after 3 vacuous passes → 5 failed → 5 passed.
  - `status.test.ts`: 4 failed → 5 passed.
  - `App.test.tsx`: 2 failed → passed.
  - Sweep-while-offline test failed with the guard removed, then passed with it restored.
- `npm run check` → exit 0:
  - lint;
  - typecheck for protocol, signaling, web and `e2e`;
  - tests: protocol 31, signaling 9, web 32;
  - format clean; 0 warning lines.
- `npx playwright test` (Chromium, Firefox, WebKit) → **110 passed, 1 skipped**. The skip is the orientation-change test on Firefox only (see R9).
- Bugs found by the e2e suite and fixed:
  - Horizontal overflow of 8 px at widths ≤ 390 px, caused by the halftone layer (`-inset-6`). It is now contained on small screens.
  - WebKit focus-return failure: Safari does not focus buttons on mouse click. The test now uses keyboard activation, the case focus return exists for.
- axe wiring proven non-vacuous: injecting gray-400 text reports `serious color-contrast`.
- `npm run build` → JS 231.32 kB (**72.58 kB gzip**), CSS 20.36 kB (**5.20 kB gzip**), fonts 19.42 + 32.35 + 33.60 kB woff2. Budgets 200 kB / 40 kB gzip.
- Production build: demo fixtures absent (grep → 0 files), so the prod e2e shows "Offline" and 0 markers even with `?demo=few&connection=online`. No third-party requests (e2e). The only URL in the output is Tailwind's licence comment.
- `npm audit --audit-level=high` → 0. `gitleaks dir apps/web/src e2e` → no leaks.

### Design revision (2026-10-17, owner feedback before commit)

- Changes:
  - Theme switch now uses icons (sun/moon/monitor) with spacing.
  - Status badge is a pill.
  - Shared `SectionHeader` row, so both columns align.
  - One 56rem content width for header, hero, grid and footer.
  - Redesigned switch and visibility card.
  - Halftone moved to a single faded corner accent on the radar card.
  - People list aligned flush with its header.
- Radar alignment fixes:
  - Rings evenly spaced at radii 0.25 / 0.5 / 0.75 / 1.
  - Markers sit exactly on the 0.5 and 0.75 rings, at 15° slots (outer ring offset 7.5°), with collisions moved to the next free slot.
  - Hairlines are 1 px at any size (`non-scaling-stroke`).
  - The sweep is now an HTML conic-gradient layer the exact size of the outer ring. The old SVG `transform-origin` rotated off-centre.
- TDD: new layout tests failed first:
  - on-ring test failed with the old radii;
  - overlap test failed for 3 of 4 id families;
  - 7.5° slot test failed.

  All passed after the change (layout 11/11).

- `npm run check` → exit 0 (protocol 31, signaling 9, web 38). `npx playwright test` → 110 passed, 1 skipped (Firefox orientation, R9).
- Build: JS 73.15 kB gzip, CSS 5.63 kB gzip. Demo fixtures absent from production. `npm audit` → 0.

## Phase 1 task log

Environment for Phase 1 evidence unless stated: Windows 11 Home 10.0.26300, Node v22.14.0 (re-verified on Node v24.22.0 after the toolchain update, see below), npm 11.15.0, git 2.49.0, Git Bash. Date: 2026-10-16. Branch `phase-1-foundation` (local only, no remote).

| Task  | Status | Commit(s)                              | Notes/limits                                                                                                 |
| ----- | ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| P1-01 | DONE   | `903414e`                              | local repo only                                                                                              |
| P1-02 | DONE   | `45e1ed6`                              | content review by owner pending                                                                              |
| P1-03 | DONE   | `11d50a5`, `479dd63`                   | hand-written minimal Vite React-TS scaffold (equivalent to template, fewer files)                            |
| P1-04 | DONE   | `11d50a5`                              | no deploy; Worker tests run in workerd                                                                       |
| P1-05 | DONE   | `11d50a5`                              | envelope-level validation only; per-message schemas are P4-01                                                |
| P1-06 | DONE   | `11d50a5`                              | `react/no-danger` implemented via `no-restricted-syntax` (no extra plugin)                                   |
| P1-07 | DONE   | `247a2af` + gitleaks fix (uncommitted) | GitHub run 38920428271: check job PASSED; gitleaks job failed (action bug), fixed — re-run pending next push |
| P1-08 | DONE   | `479dd63`                              | local simulation; a real Vercel build needs approval                                                         |
| P1-09 | DONE   | `247a2af`                              | copyright holder `valhae` (renamed from `Eclipsaaaaa` on 2026-10-16)                                         |

### Evidence (exact commands → actual results)

**P1-01**

- `git init -b main` → repository created.
- `git check-ignore -v node_modules/ apps/web/dist/ .wrangler/ .env.local .dev.vars apps/signaling/.dev.vars` → every path matched an ignore rule. `.env.example` and `.dev.vars.example` matched only negation rules, so they are not ignored.

**P1-03 web**

- TDD RED: `npm test -w @zipply/web` against a stub `App` returning `null` → 2 failed ("Unable to find an accessible element with the role main").
- GREEN: `npm test -w @zipply/web` → 2 passed.
- `npm run build -w @zipply/web` → `dist/assets/index-*.js 219.79 kB │ gzip: 68.71 kB`.
- Built `dist/index.html` contains no external URLs (grep for `https?://` found none).

**P1-04 signaling**

- TDD RED: `npm test -w @zipply/signaling` against a stub returning 500 → 9 failed ("expected 500 to be 200/405/404").
- GREEN: 9 passed, run inside workerd via `@cloudflare/vitest-plugin`.
- `npm run build -w @zipply/signaling` (`wrangler deploy --dry-run`) → `Total Upload: 0.60 KiB`, "--dry-run: exiting now" (nothing uploaded).
- Live `wrangler dev` on the final commit: `GET /healthz` → `200 {"status":"ok","protocolVersion":1}`, `Content-Type: application/json`, `Cache-Control: no-store`. Earlier run on `11d50a5`: `POST /healthz` → 405, `GET /nope` → 404.
- `npx wrangler telemetry status` → "Disabled (set by wrangler config)".

**P1-05 protocol**

- TDD RED (always-reject stub): 6 accept/size tests failed. RED (always-accept stub): 30 of 31 failed, which proves every rejection test can fail.
- GREEN: 31 passed.
- `tsc --noEmit` passes with `lib: ["ES2022"]` and `types: []`, so the package uses no DOM or Workers APIs.

**P1-06 lint and format**

- `npx eslint .` → exit 0.
- Planted-violation proof (temporary files, deleted after): exit 1, 12 errors. These covered `innerHTML` assignment, `insertAdjacentHTML`, `document.write`, `eval`, `dangerouslySetInnerHTML`, and cross-runtime imports in web→signaling, signaling→web/react, and protocol→apps/`cloudflare:workers`.
- Re-run on the final commit → `no-restricted-imports` ×1 and `no-restricted-syntax` ×2 reported; planted file removed (0 dirty files).
- `npx prettier --check .` → "All matched files use Prettier code style!".

**Root gate (working copy, final commit)**

- `npm run check` → exit 0: lint, 3 typechecks, tests 31 + 9 + 2 = 42 passed, format check clean; 0 warning lines in the log.

**P1-07 CI**

- `.github/workflows/ci.yml` parses as YAML (Python `yaml.safe_load` → jobs `check`, `secrets`).
- Actions are pinned to commit SHAs: checkout v7.0.1, setup-node v7.1.0, gitleaks-action v3.0.0; `permissions: contents: read`.
- **First GitHub run (38920428271, commit `1719630`, pushed by the owner to `valhae/zipply`):** job "Lint, typecheck, test, build, audit" → success (all steps). Job "Secret scan (gitleaks)" → failure: `gitleaks-action` scans `<first pushed commit>^..HEAD`, and on the repository's first push that commit (`1587504`) is the root commit with no parent ("fatal: ambiguous argument … unknown revision"). No leak was involved.
- **Fix (uncommitted):** the workflow now installs the gitleaks v8.30.1 Linux binary (SHA-256 verified against the release checksums; archive mode `-rwxr-xr-x`) and scans the full history with `gitleaks git --redact --verbose --exit-code 1 .`. The install step was replayed locally (checksum OK, ELF x86-64 binary extracted).
- Local proof with the same version (Windows build, checksum verified): `gitleaks git --redact --verbose --exit-code 1 .` → "8 commits scanned … no leaks found", exit 0. Negative test: a folder containing a fake `ghp_` token → "leaks found: 1", exit 1.
- **Still pending:** a green gitleaks job on GitHub after the owner pushes this fix.

**P1-08 fresh clone (CI-equivalent and Vercel-style), on `479dd63`**

- Clone A (repo root): `npm ci` → exit 0; `npm run check` → exit 0 (42 tests passed); `npm run build` → exit 0 (Worker dry-run 0.60 KiB; web 68.71 kB gzip; built JS contains the protocol string); `npm audit --audit-level=high` → "found 0 vulnerabilities"; worktree unchanged.
- Clone B (simulating Vercel Root Directory `apps/web`): `cd apps/web && npm install` → exit 0, "found 0 vulnerabilities"; `npm run build` → exit 0, `dist/index.html` + `dist/assets/index-D_iJ9ArF.js`; lockfile unchanged.
- **Bug found and fixed:** the first Clone B build on `247a2af` failed with `ERR_MODULE_NOT_FOUND: Cannot find package 'vitest'`. Cause: `apps/web/vite.config.ts` imports `vitest/config`, but `vitest` was declared only at the root, so installing from `apps/web` skipped it. Fixed in `479dd63` by declaring `vitest` and `typescript` in each workspace that uses them; the same Clone B procedure then passed.

**P1-09** `README.md`, `LICENSE` (MIT), `SECURITY.md` committed. No deployment of any kind has been performed; `git remote` is empty.

**Supply chain**

- `@cloudflare/vitest-pool-workers` (named in the roadmap) is deprecated; it pinned a vulnerable miniflare (3 high, 2 moderate via `sharp`/`undici`). It was replaced by its official successor `@cloudflare/vitest-plugin@1.4.4`, which uses the same `wrangler@4.151.1`.
- `npm audit --audit-level=high` → 0 vulnerabilities, with no `overrides`.

**Toolchain update and owner rename (2026-10-16, after the Phase 1 report; left uncommitted for the owner to commit)**

- Local Node upgraded from v22.14.0 to **v24.22.0 LTS** using the official MSI from nodejs.org. Its SHA-256 `97ebad47…175088` matched the published `SHASUMS256.txt`; `msiexec` exit 0. Only one Node install remains. npm stays at the bundled 11.15.0 (npm 12 is a new major and CI's Node 24 also ships npm 11).
- `.nvmrc` 22 → 24; root `engines.node` → `>=24.15.0`; `jsdom` 29 → 30.1.3 (needs Node ≥ 24.15). Lockfile regenerated with a clean install.
- `npm outdated` now lists only TypeScript 7.0.2. It is still blocked because `typescript-eslint` supports TypeScript < 6.1; ESLint 10 is likewise blocked by `eslint-plugin-jsx-a11y` (≤ 9). Every other dependency is at its latest release.
- Copyright holder in `LICENSE` changed to `valhae`.
- Re-verified on Node v24.22.0:
  - `npm run check` → exit 0 (tests 31 + 9 + 2 passed, 0 warnings)
  - `npm run build` → exit 0
  - `npm audit --audit-level=high` → 0
  - clean copy of the working tree: root `npm ci` + `npm run check` → exit 0; `apps/web` install + build (Vercel-style) → exit 0
  - `wrangler dev` `/healthz` → 200; Vite dev server served the page.

### Phase 1 exit criteria

| #   | Criterion                                                                          | Result                                                                              |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Git initialized; tree clean; spec + skill + docs + CLAUDE.md committed             | PASS (0 dirty files; all files tracked)                                             |
| 2   | Fresh clone → `npm ci` → `npm run check` passes on Windows                         | PASS (Clone A)                                                                      |
| 3   | `npm run build` → `apps/web/dist` and Worker dry-run bundle                        | PASS                                                                                |
| 4   | Web dev server serves page; `wrangler dev` `/healthz` → 200                        | PASS (re-verified on final commit)                                                  |
| 5   | `@zipply/protocol` used by both apps; Vercel-style build passes                    | PASS (Clone B)                                                                      |
| 6   | Runtime deps only `react`, `react-dom` (+ internal protocol); `npm audit` high = 0 | PASS                                                                                |
| 7   | Lint rejects planted raw-HTML sink and cross-app import                            | PASS                                                                                |
| 8   | CI workflow committed and run                                                      | PASS (check job green on GitHub); gitleaks job green on GitHub pending the fix push |
| 9   | README, LICENSE, SECURITY.md present; nothing deployed                             | PASS                                                                                |

## Decisions log

| ID  | Decision                                                                                    | Date       | Status                                                               |
| --- | ------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- |
| —   | Initial roadmap and Phase 1 scope approved                                                  | 2026-10-16 | APPROVED by owner                                                    |
| D1  | License: MIT; copyright holder `valhae` (owner name updated 2026-10-16)                     | 2026-10-16 | APPROVED by owner                                                    |
| —   | Local git commits on a phase branch are allowed; no remote, no push                         | 2026-10-16 | APPROVED by owner                                                    |
| D2  | `ctx.storage.setAlarm()` used only as a timer for lease sweep                               | —          | PROPOSED (needed by P4-03)                                           |
| D3  | SAS v1 commit-then-reveal, six words                                                        | —          | PROPOSED (needed by P3-03)                                           |
| D4  | New DTLS association → fresh SAS; `restartIce()` first                                      | —          | PROPOSED (needed by P6-05)                                           |
| D5  | Integrity: per-chunk SHA-256 + digest-list root + read-back, no new dependency              | —          | PROPOSED (needed by P3-05/P6-02)                                     |
| D6  | STUN: `stun.cloudflare.com:3478` (free status unverified) vs Google                         | —          | PROPOSED (needed by P3-02)                                           |
| D7  | Per-IP rate limiting via Workers Rate Limiting binding only if confirmed on Free plan       | —          | PROPOSED (needed by P4-05)                                           |
| D8  | Shared `packages/protocol` workspace consumed as TS source                                  | 2026-10-16 | APPLIED in Phase 1 as part of the approved roadmap (P1-05)           |
| D9  | Hand-written strict validators (no runtime dependency)                                      | 2026-10-16 | APPLIED PROVISIONALLY in P1-05 (envelope only); confirm before P4-01 |
| D10 | SAS wordlist: BIP-39 English (license to confirm)                                           | —          | PROPOSED (needed by P3-03)                                           |
| D11 | Fonts: self-host Geist + Geist Mono + Geist Pixel Square (OFL confirmed); no Source Serif 4 | 2026-10-16 | APPROVED by owner; applied in P2-02                                  |
| D12 | Heartbeat 20 s / TTL 60 s via auto-response ping                                            | —          | PROPOSED (needed by P4-03)                                           |
| D13 | First public tag `v0.1.0`                                                                   | —          | PROPOSED (needed by P8-07)                                           |
| D14 | External actions approved individually (GitHub repo, staging Worker, Vercel, PSI key)       | —          | STANDING RULE; none approved yet                                     |
| D15 | Cross-phase parallelism                                                                     | —          | Default: strict sequence                                             |
| D16 | Available test devices                                                                      | —          | OPEN — owner to list                                                 |
| D17 | `Zipply_Project_Plan.md` unchanged; conflicts resolved in docs                              | 2026-10-16 | APPLIED (spec untouched, verified by `git diff 903414e HEAD`)        |
| D18 | Independent review of SAS design before public release                                      | —          | PROPOSED                                                             |

## Open risks

| ID  | Risk                                                                                                                            | Mitigation / status                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| R1  | SAS fingerprint extraction differs across browsers                                                                              | P3-01 spike, release-blocking                                                                                          |
| R2  | Free-quota exhaustion or abuse DoS                                                                                              | auto-response heartbeats, limits, honest "temporarily unavailable" state                                               |
| R3  | 10 GB receive infeasible on some browsers                                                                                       | capability detection, reject before transfer, published matrix (P6)                                                    |
| R4  | Users confirm SAS without comparing                                                                                             | copy/UX friction; residual                                                                                             |
| R5  | Supply-chain or served-JS compromise                                                                                            | minimal deps, lockfile, audit, SHA-pinned actions, CSP, release hashes; residual                                       |
| R6  | Scope creep from spec §43/§45                                                                                                   | post-MVP by roadmap                                                                                                    |
| R7  | (Resolved 2026-10-16) Local Node was older than current tools needed                                                            | Local Node upgraded to v24.22.0 LTS; `.nvmrc` = 24; jsdom 30                                                           |
| R8  | gitleaks job failed on the first push (action bug with root commit)                                                             | replaced the action with the pinned binary scanning full history; confirm green on next push                           |
| R9  | Headless Firefox (Playwright 1.64.1, Windows) crashes when resized below 1280px (`Target crashed`, reproduced on `about:blank`) | viewport set at context creation instead; mid-test resize (orientation) covered by Chromium/WebKit, skipped on Firefox |
| R10 | Skill gray-400 (`#a3a3a3`) fails WCAG AA as text in light theme (2.5:1)                                                         | readable meta text uses gray-500 (4.74:1); gray-400 decorative only                                                    |
