# Zipply — Release procedure and checklist

A release is ready only when every release-blocking item below passes with recorded evidence (P8-07). An item without evidence is **NOT VERIFIED** and blocks the release. Deploying to production and pushing a tag both need the owner's explicit approval; the owner runs them.

Status column as of 2026-11-15 (Phase 8, before the production deploy). Evidence lives in `docs/PHASE_STATUS.md` unless another file is named.

## 1. Product and security criteria (spec §14, §38.8)

| #   | Release-blocking item                                                                                    | Status       | Evidence / what is missing                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | License, README, architecture diagram, security policy, privacy explanation                              | PASS         | `LICENSE`, `README.md`, `docs/ARCHITECTURE.md`, `SECURITY.md`, `docs/PRIVACY.md`                                                              |
| 2   | Opening the site attempts WSS discovery automatically and shows a truthful state                         | PASS         | Phase 4 (P4-05, P4-09); `e2e/discovery.spec.ts`; staging checks                                                                               |
| 3   | Users understand the visibility scope and can become invisible or disconnect                             | PASS         | Phase 2/4 UI and tests (Discoverable switch, private rooms)                                                                                   |
| 4   | Presence is ephemeral; a restart clears it                                                               | PASS         | SD-10 (`room.test.ts`: no storage entries, rebuild from live sockets)                                                                         |
| 5   | Display names are not identity or authorization                                                          | PASS         | SD-05, SD-12; `room.test.ts`                                                                                                                  |
| 6   | Receiver approves the connection, then separately the files, after the channel is authenticated          | PASS         | SD-03, SD-04; `e2e/consent.spec.ts`, `session.test.ts`                                                                                        |
| 7   | The verification phrase is mandatory; mismatch, missing fingerprint or skipping fails closed before data | PASS         | SD-02, SD-03 property tests; `e2e/mitm.spec.ts`, `e2e/consent.spec.ts`                                                                        |
| 8   | No file names, sizes or manifests in signaling or logs                                                   | PASS         | P5-07 (`e2e/mitm.spec.ts` frame capture, schemas, `no-console` lint)                                                                          |
| 9   | A signaling MITM substituting fingerprints yields mismatched words and zero file bytes                   | PASS         | P5-01 (`e2e/mitm.spec.ts`, Chromium)                                                                                                          |
| 10  | Chunked transfer with backpressure                                                                       | PASS         | P3-05; `sender.test.ts`, benchmarks                                                                                                           |
| 11  | Byte count, chunk order and per-chunk/final integrity checked before success                             | PASS         | SD-06; `receiver.test.ts`, `e2e/large.spec.ts`                                                                                                |
| 12  | Received bytes identical to the source (integration tests)                                               | PASS         | `e2e/transfer.spec.ts`, `e2e/resume.spec.ts`, `e2e/pairing.spec.ts` (SHA-256 compared)                                                        |
| 13  | No compression, transcoding, resizing or format conversion                                               | PASS         | `grep` of `apps/web/src` (2026-11-15): `CompressionStream` only for pairing codes (SDP text), canvas only in the QR scanner; byte-exact tests |
| 14  | No upload endpoint or file storage on the backend                                                        | PASS         | `index.test.ts` (unknown paths → 404; staging `/upload` → 404, P4-10), storage lint rule (SD-10)                                              |
| 15  | Offline cache and manual pairing limitations documented                                                  | PASS         | `docs/OFFLINE-MODE.md`, `docs/COMPATIBILITY.md`                                                                                               |
| 16  | Large files bounded by tested resource limits                                                            | PASS (1 GiB) | P6-07/P6-08 automated up to 1 GiB; the 10 GiB manual check is NOT VERIFIED (owner, P6-08), and no size above 1 GiB is claimed                 |
| 17  | Cross-browser limitations and network failures documented                                                | PASS         | `docs/COMPATIBILITY.md` (rows not yet tested say so)                                                                                          |
| 18  | CI passes; a clean development setup is reproducible                                                     | NOT VERIFIED | Needs a green GitHub run of the release commit (CI, CodeQL, Lighthouse CI)                                                                    |
| 19  | The server cannot mark a peer as authenticated                                                           | PASS         | P5-02 (server forgery tests)                                                                                                                  |
| 20  | The UI never implies that names prove identity, the radar shows proximity, or connections are anonymous  | PASS         | P5-09 copy and tests; P7-05 offline copy                                                                                                      |
| 21  | The privacy text does not claim zero metadata processing by providers                                    | PASS         | `docs/PRIVACY.md` ("What the infrastructure providers see")                                                                                   |
| 22  | Independent review of the SAS design (D18)                                                               | NOT VERIFIED | Requested by the owner on 2026-11-14; results to be recorded before a public release                                                          |

## 2. Responsive and performance gates (spec §14)

| #   | Item                                                                           | Status           | Evidence                                                                        |
| --- | ------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------- |
| 23  | No horizontal scroll, clipped controls or overlay traps at the viewport matrix | PASS             | `e2e/layout.spec.ts` (10 viewports, 3 engines)                                  |
| 24  | Core flows operable by keyboard and touch                                      | PASS (automated) | `e2e/interaction.spec.ts`, `e2e/consent.spec.ts`; real mobile touch: see row 29 |
| 25  | Lighthouse floors on the preview build (Perf ≥ 90; A11y, BP, SEO ≥ 95)         | PASS locally     | `docs/PERFORMANCE.md`; GitHub run NOT VERIFIED until pushed                     |
| 26  | PageSpeed Insights on the production URL                                       | NOT VERIFIED     | Needs the production deploy and `PAGESPEED_TARGET_URL`                          |
| 27  | No third-party scripts, analytics, remote fonts or tracking                    | PASS             | P2-02 network assertion; CSP `default-src 'self'`                               |
| 28  | Initial JS ≤ 200 kB gzip, CSS ≤ 40 kB gzip                                     | PASS             | `scripts/performance/budget.mjs`: 101.3 kB / 6.2 kB                             |
| 29  | Critical flows repeated in at least one real mobile browser                    | NOT VERIFIED     | `docs/COMPATIBILITY.md` real-device rows (owner, after the deploy)              |

## 3. TLS and transport (spec §46)

| #   | Item                                                                          | Status       | How                                                                                                                |
| --- | ----------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| 30  | Site redirects HTTP → HTTPS, valid certificate, no mixed content              | NOT VERIFIED | `verify-deploy.mjs` on production; CSP forbids non-`self` loads                                                    |
| 31  | Signaling uses WSS only and rejects unexpected origins                        | NOT VERIFIED | `verify-deploy.mjs` on production (passed on staging, 2026-11-15)                                                  |
| 32  | TLS 1.3 negotiated by modern clients; TLS 1.2 minimum; no older versions      | NOT VERIFIED | `verify-deploy.mjs` on production (staging: 1.3 yes, 1.2 yes, 1.1 none, 2026-11-15)                                |
| 33  | Security headers on the real host                                             | NOT VERIFIED | `verify-deploy.mjs`; staging still runs a Phase 4 build without them                                               |
| 34  | DataChannel encryption and SAS tested separately from HTTPS/WSS               | PASS         | P5-01 MITM suite vs P4/P5-08 transport tests                                                                       |
| 35  | Docs never call WebRTC "TLS 1.3" or say TLS makes a malicious server harmless | PASS         | Review of `docs/` and `README.md`: HTTPS/TLS for the site, WSS/TLS for signaling, WebRTC/DTLS for the data channel |

## 4. Deploying production (owner, after approval)

Production uses the default Worker environment (`zipply-signaling`) and the Vercel project's production domain. Staging keeps its own Worker (`--env staging`).

1. `npm ci && npm run check && npm run build` on the release commit; CI green on GitHub.
2. In `apps/signaling/wrangler.jsonc`, set the top-level `"vars": { "ALLOWED_ORIGINS": "https://<production host>" }` (exact origin only), commit, then `npx wrangler deploy` in `apps/signaling`. Check `/healthz`.
3. `npx vercel deploy --prod -b VITE_SIGNALING_URL=wss://zipply-signaling.<subdomain>.workers.dev/ws -b VITE_STUN_URLS=stun:stun.cloudflare.com:3478` from the repository root.
4. Build locally with the same two values and run `node scripts/release/verify-deploy.mjs https://<production host> wss://zipply-signaling.<subdomain>.workers.dev/ws apps/web/dist reports/SHA256SUMS`. Every check must pass.
5. Set the GitHub Actions variable `PAGESPEED_TARGET_URL` to `https://<production host>/` and run the PageSpeed Insights workflow by hand.
6. Fill in the real-device and network rows of `docs/COMPATIBILITY.md`.
7. Record every result in `docs/PHASE_STATUS.md` and update the tables above.

Rollback: Vercel → Deployments → promote the previous production deployment; `npx wrangler rollback` in `apps/signaling` for the Worker.

## 5. Release hashes

The build is reproducible: two clean builds of the same commit with the same `VITE_SIGNALING_URL` and `VITE_STUN_URLS` produced identical files (2026-11-15, Windows; across operating systems not yet verified; `.gitattributes` forces LF line endings). So a release can publish the SHA-256 of every file it serves:

1. After step 4 above passes, `reports/SHA256SUMS` lists the hash of every file, and every deployed file matched it.
2. Attach `SHA256SUMS` to the GitHub release, with the two build variables used.
3. Anyone can rebuild the tag with those variables and compare (`sha256sum -c SHA256SUMS` inside `apps/web/dist`), or check the live site with `verify-deploy.mjs` (`docs/SELF-HOSTING.md`).

`dist/sw.js` also carries a version hash computed from every other file's name and contents, so one value identifies the whole build.

This shows that a site served the published files when someone checked. It cannot stop a compromised host from serving different files to some people, which no web page can rule out (SD-09).

## 6. Tag and release notes

Tag name (D13, proposed): `v0.1.0` for the first public release. The owner creates and pushes the tag. Release notes follow spec §27:

```markdown
## Zipply v0.1.0 — <date>

**What changed:** …
**Tested browsers and systems:** (from docs/COMPATIBILITY.md; untested combinations are not claimed)
**Largest tested file:** 1 GiB automated (Chromium, two pages, one machine); manual: …
**Connectivity:** direct WebRTC only (no relay in this version)
**Known issues:** see docs/COMPATIBILITY.md "Known limitations"
**Security fixes:** none / … (no exploit details before users can update)
**Upgrade:** press Reload on the update notice; self-hosters see docs/SELF-HOSTING.md
**Build:** VITE_SIGNALING_URL=…, VITE_STUN_URLS=…; SHA256SUMS attached
```
