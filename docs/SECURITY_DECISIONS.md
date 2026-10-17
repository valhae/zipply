# Zipply — Security Decisions

Each entry records: **Status** (Proposed / Accepted / Superseded), **Context**, **Decision**, **Consequences**, **Evidence**.
"Proposed" means the design was approved as part of the roadmap, but the specific choice still awaits explicit owner confirmation (see the decisions log in `docs/PHASE_STATUS.md`) and/or proof by a named test. Nothing here is a claim that a control works until its Evidence field cites a passing test.

The threat model table in `Zipply_Project_Plan.md` §38.1 and the release-blocking rules in §38.8 apply in full and are not repeated here. The claim Zipply may make is: **a signaling-layer man-in-the-middle is detected when both users correctly compare the verification phrase.** Zipply must never claim to be "MITM-proof", anonymous, or safe against a compromised endpoint, malicious served JavaScript, hostile browser extensions, or a user who approves without comparing.

---

## SD-01 — DTLS encryption is not peer authentication

- **Status:** Accepted (planning, 2026-10-16).
- **Context:** WebRTC DataChannels are encrypted with DTLS to whatever certificate fingerprint appears in the remote SDP. The SDP arrives through the signaling service. A malicious or compromised signaling service can substitute its own fingerprints and terminate two separate DTLS sessions (RFC 8827 §6.5). HTTPS/WSS only protects the hop between a browser and Cloudflare.
- **Decision:** Treat DTLS as transport encryption only. Peer authenticity comes from an independently compared short authentication string (SD-02). No server message can mark a peer as verified.
- **Consequences:** Every new connection requires a user verification step before any file metadata or bytes flow.
- **Evidence:** Design analysis. MITM tests are scheduled in P3-01 (spike) and P5-01 (harness).

## SD-02 — Short authentication string (SAS) v1 with commit-then-reveal

- **Status:** Accepted for Chromium and Firefox (owner chose the recommended options D3 and D10 on 2026-10-17; P3-01 findings below). Safari/WebKit unverified. Independent review before public release is still required (D18).
- **Context:** The spec (§38.3) derives a six-word phrase from both DTLS SHA-256 fingerprints and fresh nonces, but it does not commit to the nonces. If nonces travel unprotected through signaling, an intermediary can choose its own values after seeing the honest ones.
- **Decision (protocol):** Roles: **O** = offerer/requester, **A** = answerer.
  1. O generates a 16-byte nonce `nO` (via `crypto.getRandomValues`) and a 16-byte `connId`. It computes `cO = SHA-256("zipply/sas-commit/v1" ‖ connId ‖ nO)` and sends `offer{connId, sdp, cO}` via signaling.
  2. A refuses any offer without a well-formed `cO`. It generates a 16-byte `nA` and sends `answer{connId, sdp, nA}`.
  3. When the DataChannel opens, O sends `sas-reveal{nO}`. A checks that `SHA-256("zipply/sas-commit/v1" ‖ connId ‖ nO)` equals `cO`; if not, A fails closed.
  4. Each side parses the `sha-256` `a=fingerprint` lines from `currentLocalDescription` and `currentRemoteDescription`. Fingerprints are normalized (uppercase hex, no colons), deduplicated and sorted, and ordered **by role (O then A)**, not by local/remote. Missing fingerprints, or no sha-256 fingerprint, fails closed.
  5. Transcript `T` is the length-prefixed concatenation of `"zipply/sas/v1"`, the protocol version, `connId`, O's fingerprints, A's fingerprints, `cO`, `nO` and `nA`. `D = SHA-256(T)`. The first 66 bits of `D` become six 11-bit indices into a fixed 2,048-word list, which gives the phrase.
  6. Each device shows its phrase. The users compare it in person or over an independent trusted channel. The only controls are **"The words match"** and **"Mismatch — cancel"**. There is no skip, "trust this name" or "continue anyway".
  7. After local confirmation, each side sends `sas-confirm{D}` over the DataChannel. A side unlocks the manifest only when its own local confirmation is set **and** it has received a `sas-confirm` carrying an identical `D`. A remote message can never set the local confirmation.
  8. Any mismatch, timeout, cancellation, reused nonce or fingerprint change closes the `RTCPeerConnection` and purges `nO`, `nA`, `cO` and `D`. A retry uses a fresh `connId` and fresh nonces.
- **Why the commitment matters:** an intermediary must fix its offer to A (fingerprint and its own commitment) before A chooses `nA`, and must fix its answer to O before it learns `nO`. After that it has no value left to adjust, so the two phrases match with probability 2^-66 per attempt, and offline grinding isn't possible.
- **Binding to the live session:** the browser itself enforces that the DTLS peer certificate matches the fingerprint in the remote description. The DataChannel only exists over that DTLS association, so `D` describes exactly the keys protecting the file bytes.
- **Consequences:** Users must compare six words for every new connection. This is a human-factor risk (planning risk R4): users may click "match" without comparing. Copy and UI friction reduce this risk but cannot eliminate it.
- **Evidence required (release-blocking, P3-01):** (a) sha-256 fingerprint lines parse identically in Chromium, Firefox and Safari for local and remote descriptions. (b) A MITM page relaying between two pages with substituted fingerprints yields different phrases. (c) The unchanged path yields identical phrases. (d) `restartIce()` keeps the same fingerprints and DataChannel. (e) `maxMessageSize` is recorded per browser. If (a) fails on a browser, that browser is unsupported for transfers until resolved.
- **Evidence (P3-01, 2026-10-17, Windows 11, Playwright 1.64.1, `e2e/webrtc-spike.spec.ts`, real `sas.ts` in the page):**
  - (a) PASS on Chromium 156.0.8078.4 and Firefox 157.0. Each side's local fingerprint parses to the same value as the other side's remote fingerprint, and it equals the `sha-256` fingerprint of a certificate from `RTCPeerConnection.generateCertificate()`. Both browsers emit one `a=fingerprint:sha-256` line.
  - (b) PASS on both. A page-level relay (Alice ↔ M1, M2 ↔ Bob, forwarding data and even the honest nonces) produced different phrases on the two ends. Separately, replacing the fingerprint in the answer SDP with another certificate's, without terminating DTLS, left `connectionState` at `failed` and the channel never opened. The browser enforces the fingerprint, which is what binds D to the live session.
  - (c) PASS on both. The unchanged path gives identical digests and phrases.
  - (d) PASS on both. After `restartIce()` and a new offer/answer, the ICE ufrag changed, the fingerprints did not, and the existing DataChannel still delivered a message. Phase 3 still refuses any second description; P6-04 will add the restart path.
  - (e) `pc.sctp.maxMessageSize` = 262,144 (Chromium) and 1,073,741,823 (Firefox); a 65,606-byte frame (64 KiB payload + 70-byte header) arrived intact on both.
  - Safari/WebKit: **NOT VERIFIED.** Playwright's WebKit build on Windows has no `RTCPeerConnection`, so the 6 spike tests are skipped there. A real Safari (macOS/iOS) check is required before Safari can be called supported (P8-01).
  - **Go/no-go:** GO for SAS v1 on Chromium and Firefox. Unit evidence: pinned digest test vector, transcript cross-check against an independent construction, role-order and single-bit-change properties (200 random runs each), and commitment mismatch failing closed (`sas.test.ts`, `session.test.ts`).

## SD-03 — Gate preconditions before a manifest or file bytes

- **Status:** Accepted (planning). Implementation in P3-04, adversarial tests in P5-03.
- **Decision:** A pure state machine is enforced on **both** peers. A manifest may be sent or rendered only if all of these hold:
  - the DataChannel is open;
  - the commitment was verified;
  - the fingerprints are unchanged since the phrase was computed;
  - the local SAS confirmation is set;
  - a remote `sas-confirm` with an equal `D` was received;
  - the state is not terminal.

  File bytes may be sent or accepted only if, in addition, the receiver sent `files-accept{transferId, manifestDigest}` matching the current manifest. The sender's `send()` throws outside an allowed state. The receiver drops any out-of-state frame, counts a violation, and closes the connection after one payload-frame violation.

- **Consequences:** Consent and verification are protocol properties, not just hidden buttons.
- **Evidence (P3-04/P3-09):** `gate.test.ts` checks every state × event pair (140 transitions): illegal events fail closed and terminal states absorb everything. `session.test.ts` and `e2e/transfer.spec.ts` count bytes at `RTCDataChannel.send`: rejecting the connection, a mismatch, and rejecting the files all leave payload bytes at 0, and the first two also leave manifest bytes at 0. A payload frame before acceptance closes the connection, and forged messages such as `{"t":"verified"}` fail it.

## SD-04 — Consent model and advisory signaling cancel

- **Status:** Accepted (planning).
- **Decision:** The receiver makes three distinct decisions: accept/reject the connection (via signaling, with no file metadata), accept/reject the files (on the DataChannel, after SAS), and cancel (available in any active state). All three are idempotent. Terminal states (`rejected`, `canceled`, `failed`, `completed`) ignore every late message. A cancel routed through signaling cannot be authenticated, because the signaling path is exactly what an attacker would control. It is therefore **advisory**: it may stop or pause a transfer, never start, resume or accept one. A sender cancel stops enqueueing immediately and sends `transfer-cancel` on the DataChannel. The receiver aborts its sink and deletes partial data after a cancel.
- **Consequences:** A malicious signaling service can force cancellations. This is a denial of service it could cause anyway.

## SD-05 — Identifiers, expiry, replay protection, validation and rate limits

- **Status:** Accepted (owner, 2026-10-17: D2 alarm sweep, D9 hand-written validators with fast-check property tests, D12 20 s / 60 s; D7: no per-IP limiting in Phase 4).
- **Decision:**
  - `peerId`, `requestId`, `connId`, `transferId` and resume capabilities are 128-bit random values in base64url. The server assigns `peerId` and binds it to one socket. A display name never grants authority.
  - A private-room invite capability is 16 random bytes followed by a 4-byte expiry (epoch minutes). The route used in the WebSocket path is `base64url(SHA-256(capability))`. The capability itself travels only in the URL fragment (never sent to servers or in referrers) and in `hello`. The Durable Object verifies the preimage and the expiry, which makes the scheme stateless and unforgeable. Default expiry: 30 minutes.
  - A pending `connection-request` expires after 60 seconds. Offer, answer and ICE messages are routed only between the two parties of a live pending request, which is kept in socket attachments so it survives hibernation. One-time ids are consumed on use.
  - Strict validators reject unknown types, unknown fields, unsupported versions and oversized messages (64 KiB envelope, SDP ≤ 16 KiB, candidate ≤ 1 KiB). Display names that aren't NFC-normalized or that contain control/bidi characters are rejected; the limit is 32 characters.
  - Limits: a per-socket token bucket (stored in the attachment), a maximum number of sockets per room, at most 10 pending requests per socket, and a connection-request rate limit. Per-IP limits only if D7 is approved and the binding is confirmed available on the Free plan.
- **Evidence:** P1-05 implements the envelope-level checks (version, shape, unknown top-level fields, size).
- **Evidence (Phase 4):**
  - `packages/protocol/src/messages.test.ts` (100 tests in the package): every message type round-trips. Unknown types, extra keys (fast-check, 1,000 runs), non-canonical ids, oversized SDP and candidates, file-metadata fields in `connection-request` and server trust flags (`verified`) are all rejected. Display names follow the SD-05 rules (fast-check agreement test).
  - `apps/signaling/test/room.test.ts`: random server-assigned peer ids. Requests to unknown, hidden or own ids answer `PEER_NOT_FOUND`. Signals are routed only within an accepted pair and in the right direction. A third party cannot use another pair's request id. Rejected, canceled and expired ids cannot be revived. A disconnect cancels the request for the other side. A flood is throttled without affecting others. Pending requests are capped at 10 and sockets at 100.
  - Private rooms are admitted only with the matching, unexpired capability, and stay separate from the lobby.
  - **Per-IP limits are not implemented (D7).** A single client can still open many sockets until the room cap (100) is reached. This quota/DoS risk stays residual (R2) until a staging deploy lets us check the Rate Limiting binding on the Free plan.

## SD-06 — Integrity scheme (integrity ≠ authentication)

- **Status:** Accepted (owner chose the recommended option D5 on 2026-10-17). Per-chunk and root checks are implemented in P3; post-commit read-back comes with the disk sinks in P6-02.
- **Context:** `crypto.subtle.digest` is one-shot, not incremental, so Web Crypto alone cannot hash a 10 GB file in bounded memory.
- **Decision:** Each chunk is hashed with SHA-256 by the sender and verified by the receiver before it is written. A final root equals `SHA-256` of the concatenated chunk digests. After the sink is committed, the receiver re-reads the stored file to verify it. No new dependency is needed.
- **Evidence (P3):** `receiver.test.ts` shows that a flipped payload byte, a wrong root, a skipped, duplicate or out-of-order chunk, and bytes beyond the declared size each fail and never yield a download. `e2e/transfer.spec.ts` compares the SHA-256 of every downloaded file with its source (0 B to 50 MiB) in Chromium and Firefox.
- **Consequences:** These checks detect corruption, bugs and splice errors. They do **not** authenticate the sender: authenticity comes from the SAS-verified channel the hashes travel on. A verified peer can still send malicious content, so received files are always inert downloads (`application/octet-stream`, sanitized filename, never rendered inline). There is no single whole-file SHA-256 comparable to `sha256sum` unless D5 changes.

## SD-07 — Reconnect and resume authorization

- **Status:** Proposed (D4).
- **Decision:**
  - If signaling drops while the DataChannel stays alive, the transfer continues.
  - On ICE failure, call `restartIce()` over signaling. This keeps the same DTLS association, so no new SAS is needed (to be confirmed by P3-01 (d)).
  - If a new `RTCPeerConnection` is required: run a new SAS (spec default), then check the resume capability exchanged earlier on the verified channel, then have the receiver report its contiguous confirmed offset. The sender resends from that offset and the receiver truncates any unconfirmed tail.
  - A duplicate chunk with the same index and digest is acknowledged without rewriting. A conflicting digest or offset fails the transfer. Retries are bounded.
- **Alternative held for review:** reuse each side's `RTCCertificate` and pin the previously verified fingerprint pair, which would avoid repeating the SAS. Not adopted without a security review.

## SD-08 — IP address and network metadata

- **Status:** Accepted (planning).
- **Decision:** ICE candidates expose network addresses to the peer and to the signaling path, and the STUN operator sees source IPs. Before connecting, show a disclosure. Never display, log or persist candidate strings, and never geolocate. Zipply is private by minimization, not anonymous. There is no relay-only mode in the MVP.

## SD-09 — XSS, CSP, supply chain and malicious served JavaScript

- **Status:** Accepted (planning). The lint part is implemented in Phase 1, headers in P5-08.
- **Decision:**
  - Untrusted strings are rendered only as React text. ESLint errors on `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML` assignment, `insertAdjacentHTML`, `document.write`, `eval` and `new Function` (Phase 1). Filenames are sanitized for display and download.
  - Planned CSP (via `apps/web/vercel.json`, P5-08): `default-src 'self'; script-src 'self' 'sha256-<theme-script>'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss://<worker-host>; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
  - Planned headers: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, and a restrictive `Permissions-Policy` (camera limited to self from P7).
  - Supply chain: committed lockfile, `npm ci`, few runtime dependencies (react and react-dom; lazily loaded QR libraries in P7 only), `npm audit --audit-level=high` in CI, gitleaks, and CodeQL (P5-10).
- `apps/web/index.html` contains one inline no-flash theme script, so P5-08 must add its `sha256-…` hash to `script-src`. Dev-only demo fixtures (`?demo=`) are compiled out of production builds (verified by grep and a production e2e test).
- **Residual risk (documented, not solved):** CSP does not govern `RTCPeerConnection`, so it cannot stop malicious served JavaScript from sending data out over WebRTC. A compromised origin or build pipeline can bypass every client-side control. Mitigations are published release hashes and a self-hosting guide (P8-06).

## SD-10 — Durable Objects without storage records; liveness and lease sweep

- **Status:** Accepted (owner, 2026-10-17: D2, D12).
- **Context (verified against Cloudflare docs on 2026-10-16):**
  - The Free plan includes 100,000 Durable Object requests/day and 13,000 GB-s/day of duration, billed at 128 MB per object.
  - Incoming WebSocket messages are billed at a 20:1 ratio. Outgoing messages are free, and `setWebSocketAutoResponse` replies incur no duration charge.
  - Free-plan accounts can only create SQLite-backed Durable Object classes.
  - `setTimeout`/`setInterval` prevent hibernation.
  - Each `ctx.storage.setAlarm()` counts as a SQLite row write.
- **Decision:**
  - Declare the room class with `new_sqlite_classes`, but make no SQL or key/value storage calls (enforced by a lint rule in P4-03).
  - Heartbeats use auto-response ping/pong (20 s interval, 60 s TTL).
  - Stale peers are swept by `setAlarm()` used purely as a timer, every 60 s while the room is occupied. It stores no application records. This awaits D2; the alternative is a lazy sweep on wake, with a risk of lingering ghost peers.
  - Per-connection state that must survive hibernation lives in socket attachments (maximum 16,384 bytes each).
- **Evidence (Phase 4, `apps/signaling/test/room.test.ts`, run in workerd):**
  - After a full request/accept exchange, `state.storage.list()` returns 0 entries.
  - The text `ping` is answered `pong` by auto-response.
  - After `evictDurableObject` (simulated hibernation), presence and routing are rebuilt from live sockets: the new peer's snapshot still lists the earlier peer, and a request still reaches it.
  - `runDurableObjectAlarm` closes a socket whose last activity is older than the TTL (code 4000, others told `peer-left`), and keeps a socket that pinged.
  - ESLint bans `storage.get/put/delete/deleteAll/list/sql/kv/transaction/sync` in `apps/signaling/src`; a planted `ctx.storage.put` fails lint while `setAlarm` passes.
  - Not verified without a deploy: real hibernation billing behaviour and quota use on Cloudflare (P4-10).
- **Quota estimate for the Phase 4 design (Free plan: 100,000 Durable Object requests, 100,000 rows written and 13,000 GB-s per day):**
  - **Alarm:** one per occupied room per minute, so a room occupied all day costs about 1,440 requests and 1,440 rows written. That is 1.4 % of each limit.
  - **Joining:** about 1 request for the upgrade, plus 2–3 messages billed at 20:1.
  - **One connection set-up:** request, response, offer, answer and ~20 ICE candidates, about 25 messages or ~1.3 requests.
  - **Heartbeat:** a `ping` every 20 s per open tab, answered by auto-response, which adds no duration. **Unverified:** whether auto-response pings count towards the 20:1 request total. If they do, one tab open all day costs about 216 requests/day, and roughly 460 always-open tabs would use the daily allowance. If quota runs out, the app shows "Discovery temporarily unavailable" (P4-09) and never enables billing.
- **Consequences:** A plain JSON heartbeat every 20 s would keep a room awake nearly all day (about 10,800 GB-s/day for one room). Free quotas are finite and can change, so quota exhaustion is handled as "Discovery temporarily unavailable", never by enabling billing.

## SD-11 — STUN provider

- **Status:** Accepted (owner chose the recommended option D6 on 2026-10-17).
- **Decision:** Use `stun:stun.cloudflare.com:3478`, keeping infrastructure providers to those already in use. Cloudflare's Realtime TURN FAQ states: "Cloudflare's STUN service at `stun.cloudflare.com` is free and unlimited" (developers.cloudflare.com/realtime/turn/faq/, read 2026-10-17). The value comes from the build-time variable `VITE_STUN_URLS` (`stun:`/`stuns:` only, TURN ignored), never hard-coded. If it is unset, no STUN server is used. The privacy disclosure (P5-09) names the STUN operator, which sees the client's IP address.

---

## Change log

| Date       | Change                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | Initial decisions recorded from the approved planning session (Phase 1, P1-02).                                                                          |
| 2026-10-17 | Phase 4: SD-05 and SD-10 accepted (D2, D9, D12; D7 deferred) with signaling evidence.                                                                    |
| 2026-10-17 | Phase 3: SD-02 accepted for Chromium/Firefox with P3-01 evidence (Safari unverified); SD-03 and SD-06 evidence added; SD-06 and SD-11 accepted (D5, D6). |
