# Zipply

Private, direct browser-to-browser file sharing. No accounts, no server-side file storage, no analytics.

> **Status: pre-release (Phase 8 of 8 — release readiness).** All features are implemented and tested automatically. A production deployment and the real-device tests are still to come. The design has not been independently audited. See [`docs/RELEASE.md`](docs/RELEASE.md) for what is verified and what is not.

## How it works

1. Open Zipply on two devices. People in the same online lobby, or in a private room you share by link, appear on the radar.
2. Request a connection; the other person accepts it. The browsers connect directly over WebRTC.
3. Both screens show words. Each person reads three aloud and types the three they hear. If the words differ, the connection closes and nothing is shared.
4. Only then does the receiver see the file list and choose **Accept files**. Files arrive byte-for-byte, with every chunk and the stored copy checked by SHA-256, and are saved as ordinary downloads.

Without internet, two devices on the same local network can pair by exchanging a code or QR instead ([`docs/OFFLINE-MODE.md`](docs/OFFLINE-MODE.md)).

## What Zipply does and does not claim

- Files never pass through Zipply's servers, and file names and sizes are never sent to them. There is no upload endpoint.
- The three-word check detects a man-in-the-middle in the signaling path **when both people read and type the words over a channel they trust**. Zipply is not "MITM-proof" and cannot protect against a compromised device, a malicious browser extension or a compromised website serving different code.
- The other person's browser and the STUN server learn your IP address. Zipply is private by keeping little, not anonymous ([`docs/PRIVACY.md`](docs/PRIVACY.md)).
- The radar shows people in the same online room, not people nearby.
- There is no relay, so some networks cannot connect. Size and speed limits depend on the browser and the device ([`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)).

## Documentation

| Document                                                   | Contents                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| [`docs/PRIVACY.md`](docs/PRIVACY.md)                       | What is kept, what providers and the other person can see     |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)             | Components, diagram, connection flow, code layout             |
| [`docs/PROTOCOL.md`](docs/PROTOCOL.md)                     | Signaling and DataChannel messages                            |
| [`docs/SECURITY_DECISIONS.md`](docs/SECURITY_DECISIONS.md) | Security design, threat model and its evidence                |
| [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)           | Tested browsers and networks, known limitations               |
| [`docs/OFFLINE-MODE.md`](docs/OFFLINE-MODE.md)             | Offline app shell and local pairing                           |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md)               | Budgets, Lighthouse and PageSpeed checks, transfer benchmarks |
| [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md)             | Run your own copy and verify a deployment                     |
| [`docs/RELEASE.md`](docs/RELEASE.md)                       | Release checklist, deploy steps, release hashes               |
| [`SECURITY.md`](SECURITY.md)                               | Reporting a vulnerability                                     |

Project process: [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md), [`docs/PHASE_STATUS.md`](docs/PHASE_STATUS.md), [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md); canonical spec [`Zipply_Project_Plan.md`](Zipply_Project_Plan.md).

## Development

Requires Node.js 24 LTS (≥ 24.15, see `.nvmrc`) and npm 11.

```sh
npm ci                            # install from the lockfile
npm run check                     # lint, typecheck, unit tests, format check
npm run build                     # web build + Worker dry-run bundle (no upload)
npm run e2e                       # browser tests (first: npx playwright install chromium firefox webkit)
npm run bench                     # transfer benchmarks (not part of e2e)
npm run dev -w @zipply/signaling  # Worker at http://localhost:8787/healthz
npm run dev -w @zipply/web        # website at http://localhost:5173
```

Workspaces: `apps/web` (website), `apps/signaling` (Cloudflare Worker), `packages/protocol` (shared signaling protocol). Local settings: copy `apps/web/.env.example` to `apps/web/.env` and `apps/signaling/.dev.vars.example` to `apps/signaling/.dev.vars`.

## License

[MIT](LICENSE)
