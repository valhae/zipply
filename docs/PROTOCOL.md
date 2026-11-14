# Zipply — Protocol

This document specifies the messages Zipply exchanges: with the signaling service over a WebSocket (section 1), and directly between peers over the WebRTC DataChannel (sections 2–4). The security rationale is in `docs/SECURITY_DECISIONS.md` (SD-02, SD-03, SD-05, SD-06, SD-10). The validators live in `packages/protocol` (signaling) and `apps/web/src/features/transfer/frames.ts` (DataChannel).

## 1. Signaling (WebSocket)

### 1.1 Endpoints and admission

- `GET /ws` opens the **public lobby**. `GET /ws/<route>` opens a **private room**, where `<route>` is `base64url(SHA-256(capability))` (43 characters, canonical).
- The Worker requires a WebSocket upgrade (otherwise `426`) and an `Origin` that exactly matches one entry of `ALLOWED_ORIGINS` (otherwise `403 Forbidden`). If `ALLOWED_ORIGINS` is unset, every origin is refused. Any other path returns `404`. `GET /healthz` returns the protocol version.
- Production must use `wss://`. A web build fails if `VITE_SIGNALING_URL` is `ws://` to anything other than `localhost`, `127.0.0.1` or `[::1]`.
- Each scope is one Durable Object (`Room`). It holds at most 100 sockets; the next one receives `SERVER_BUSY` and is closed with code `1013`.

### 1.2 Messages

Every frame is a JSON envelope `{ "version": 1, "type": "…", "payload": { … } }` of at most 64 KiB (`MESSAGE_TOO_LARGE`). Unknown types, unknown or missing payload keys, wrong value types and an envelope-level `requestId` are rejected (`INVALID_MESSAGE`); another version is `UNSUPPORTED_VERSION`. Identifiers (`peerId`, `requestId`, `connId`) are 16 random bytes in canonical unpadded base64url. **No message has a field for file names, sizes, types, counts or hashes**: file metadata cannot travel through signaling (SD-03).

Client → server:

| Type                  | Payload                                                                                      | Notes                                                               |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `hello`               | `displayName`, `discoverable`, `room?` (20-byte capability)                                  | Must be the first message, exactly once; `room` only on a room path |
| `visibility`          | `discoverable`                                                                               | Announces `peer-joined` / `peer-left` to the scope                  |
| `connection-request`  | `requestId`, `targetPeerId`                                                                  | Target must be discoverable; at most 10 pending per socket          |
| `connection-response` | `requestId`, `accept`                                                                        | Only the target, once                                               |
| `offer`               | `requestId`, `connId`, `sdp` (≤ 16 KiB), `cO` (32 bytes)                                     | Only the requester, after acceptance                                |
| `answer`              | `requestId`, `connId`, `sdp` (≤ 16 KiB), `nA` (16 bytes)                                     | Only the target, after acceptance                                   |
| `ice-candidate`       | `requestId`, `connId`, `candidate` (≤ 1 KiB; `sdpMid`, `sdpMLineIndex`, `usernameFragment?`) | Either party, after acceptance                                      |
| `cancel`              | `requestId`                                                                                  | Either party, any time; removes the request                         |

Server → client: `hello-accepted` (`peerId`, `heartbeatSeconds` 20, `presenceTtlSeconds` 60), `peer-snapshot` (`peers`: `peerId` and `displayName` of discoverable peers only), `peer-joined`, `peer-left`, `connection-request` (`requestId`, `fromPeerId`, `displayName`, `expiresAt`), the routed `connection-response` / `offer` / `answer` / `ice-candidate` / `cancel`, and `error` (`code` only: `INVALID_MESSAGE`, `UNSUPPORTED_VERSION`, `MESSAGE_TOO_LARGE`, `PEER_NOT_FOUND`, `REQUEST_EXPIRED`, `RATE_LIMITED`, `SERVER_BUSY`, `ROOM_INVALID`, `NAME_TAKEN`). Clients validate server messages just as strictly, so a server cannot add trust flags such as `verified`.

Display names: **one word** of 1–32 code points, NFC, with no whitespace or separator characters and no control, bidi-control or unpaired-surrogate characters. Names are **unique among visible peers in a scope**, compared after NFKC and lower-casing. A `hello` with `discoverable: true`, or a `visibility` change to visible, that would duplicate a visible name is answered `NAME_TAKEN`: the peer stays connected but hidden. Hidden peers never count, so `NAME_TAKEN` cannot reveal them. A name is a label only; the server assigns the `peerId` and routes by it. Clients pick a fresh one-word auto name each visit, two pixel words with no digits (e.g. `VoxlByte`); a name the user types is kept on that device only.

### 1.3 Routing and lifetime

- The server assigns a random `peerId` per socket. A connection request is forwarded only to a discoverable peer in the same scope; unknown, hidden and own ids all answer `PEER_NOT_FOUND`, so hidden peers cannot be probed.
- A request stays pending for 60 seconds. `offer` / `answer` / `ice-candidate` are routed only between the two parties of an **accepted** request, in the right direction. An accepted pair stays routable until either party sends `cancel` or disconnects, so a later offer (an ICE restart, section 1.5) can still be relayed (D20, Phase 6). Anything else answers `REQUEST_EXPIRED` and is not delivered. A rejected, canceled or expired request id cannot be revived. Clients send `cancel` for an accepted pair when the user closes the finished transfer; accepted pairs count towards the 10-pending limit.
- When a socket closes, it leaves the scope (`peer-left`) and its pending requests are canceled for the other party.
- Per-socket token bucket: bursts of 40 messages, 5 per second sustained. Over the limit the server answers `RATE_LIMITED` once and drops messages; after 50 more it closes the socket (`1008`). Invalid messages, binary frames, a second `hello` and anything before `hello` close the socket with `1008`.
- Heartbeat: the client sends the text `ping` every 20 s, and the Durable Object answers `pong` by auto-response without waking. An alarm every 60 s while the room is occupied closes sockets that have been silent for more than 60 s (code `4000`) and drops expired requests. All per-socket state lives in WebSocket attachments; nothing is written to storage (SD-10).

### 1.4 Private rooms

The capability is 20 bytes: 16 random bytes followed by an expiry in epoch minutes (u32, big-endian), 30 minutes by default. It travels only in the page URL fragment (`#room=<capability>`), which browsers never send to servers, and in `hello`. The room verifies that `SHA-256(capability)` equals the route and that the expiry is in the future; otherwise it answers `ROOM_INVALID` and closes (`1008`). A capability sent to the public lobby is also `ROOM_INVALID`. Expiry is checked on joining, and the room remembers it: the sweep (every 60 s) sends `ROOM_INVALID` and closes (`1008`) every socket of a room whose link has expired, so peers leave within a minute of expiry (R18, owner decision 2026-11-14). Everyone in a room holds the same link and leaves in the same sweep, so no signaling `cancel` is sent; a direct connection the peers already opened is not ended by the server.

### 1.5 WebRTC setup over signaling

The `offer`, `answer` and `ice-candidate` messages carry everything needed to open one `RTCPeerConnection`. SDP and ICE candidates are sensitive network metadata: they are never logged, displayed or persisted.

- The offerer is the requester and the sender of files. One connection carries at most one transfer; a paused transfer may continue on a later connection (section 2.3). Only a local user action (Request, Accept, Reconnect) can start a connection. A signaling `cancel` can only stop a connection whose DataChannel has not opened yet; once it is open, or while a transfer is paused, the client ignores it, because the DataChannel's own `cancel` is the authenticated one (D20, SD-04). The server also sends `cancel` when the other party's socket closes, which must not end a healthy transfer.
- The DataChannel is negotiated out of band (`negotiated: true, id: 0`), ordered and reliable, with `binaryType = 'arraybuffer'`.
- One offer/answer exchange sets the connection up. A later description is accepted only as an **ICE restart of the same connection** (P6-04): an `offer` with the same `connId` and `cO`, answered with the same `nA`, whose SDP carries exactly the same DTLS fingerprints as the current remote description; the offerer accepts only the answer to its own restart, with the same `nA` and fingerprints. Anything else (renegotiation) closes the connection, because it could change the keys the SAS covers. `restartIce()` keeps the DTLS association and its fingerprints (P3-01 (d)), so no new word check is needed.
- Only the offerer restarts ICE: when `connectionState` becomes `failed`, or stays `disconnected` for 5 seconds, at most twice. If the connection is not `connected` again within 30 seconds of the first problem, it is closed, and a transfer in progress pauses (section 2.3). Before the DataChannel has opened, a failure simply closes the connection.
- ICE candidates are applied only after the description they belong to; messages are processed one at a time in arrival order.
- A connection that has not opened its DataChannel within 30 seconds is closed.
- STUN servers come from the build-time variable `VITE_STUN_URLS` (`stun:`/`stuns:` URLs only); there is no TURN relay.

## 2. DataChannel messages

Every DataChannel message is either a **control message** (a JSON text frame) or a **chunk frame** (a binary frame). Both are validated at the boundary; anything malformed, unknown or out of state fails the connection closed.

### 2.1 Control messages (text)

Each control message is a JSON object with exactly the listed keys, `v: 1` and a type `t`. Text frames longer than 65,536 UTF-16 code units are rejected.

| `t`            | Other fields                                          | Direction          | Allowed when                                                                 |
| -------------- | ----------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `sas-reveal`   | `nO` (16 bytes)                                       | offerer → answerer | channel open, before any confirmation                                        |
| `sas-confirm`  | `d` (32 bytes, the SAS digest D)                      | both               | after the sender's own typed-word check passed                               |
| `manifest`     | `transferId` (16 bytes), `chunkSize`, `files[]`       | offerer → answerer | both confirmations present (state `verified`)                                |
| `files-accept` | `transferId`, `manifestDigest` (32 bytes)             | answerer → offerer | state `offered`, after the user's Accept                                     |
| `files-reject` | `transferId`                                          | answerer → offerer | state `offered`                                                              |
| `ack`          | `transferId`, `bytes` (cumulative verified bytes)     | answerer → offerer | state `transferring`                                                         |
| `file-end`     | `transferId`, `fileIdx`, `root` (32 bytes)            | offerer → answerer | state `transferring`, after a file's last chunk                              |
| `complete`     | `transferId`                                          | answerer → offerer | every file verified                                                          |
| `cancel`       | —                                                     | both               | any non-terminal state                                                       |
| `resume`       | `transferId`, `proof` (32 bytes)                      | offerer → answerer | a new connection for a paused transfer, after both word checks (section 2.3) |
| `resume-from`  | `transferId`, `fileIdx`, `offset`, `proof` (32 bytes) | answerer → offerer | after a valid `resume`                                                       |

Manifest limits: 1–1,000 files; each file has exactly `name` (1–1,024 characters), `size` (a safe non-negative integer) and `type` (0–255 characters, a hint only); the total size must be a safe integer; `chunkSize` is between 1,024 and 262,144 bytes. `manifestDigest` is SHA-256 of the exact UTF-8 manifest text that was sent, so acceptance is bound to that manifest.

### 2.2 Chunk frames (binary)

Header layout, big-endian, 70 bytes, followed by the payload:

| Offset | Size | Field                                                       |
| ------ | ---- | ----------------------------------------------------------- |
| 0      | 1    | version (`1`)                                               |
| 1      | 1    | flags: bit 0 = last chunk of the file; other bits must be 0 |
| 2      | 16   | transferId                                                  |
| 18     | 4    | fileIdx                                                     |
| 22     | 4    | chunkIdx                                                    |
| 26     | 8    | byte offset (must be ≤ 2^53 − 1)                            |
| 34     | 4    | payload length (must equal the actual payload length)       |
| 38     | 32   | SHA-256 of the payload                                      |

Payload size = `min(configured chunk size, maxMessageSize − 70)`; the configured size is 64 KiB (kept after the P6-07 benchmark, `docs/benchmarks/`). When `maxMessageSize` is unknown, 16,384 is assumed. P3-01 measured `maxMessageSize` = 262,144 (Chromium 156) and 1,073,741,823 (Firefox 157), so both use 65,536-byte payloads.

The receiver accepts a chunk only if it is the next expected one: same `transferId`, current `fileIdx`, `chunkIdx` equal to the number of chunks received for this file, `offset` equal to the bytes received, payload length equal to `min(chunkSize, size − offset)` and non-zero, the final flag set exactly on the last chunk, and a matching SHA-256. A zero-byte file has no chunks. A repeat of an already verified chunk of the current file (same index, offset, length and digest) is acknowledged without being written again; a repeat with another digest fails the transfer (`integrity`), and any other out-of-order chunk fails it (`protocol`).

### 2.3 Pause and resume (P6-03, P6-05)

- **Separate counters.** The sender keeps the bytes it handed to the channel (_queued_; _sent_ = queued − `bufferedAmount`) apart from the bytes the receiver confirmed with `ack` (_confirmed_). An `ack` above the queued bytes or the total fails the transfer. Only the receiver's own position is used to resume.
- **Pause.** If the DataChannel closes, or the connection fails as above, while the state is `transferring`, both sides **pause** instead of failing. They keep the manifest, the accepted manifest digest, the chunk digests, the partial data in the sink and the resume key, and close the old connection. Before files were accepted, a lost connection still fails.
- **Resume key.** When the files are accepted, both sides derive `K = SHA-256("zipply/resume-key/v1" ‖ D ‖ transferId)` from the SAS digest D of that connection. D and `transferId` are only ever sent over the DataChannel, so K is never sent anywhere.
- **New connection.** The sender's user presses Reconnect, which sends a new `connection-request` to the receiver (found by its id, or by its name if its id changed; a name is only a locator). The paused receiver's user sees the request and must accept it. The new connection runs the full SAS and word check again (D4). Only then does the offerer send `resume{transferId, proofO}` with `proofO = SHA-256("zipply/resume/v1" ‖ K ‖ D' ‖ "O")`, where D' is the new connection's digest. The answerer checks the transfer id and the proof, truncates any unconfirmed tail of the current file, and answers `resume-from{transferId, fileIdx, offset, proofA}` (role `"A"`), where `offset` is its verified, written byte count for that file. The offerer checks the proof and that the position is a chunk boundary (or the file's end) that it has actually sent, then continues from there. The consent given for the original manifest carries over; no new manifest is sent.
- **Failures on the new connection.** Before the transfer resumed, any failure on the new connection (a word mismatch, a wrong proof, an unexpected message, a manifest instead of `resume`) closes that connection and leaves the transfer **paused**, so no bytes flow and the user may try again. After three such attempts in a row, or ten minutes after the pause, the transfer fails (`expired`) and partial data is deleted.
- **Cancel** in any state, including paused, is final and deletes partial data. A paused side cannot tell the other one (there is no channel), so the other side stays paused until its own timeout or until a reconnect is declined.
- **Not supported:** resuming after a page reload or a closed tab (D22). Nothing about files is persisted. Staged OPFS data that a tab leaves behind is deleted at the next start (section 2.4).

### 2.4 Receive sinks (P6-01, D21)

- Up to 256 MiB in total: memory, then an automatic download (as before).
- Larger, on browsers with `showDirectoryPicker` (Chromium desktop): after Accept files the user picks a folder; files are written there under sanitized names, and `name (1).ext` is used instead of overwriting an existing file.
- Larger, elsewhere: OPFS staging in `zipply-<transferId>/<index>` (no file names on disk), then an automatic download. `navigator.storage.estimate()` is checked before Accept; it is advisory, and a failed write stops the transfer (`storage`). A Web Lock is held on the folder while the page uses it, a `done` marker is written after the last file, and the next start deletes finished or empty folders silently and offers to delete partial data.
- With no suitable sink, or too little reported space, the manifest is rejected automatically before any payload.
- **Read-back (SD-06, P6-02):** after a file is committed, the receiver re-reads the stored copy in 4 MiB slices and checks its size and every chunk's SHA-256 against the verified digests. A mismatch fails the transfer (`integrity`); the file is never offered as completed.

## 3. Sequence

1. The DataChannel opens. The offerer sends `sas-reveal`. The answerer checks `SHA-256("zipply/sas-commit/v1" ‖ connId ‖ nO) = cO`, then both compute D and its six-word phrase (SD-02).
2. Spoken-and-typed check (D19, SD-02): the offerer's screen shows words 1–3 and the answerer's shows words 4–6. Each user reads their three words aloud and types the three they hear. Each device checks only what its own user typed, against the half it does not show; the typed words are never sent. A correct entry sends `sas-confirm{d}`. The third wrong entry, or "Mismatch — cancel", closes the connection. A received `sas-confirm` never sets the local confirmation. A different `d` is a mismatch.
3. With both confirmations, the offerer sends `manifest`. The receiver shows names (sanitized), sizes and total. It also shows where the files would go (section 2.4); if no sink fits, it sends `files-reject` automatically.
4. Accept sends `files-accept`; Reject sends `files-reject` and ends the connection.
5. The sender streams each file's chunks with backpressure (high watermark 1 MiB, low 256 KiB, kept after the P6-07 benchmark), then sends `file-end{root}`, where root = SHA-256 of the concatenated chunk digests. Files are sent one after another without waiting for a per-file reply; the receiver verifies each root, and the stored copy after commit, and fails the transfer on any mismatch.
6. The receiver sends `ack` every 1 MiB of verified, written bytes (the checkpoint interval, configurable) and after each verified file, and `complete` after the last one. Files become inert `application/octet-stream` downloads with sanitized names, or stay in the folder the user picked.
7. Any terminal state (completed, rejected, canceled, failed) closes the DataChannel after queued messages are delivered, then the peer connection. Late messages are ignored.

## 4. Failure handling

- Any message that fails validation, arrives in the wrong state or comes from the wrong role fails the connection (`protocol`).
- A payload frame outside `transferring` is a violation and closes the connection immediately.
- A chunk digest or file root mismatch fails the transfer (`integrity`); nothing is offered for download.
- A closed channel or failed ICE connection before Accept files fails the transfer (`closed`); during the transfer it pauses (section 2.3).
- A failed write to the sink fails the transfer (`storage`); a paused transfer that times out or uses up its attempts fails (`expired`). Both delete partial data.
- On any terminal state the nonces, commitment, digest and phrase are purged.
