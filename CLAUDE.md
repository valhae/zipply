# Zipply — instructions for Claude Code

Privacy-first browser P2P file sharing. Canonical spec: `Zipply_Project_Plan.md`. UI spec: `.claude/skills/bryl-minimal-design/SKILL.md`.
Roadmap: `docs/IMPLEMENTATION_ROADMAP.md`. Current phase + evidence: `docs/PHASE_STATUS.md`. Security rationale: `docs/SECURITY_DECISIONS.md`. Tests: `docs/TEST_PLAN.md`.

## Phase gates

- Work only inside the phase marked ACTIVE in `docs/PHASE_STATUS.md`. Never start the next phase, or a task from another phase, without explicit user approval.
- A task is done only when its acceptance criteria pass with recorded evidence (command + result) in `docs/PHASE_STATUS.md`.

## Non-negotiables (never trade away for brevity)

- No accounts, app database, KV/Redis/D1/R2, Durable Object SQL/storage records, analytics, trackers, ads, third-party scripts/fonts.
- File bytes and manifests never go through signaling. No upload endpoint. No compression/transcoding/resizing of files.
- No manifest before both local SAS confirmations; no payload before the receiver accepts files. Fail closed. No skip path.
- HTTPS/WSS in production; never fall back to `ws://`. Never log SDP, ICE candidates, filenames, capabilities, SAS inputs, resume tokens.
- Render untrusted strings as text; `dangerouslySetInnerHTML` and raw HTML sinks are banned (enforced by ESLint). Received files are inert downloads.
- Validate every signaling and DataChannel message at the boundary.
- Never claim proximity, guaranteed offline discovery, MITM-proof security, unlimited size, or fixed throughput.

## Requires explicit user approval

Creating/pushing a GitHub remote, any deploy (Cloudflare, Vercel, preview or prod), adding paid services or changing billing, adding a runtime dependency, changing protocol semantics or security decisions, editing `Zipply_Project_Plan.md`.
Local commits on a phase branch are approved (2026-10-16); never push.

## Commands (root)

`npm ci` · `npm run check` (lint + typecheck + unit tests + format check) · `npm run build` · `npm run format` · `npm run dev -w apps/web` · `npm run dev -w apps/signaling`

## Structure

`apps/web` (React UI; `src/features/{radar,presence,connection,transfer,pairing,settings}`, `src/ui/`) · `apps/signaling` (Worker + Room Durable Object) · `packages/protocol` (runtime-neutral signaling types/validators only, consumed as TS source) · `e2e/` · `docs/`.
Browser code never imports signaling code and vice versa; only `@zipply/protocol` is shared (enforced by ESLint). No `utils/` or `services/` catch-alls. Folders are created only when their phase needs them.

## Working style

- Smallest correct change; native/stdlib before dependencies (ponytail), but never at the cost of validation, security, a11y, error handling or tests.
- TDD for logic (superpowers:test-driven-development); systematic-debugging for failures; verification-before-completion before claiming done.
- Concise chat is fine; docs, security decisions, test evidence and failure reports are written in full sentences.
- Priority on conflict: user requirements & security/privacy > phase gates > approved decisions > style.
- Shell: Windows; Git Bash and PowerShell are both available. Use `npm` (not pnpm/yarn).
