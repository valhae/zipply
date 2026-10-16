# Zipply

Privacy-first, browser-to-browser file sharing: no accounts, no server-side file storage, no analytics.

> **Status: early development (Phase 1 of 8 — project foundation).** Nothing is deployed and no file transfer exists yet. Claims about features, security or performance will be added only when they are implemented and tested.

## Planned design (not yet implemented)

- A static React website (Vercel) and a small signaling service (Cloudflare Workers + Durable Objects) for temporary online discovery.
- Files travel directly between browsers over WebRTC DataChannels, byte-for-byte, after both users compare a verification phrase and the receiver explicitly accepts.
- Details: [`docs/IMPLEMENTATION_ROADMAP.md`](docs/IMPLEMENTATION_ROADMAP.md), [`docs/SECURITY_DECISIONS.md`](docs/SECURITY_DECISIONS.md), canonical spec [`Zipply_Project_Plan.md`](Zipply_Project_Plan.md).

## Development

Requires Node.js 22 (see `.nvmrc`) and npm.

```sh
npm ci                          # install from the lockfile
npm run check                   # lint, typecheck, unit tests, format check
npm run build                   # web build + Worker dry-run bundle (no upload)
npm run dev -w @zipply/web      # website at http://localhost:5173
npm run dev -w @zipply/signaling  # Worker at http://localhost:8787/healthz
```

Workspaces: `apps/web` (website), `apps/signaling` (Worker), `packages/protocol` (shared signaling protocol).

## License

[MIT](LICENSE)
