# Zipply — Offline mode and local pairing

Status: implemented in Phase 7 (2026-11-15). Automated evidence is in `docs/PHASE_STATUS.md`. Real-device results are recorded in the matrix below; until a row is filled in, that combination is **not verified**.

Offline mode is **best effort**. Zipply does not discover devices without its online service, does not scan the network, and cannot promise that two devices can reach each other.

## What works offline

- **The website itself.** After one successful visit, the browser keeps the app shell (HTML, scripts, styles, fonts, icons, manifest) in a service-worker cache, so Zipply opens again without a connection. The browser may delete this cache when storage is low or the site has not been used for a while. Private windows usually keep nothing.
- **Local pairing.** Two devices can connect by exchanging a code, as text or QR, instead of using the online service. The file transfer, the three-word check and the receiver's Accept files work exactly as online.
- **Not available offline:** the radar and the people list (they need the online service), private rooms, and resuming after a page reload (as online, D22).

## How to pair locally

1. Open Zipply on both devices. Without the online service the page says **Offline — radar unavailable** (or **Discovery temporarily unavailable**); press **Try local pairing**. Local pairing is also available online, from its own card.
2. **Sending device:** choose the files and press **Create pairing code**. Zipply collects this device's network routes (up to 10 seconds) and shows a code and its QR.
3. **Receiving device:** paste the code, or press **Scan QR code** and point the camera at the sender's screen, then press **Create answer**. Scanning only fills the field; nothing happens until you press the button.
4. **Sending device:** paste or scan the receiver's answer code and press **Connect**.
5. Both devices then show three words: read yours aloud and type the ones you hear, as in online mode. The receiver then reviews the files and presses **Accept files**.

The codes must be used within 5 minutes. A code contains the device's local network addresses: share it only with the other device. Some systems keep copied text in a clipboard history; the QR avoids that.

If the connection drops for more than 30 seconds during a transfer, the transfer pauses. The sender presses **Reconnect**, which creates a new code; the receiver uses it, and after a new word check the transfer continues from the last confirmed checkpoint.

## Why it can fail

A direct connection needs a network route between the two browsers. Common reasons it fails:

- **Different networks.** Without internet there is no STUN, so only local (host) addresses are exchanged; the devices must be on the same local network (same Wi-Fi, or one device's hotspot).
- **Client isolation.** Guest, hotel, school and some office Wi-Fi networks keep devices from talking to each other (AP or client isolation).
- **VPN.** A VPN on either device can hide or replace the local addresses; Firefox with a VPN active was seen gathering no candidates at all (R16).
- **Hidden local addresses (mDNS).** Browsers replace local IP addresses with random `.local` names. The other device must resolve that name over multicast DNS on the local network; some networks, operating systems or browsers cannot.
- **Browser support.** QR scanning needs a camera and either the browser's own barcode detector or the bundled decoder; the page also needs a secure context (HTTPS or localhost) for the service worker, the camera and the cryptography Zipply uses.

Zipply never retries invisibly. When an attempt fails, it says so and the user can start again.

## Support matrix

### Automated (Playwright on Windows 11, 2026-11-15)

| Check                                                     | Chromium 156                                                              | Firefox 157                               | WebKit 27.2                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Manifest valid, icons load                                | PASS (Chrome installability check: no errors)                             | PASS                                      | PASS                                                          |
| Offline reload from the cache; cache holds the shell only | PASS                                                                      | PASS                                      | PASS                                                          |
| Two pages pair by code and transfer byte-exact            | PASS (loopback, same machine)                                             | NOT VERIFIED (R20: no ICE gathering here) | NOT VERIFIED (no WebRTC in Playwright WebKit on Windows, R11) |
| QR on screen decodes to the code                          | PASS                                                                      | —                                         | —                                                             |
| Camera scan fills the field (bundled decoder)             | PASS (full Chromium with a fake camera; the headless shell has no camera) | —                                         | —                                                             |

Automated runs use one machine, so they prove the code path, not that two real devices can reach each other.

### Real devices (to be filled in by the owner)

Each row: both devices opened the site online once, then the internet was turned off (Wi-Fi kept on, or a hotspot without mobile data), and a small file was paired and sent.

| Device A (browser, version) | Device B (browser, version) | Network                     | Code by    | Result       | Notes            |
| --------------------------- | --------------------------- | --------------------------- | ---------- | ------------ | ---------------- |
| —                           | —                           | same Wi-Fi, no internet     | QR / paste | NOT VERIFIED |                  |
| —                           | —                           | phone hotspot, no data      | QR / paste | NOT VERIFIED |                  |
| —                           | —                           | guest / isolated Wi-Fi      | —          | NOT VERIFIED | expected to fail |
| —                           | —                           | same Wi-Fi, VPN on one side | —          | NOT VERIFIED |                  |

## Real-device test procedure (owner)

Phones need HTTPS for the service worker, the camera and Web Crypto, so this test needs a deployed build of this phase (a staging redeploy, which needs the owner's approval) or another HTTPS origin the owner controls.

1. On both devices, open the deployed site once while online and wait for it to load fully (this installs the offline shell).
2. Turn the internet off while keeping the local network: disconnect the router's internet, or use one phone's hotspot with mobile data off. Reload Zipply on both devices; it should open and say **Offline — radar unavailable**.
3. Follow "How to pair locally" with a small file, once with the QR (P7-04: scan round-trip on two real devices) and once by pasting.
4. Record each combination in the table above: browsers and versions, devices, the network, QR or paste, the result, and the failure text if it failed.
