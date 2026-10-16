# Zipply — Protocol

This document specifies the messages Zipply peers exchange. The signaling-service protocol (WebSocket, Phase 4) will be added here in P4-01. The security rationale is in `docs/SECURITY_DECISIONS.md` (SD-02, SD-03, SD-06).

## 1. Connection setup (signaling payloads)

These three payloads carry everything needed to open one `RTCPeerConnection`. In Phase 3 they travel over a **development-only** same-browser `BroadcastChannel` harness (`?harness`, compiled out of production builds). From Phase 4 they travel over the signaling service. SDP and ICE candidates are sensitive network metadata: they are never logged, displayed or persisted.

| Kind     | Fields                                                                                     | Sent by  |
| -------- | ------------------------------------------------------------------------------------------ | -------- |
| `offer`  | `connId` (16 bytes), `sdp` (≤ 16 KiB), `cO` (32 bytes, the SAS commitment)                 | offerer  |
| `answer` | `connId`, `sdp` (≤ 16 KiB), `nA` (16 bytes, the answerer nonce)                            | answerer |
| `ice`    | `connId`, `candidate` (`candidate` ≤ 1 KiB, `sdpMid`, `sdpMLineIndex`, `usernameFragment`) | both     |

Binary values are base64url without padding and must decode canonically. `parseSignal()` (`apps/web/src/features/connection/peer.ts`) rejects unknown kinds, unknown or missing fields, and oversized values.

Rules:

- The offerer is the requester and the sender of files. One connection carries one transfer.
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
