# Zipply — Test Plan

This plan covers how Zipply is tested. Task-level tests are listed in the "Test" column of each phase table in `docs/IMPLEMENTATION_ROADMAP.md`. Evidence for every run is recorded in `docs/PHASE_STATUS.md`.

A passing suite is a regression baseline for the defined threat model. It does not prove the absence of vulnerabilities.

## 1. Layers and tools

| Layer                      | Tool                                                                 | Scope                                                                            | Introduced            |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------- |
| Web unit/component         | Vitest + React Testing Library + jsdom                               | UI logic, state machines, rendering of untrusted strings as text                 | P1                    |
| Worker / Durable Object    | Vitest + `@cloudflare/vitest-plugin` (runs in workerd)               | routing, origin checks, presence, limits, hibernation rebuild                    | P1 (health route), P4 |
| Protocol                   | Vitest (+ fast-check property tests from P4-01)                      | envelope and message validators, frames, gate state machine                      | P1, P3, P4            |
| Lint as a security control | ESLint                                                               | bans raw-HTML sinks, `eval`, cross-runtime imports                               | P1                    |
| Browser end-to-end         | Playwright + axe-core                                                | viewport matrix, accessibility, two-page WebRTC transfers, MITM harness, offline | P2+                   |
| Website performance        | Lighthouse CI (preview build), PageSpeed Insights API (deployed URL) | load performance, a11y, best practices, SEO                                      | P8                    |
| Transfer performance       | dedicated benchmark harness                                          | throughput, memory, resume time                                                  | P6                    |
| Manual                     | real devices and networks                                            | Safari/iOS/Android, Wi-Fi/hotspot/VPN/separate networks, screen readers          | P5–P8                 |

Root commands: `npm run check` (lint + typecheck + unit tests + format check), `npm run build`, `npm run e2e` (Playwright: starts the Vite dev server for `?demo=` fixture tests and a production preview on port 4173; first run needs `npx playwright install chromium firefox webkit`). The CPU-heavy WebRTC specs (`e2e/transfer.spec.ts`, `e2e/webrtc-spike.spec.ts`) run as separate `<engine>-webrtc` projects after the UI projects; they use the real app through the local signaling Worker (Playwright starts `wrangler dev` on port 8787 with an explicit test origin allowlist, and both web servers get `VITE_SIGNALING_URL=ws://localhost:8787/ws`), and skip where the browser build has no `RTCPeerConnection` (Playwright WebKit on Windows). On GitHub's Linux runners, Firefox gathers no ICE candidates and WebKit cannot resolve another page's mDNS candidate. CI therefore runs the WebRTC specs on Chromium (all) and WebKit (single-page spike only), and Firefox WebRTC evidence comes from local runs (see PHASE_STATUS, Phase 3 CI result).

## 2. Phase-by-phase inventory

The phase tables in `docs/IMPLEMENTATION_ROADMAP.md` are authoritative. Summary:

- **P1:** web smoke render; Worker `/healthz` 200, 404 elsewhere, 405 for wrong method; envelope parser rejects malformed JSON, non-objects, unknown fields, wrong version, bad type, oversize input; lint demonstrably rejects a planted raw-HTML sink and a planted cross-app import; Vercel-style build from a fresh clone.
- **P2:** theme logic, self-hosted fonts only (no external requests), dialog keyboard/Escape/focus return, radar ↔ list parity, viewport overflow matrix, axe (0 serious/critical).
- **P3:** SAS vectors and MITM spike, gate state machine (exhaustive transitions), frame validation, backpressure, byte-exact transfers, and "0 manifest / 0 payload bytes" on reject or mismatch.
- **P4:** message schemas, origin/path checks, presence/hibernation rebuild, routing authorization, limits, private-room capability, client presence state machine, two-page discovery via `wrangler dev`.
- **P5:** the mandatory security suites in section 3.
- **P6:** sinks, integrity fault injection, checkpoints, resume at 1/50/99 %, cancel races, benchmarks, 1 GiB automated and 10 GiB manual.
- **P7:** offline reload, cache-content assertion (app shell only), offline manual pairing, QR on real devices.
- **P8:** browser/device and network matrices, Lighthouse CI gate, PageSpeed reports, release checklist.

## 3. Mandatory security suites (all release-blocking)

- Spec §31 (frontend, Worker, protocol, WebSocket abuse, end-to-end) → P4 and P5-06.
- Spec §36 consent tests (reject connection, mismatch, reject files, accept, cancel in every state, out-of-order/duplicate messages, chunk before approval/after cancel) → P3-09 and P5-05.
- Spec §38.7 MITM tests:
  - fingerprint substitution → P5-01
  - valid path → P3-09
  - server forgery → P5-02
  - no skip path → P5-03
  - phrase mismatch → P3-09/P5-01
  - replay → P5-04
  - reconnect → P6-04/05
  - display-name spoofing → P5-06
  - manifest privacy → P5-07
  - ICE/logging privacy → P5-07
  - origin and transport → P4-02/P5-08
  - malicious front-end limits → P8-06
  - active-file hazards → P5-08
  - privacy UI → P5-09
- Spec §38.8 release-blocking rules → checked in P8-07.

## 4. Transfer, integrity and resume suites

Spec §30 (zero-byte, one-byte, chunk boundary, boundary + 1, multi-file, arbitrary binary; missing/duplicate/reordered/truncated/oversized chunks; digest mismatch; byte-exact comparison) → P3 and P6. Spec §35 resume tests → P6.

## 5. Measurable targets

These are goals that are measured, never guaranteed. Website performance and transfer performance are measured and reported separately.

- **Web:** initial JS ≤ 200 KB gzip, initial CSS ≤ 40 KB gzip. Lighthouse CI floors: Performance ≥ 90; Accessibility, Best Practices and SEO ≥ 95. PSI goals: mobile 95, desktop 98, Accessibility 100. Lab CLS ≤ 0.1.
- **Accessibility:** 0 serious/critical axe violations at all matrix viewports. Manual keyboard and screen-reader pass on the SAS, consent and cancel dialogs.
- **Responsive:** no document-level horizontal overflow at the §40 viewport list. An orientation change preserves connection and transfer state.
- **Transfer:**
  - Byte-exact output on every fixture.
  - The sender's buffered amount never exceeds the high watermark.
  - Chromium heap growth during a 1 GiB transfer stays below a bound set from the P6-07 baseline.
  - Resume at 1/50/99 % succeeds byte-exact in 20 of 20 local runs.
  - No false "completed" under fault injection.
  - Throughput is recorded per environment; a > 20 % median drop against the baseline on the same machine is flagged as a regression.
- **Signaling:** time from page ready to WSS connected and peer-event latency recorded (p50/p95). Durable Object wake-ups per occupied room-hour measured against the quota math in SD-10.
- **Security:** every §38.7 test passing; 0 unresolved high/critical `npm audit` or CodeQL findings; no third-party origins in built output.

## 6. Evidence format

Every recorded result includes the exact command, date, environment (OS, Node version, browser and version, device, network where relevant), the actual result, and the artifact path if one exists. A check that could not be run is recorded as `NOT VERIFIED` with the reason. Outputs are never paraphrased into a pass.

## 7. Fixtures

- Binary fixtures are generated at test time from random bytes (sizes chosen per test) and are not committed.
- Only small, safe, redistributable media samples may be committed.
- No real user data, real filenames, live SDP/ICE dumps or secrets appear in fixtures, logs or CI artifacts.
