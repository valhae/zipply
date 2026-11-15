# Zipply — Browsers, networks and known limitations

This page records what has actually been tested (P8-01, P8-02). A combination that has not been tested says **NOT VERIFIED**; it may work, but Zipply does not claim it. Evidence for every automated row is in `docs/PHASE_STATUS.md`.

## Browser and device matrix (P8-01)

Core flows: open the site and go online; discover a person; request and accept a connection; the three-word check (match and mismatch); accept and reject files; cancel; a byte-exact transfer; offline reload; local pairing.

### Automated (Playwright)

UI, layout and accessibility tests (10 viewports from 320×568 to 1440×900, axe with no serious or critical violations, keyboard-only flows, reduced motion, theme, orientation change) run on all three engines, locally on Windows 11 and on GitHub's Ubuntu runners.

| Flow                                                           | Chromium 156                                              | Firefox 157                                                                                                   | WebKit 27.2 (Safari's engine)                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| UI, layout, accessibility, production headers and CSP          | PASS (Windows, CI)                                        | PASS (Windows, CI)                                                                                            | PASS (Windows, CI)                                                                                                        |
| Discovery through the local signaling Worker                   | PASS                                                      | PASS                                                                                                          | PASS on CI; locally the two three-page tests time out on the 8 GB test machine under load (R17)                           |
| Two-page transfer, word check, consent, MITM and replay suites | PASS (Windows, CI)                                        | NOT VERIFIED on the final tree: Playwright's Firefox gathers no ICE candidates on this machine (R20) or on CI | NOT VERIFIED: no `RTCPeerConnection` in Playwright WebKit on Windows; on Linux CI only the single-page spike passes (R11) |
| Resume, ICE restart and large-file sinks (up to 1 GiB)         | PASS (Windows, CI)                                        | NOT VERIFIED                                                                                                  | NOT VERIFIED                                                                                                              |
| Offline reload; cache holds only the app shell                 | PASS                                                      | PASS                                                                                                          | PASS                                                                                                                      |
| Local pairing by code; QR decodes; fake-camera scan            | PASS (Windows; CI pending the owner's push of the QR fix) | NOT VERIFIED (R20)                                                                                            | NOT VERIFIED                                                                                                              |

Firefox WebRTC passed in Playwright on this machine during Phases 3–5 (until 2026-10-27), and the owner reported a successful manual check in real Firefox on 2026-11-14; the version and platform were not recorded.

### Real browsers and devices (owner)

Each row needs the deployed site over HTTPS, because phones need a secure context. Record the browser version and operating system.

| Browser           | Device / OS          | Online transfer (other device) | Mismatch closes, 0 files | Large file (> 256 MiB) sink            | Offline reload | Local pairing (QR / paste) | Result       |
| ----------------- | -------------------- | ------------------------------ | ------------------------ | -------------------------------------- | -------------- | -------------------------- | ------------ |
| Chrome (desktop)  | Windows 11           | —                              | —                        | folder picker                          | —              | —                          | NOT VERIFIED |
| Edge (desktop)    | Windows 11           | —                              | —                        | folder picker                          | —              | —                          | NOT VERIFIED |
| Firefox (desktop) | Windows 11           | —                              | —                        | OPFS staging + download                | —              | —                          | NOT VERIFIED |
| Safari            | macOS (optional, A3) | —                              | —                        | OPFS if `createWritable`, else refused | —              | —                          | NOT VERIFIED |
| Safari            | iOS                  | —                              | —                        | OPFS if `createWritable`, else refused | —              | —                          | NOT VERIFIED |
| Chrome            | Android              | —                              | —                        | OPFS staging + download                | —              | —                          | NOT VERIFIED |
| Firefox           | Android              | —                              | —                        | OPFS staging + download                | —              | —                          | NOT VERIFIED |

Earlier owner reports: a laptop on Wi-Fi and a phone on mobile data transferred successfully on the Phase 4 staging site (2026-10-20; browsers not recorded). Safari's verification words have never been checked against another browser (R1, R11); **Safari support must not be claimed until that row passes.**

## Network matrix (P8-02)

Zipply has no TURN relay, so the two browsers must reach each other directly. Some networks will always fail; Zipply says so instead of retrying invisibly.

| Network between the two devices                                         | Expected                                                                   | Result                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Same Wi-Fi                                                              | works (host or mDNS candidates)                                            | NOT VERIFIED                                                                    |
| One device on the other's phone hotspot                                 | works                                                                      | NOT VERIFIED                                                                    |
| Different networks (Wi-Fi ↔ mobile data)                                | often works through STUN; fails behind symmetric NAT / CGNAT on both sides | owner reported a success on staging (2026-10-20); NOT VERIFIED for this release |
| VPN on one device                                                       | may fail; Firefox with a VPN gathered no candidates (R16)                  | NOT VERIFIED                                                                    |
| Restrictive network (UDP blocked, corporate firewall, client isolation) | fails: no relay                                                            | NOT VERIFIED                                                                    |
| No internet, same local network (offline)                               | local pairing works if mDNS resolves                                       | NOT VERIFIED (`docs/OFFLINE-MODE.md`)                                           |

### How to fill in a row (owner)

1. Open the production site on both devices (record browser, version, OS and network).
2. Device A: Create private room, share the link; device B opens it and turns on Discoverable.
3. Send a small file and a file over 256 MiB; check words; Accept files. Compare SHA-256 of source and result (`Get-FileHash` on Windows, `shasum -a 256` on macOS; on phones compare the size, or move the file to a computer).
4. Repeat once and press Mismatch — cancel: both sides must say nothing was shared.
5. For the network rows, note whether it connected, how long it took, and the failure message if it did not.

## Known limitations

- **No relay (TURN).** Networks that block direct UDP connections, or where both sides are behind strict NAT, cannot connect. There is no setting that fixes this.
- **Your IP address is visible to the other person** and to the STUN operator (Cloudflare). There is no anonymous mode (`docs/PRIVACY.md`).
- **The radar is not a map.** It shows people in the same online room or lobby, not nearby people; Zipply never measures distance or location.
- **Display names prove nothing.** Only the three-word check, read and typed over a channel both people trust, authenticates the other device.
- **No resume after a reload.** Closing or reloading the page ends the transfer (D22). A transfer can resume only on a new connection in the same open tabs.
- **Large files** depend on the browser: over 256 MiB, Chrome and Edge on desktop save to a chosen folder, and others stage the file in the browser's private storage first, which is limited by its quota (smaller in private windows, R23) and by free disk space. Zipply refuses a transfer before it starts if no storage fits. There is no fixed maximum size, and no size beyond 1 GiB has been verified automatically; the 10 GiB check is manual and pending (P6-08).
- **Speed** is not guaranteed and was low on the test laptop (`docs/PERFORMANCE.md`).
- **Multiple downloads.** Browsers may ask once to allow a site to save several files.
- **Offline mode** needs one earlier online visit; the browser may evict the cached site; and local pairing needs both devices on the same local network (`docs/OFFLINE-MODE.md`).
- **Free hosting.** The signaling service runs on Cloudflare's free plan. When its daily quota is used up, the page says "Discovery temporarily unavailable" until the quota resets; local pairing still works.
- **Private rooms** expire after 30 minutes; peers are removed within 60 seconds after that, while an open direct connection continues.
- **Look-alike names** from other scripts can still look the same as another person's name.
- **A compromised website, extension or device** can defeat every protection in the page (`docs/SECURITY_DECISIONS.md` SD-09).
