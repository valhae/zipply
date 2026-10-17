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

Server → client: `hello-accepted` (`peerId`, `heartbeatSeconds` 20, `presenceTtlSeconds` 60), `peer-snapshot` (`peers`: `peerId` and `displayName` of discoverable peers only), `peer-joined`, `peer-left`, `connection-request` (`requestId`, `fromPeerId`, `displayName`, `expiresAt`), the routed `connection-response` / `offer` / `answer` / `ice-candidate` / `cancel`, and `error` (`code` only: `INVALID_MESSAGE`, `UNSUPPORTED_VERSION`, `MESSAGE_TOO_LARGE`, `PEER_NOT_FOUND`, `REQUEST_EXPIRED`, `RATE_LIMITED`, `SERVER_BUSY`, `ROOM_INVALID`). Clients validate server messages just as strictly, so a server cannot add trust flags such as `verified`.

Display names: 1–32 code points, NFC, no leading or trailing whitespace, no control, bidi-control or unpaired-surrogate characters. A name is a label only; the server assigns the `peerId` and routes by it.

### 1.3 Routing and lifetime

- The server assigns a random `peerId` per socket. A connection request is forwarded only to a discoverable peer in the same scope; unknown, hidden and own ids all answer `PEER_NOT_FOUND`, so hidden peers cannot be probed.
- A request stays pending for 60 seconds. `offer` / `answer` / `ice-candidate` are routed only between the two parties of an **accepted** request, in the right direction, for 60 seconds after acceptance. Anything else answers `REQUEST_EXPIRED` and is not delivered. A rejected, canceled or expired request id cannot be revived.
- When a socket closes, it leaves the scope (`peer-left`) and its pending requests are canceled for the other party.
- Per-socket token bucket: bursts of 40 messages, 5 per second sustained. Over the limit the server answers `RATE_LIMITED` once and drops messages; after 50 more it closes the socket (`1008`). Invalid messages, binary frames, a second `hello` and anything before `hello` close the socket with `1008`.
- Heartbeat: the client sends the text `ping` every 20 s, and the Durable Object answers `pong` by auto-response without waking. An alarm every 60 s while the room is occupied closes sockets that have been silent for more than 60 s (code `4000`) and drops expired requests. All per-socket state lives in WebSocket attachments; nothing is written to storage (SD-10).

### 1.4 Private rooms

The capability is 20 bytes: 16 random bytes followed by an expiry in epoch minutes (u32, big-endian), 30 minutes by default. It travels only in the page URL fragment (`#room=<capability>`), which browsers never send to servers, and in `hello`. The room verifies that `SHA-256(capability)` equals the route and that the expiry is in the future; otherwise it answers `ROOM_INVALID` and closes (`1008`). A capability sent to the public lobby is also `ROOM_INVALID`. Expiry is checked on joining; peers already in a room are not removed when the link expires.

### 1.5 WebRTC setup over signaling

The `offer`, `answer` and `ice-candidate` messages carry everything needed to open one `RTCPeerConnection`. SDP and ICE candidates are sensitive network metadata: they are never logged, displayed or persisted.

- The offerer is the requester and the sender of files. One connection carries one transfer. Only a local user action (Request, Accept) can start a connection; a signaling `cancel` can only stop one (SD-04).
- The DataChannel is negotiated out of band (`negotiated: true, id: 0`), ordered and reliable, with `binaryType = 'arraybuffer'`.
- Exactly one offer/answer exchange is applied. Any further description (renegotiation) closes the connection, because it could change the DTLS fingerprints the SAS was computed from. ICE restart (`restartIce()`, which keeps the fingerprints, see P3-01 (d)) is scheduled for P6-04.
- ICE candidates are applied only after the description they belong to; messages are processed one at a time in arrival order.
- A connection that has not opened its DataChannel within 30 seconds is closed.
- STUN servers come from the build-time variable `VITE_STUN_URLS` (`stun:`/`stuns:` URLs only); there is no TURN relay.

## 2. DataChannel messages

Every DataChannel message is either a **control message** (a JSON text frame) or a **chunk frame** (a binary frame). Both are validated at the boundary; anything malformed, unknown or out of state fails the connection closed.

### 2.1 Control messages (text)

Each control message is a JSON object with exactly the listed keys, `v: 1` and a type `t`. Text frames longer than 65,536 UTF-16 code units are rejected.

| `t`            | Other fields                                      | Direction          | Allowed when                                    |
| -------------- | ------------------------------------------------- | ------------------ | ----------------------------------------------- |
| `sas-reveal`   | `nO` (16 bytes)                                   | offerer → answerer | channel open, before any confirmation           |
| `sas-confirm`  | `d` (32 bytes, the SAS digest D)                  | both               | after the sender's local "The words match"      |
| `manifest`     | `transferId` (16 bytes), `chunkSize`, `files[]`   | offerer → answerer | both confirmations present (state `verified`)   |
| `files-accept` | `transferId`, `manifestDigest` (32 bytes)         | answerer → offerer | state `offered`, after the user's Accept        |
| `files-reject` | `transferId`                                      | answerer → offerer | state `offered`                                 |
| `ack`          | `transferId`, `bytes` (cumulative verified bytes) | answerer → offerer | state `transferring`                            |
| `file-end`     | `transferId`, `fileIdx`, `root` (32 bytes)        | offerer → answerer | state `transferring`, after a file's last chunk |
| `complete`     | `transferId`                                      | answerer → offerer | every file verified                             |
| `cancel`       | —                                                 | both               | any non-terminal state                          |

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

Payload size = `min(64 KiB, maxMessageSize − 70)`. When `maxMessageSize` is unknown, 16,384 is assumed. P3-01 measured `maxMessageSize` = 262,144 (Chromium 156) and 1,073,741,823 (Firefox 157), so both use 65,536-byte payloads. The P6 benchmark will revisit the size.

The receiver accepts a chunk only if it is the next expected one: same `transferId`, current `fileIdx`, `chunkIdx` equal to the number of chunks received for this file, `offset` equal to the bytes received, payload length equal to `min(chunkSize, size − offset)` and non-zero, the final flag set exactly on the last chunk, and a matching SHA-256. A zero-byte file has no chunks.

## 3. Sequence

1. The DataChannel opens. The offerer sends `sas-reveal`. The answerer checks `SHA-256("zipply/sas-commit/v1" ‖ connId ‖ nO) = cO`, then both compute D and show the six-word phrase (SD-02).
2. Each user compares the words. "The words match" sends `sas-confirm{d}`; "Mismatch — cancel" closes the connection. A received `sas-confirm` never sets the local confirmation. A different `d` is a mismatch.
3. With both confirmations, the offerer sends `manifest`. The receiver shows names (sanitized), sizes and total. If the total exceeds the receive limit (256 MiB, memory sink), it sends `files-reject` automatically.
4. Accept sends `files-accept`; Reject sends `files-reject` and ends the connection.
5. The sender streams each file's chunks with backpressure (high watermark 1 MiB, low 256 KiB), then sends `file-end{root}`, where root = SHA-256 of the concatenated chunk digests. Files are sent one after another without waiting for a per-file reply; the receiver verifies each root and fails the transfer on any mismatch.
6. The receiver sends `ack` every 1 MiB of verified bytes and after each verified file, and `complete` after the last one. Files become inert `application/octet-stream` downloads with sanitized names.
7. Any terminal state (completed, rejected, canceled, failed) closes the DataChannel after queued messages are delivered, then the peer connection. Late messages are ignored.

## 4. Failure handling

- Any message that fails validation, arrives in the wrong state or comes from the wrong role fails the connection (`protocol`).
- A payload frame outside `transferring` is a violation and closes the connection immediately.
- A chunk digest or file root mismatch fails the transfer (`integrity`); nothing is offered for download.
- A closed channel or failed ICE connection before completion fails the transfer (`closed`). Resume is Phase 6.
- On any terminal state the nonces, commitment, digest and phrase are purged.
