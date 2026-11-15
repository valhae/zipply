# Zipply — Privacy

Zipply sends files directly from one browser to another. This page explains what Zipply itself keeps, what the services it runs on can see, and what the other person can see. It describes the code in this repository; a copy of Zipply hosted by someone else can differ (see "Who you are trusting" below).

**In short:** Zipply has no accounts, no database, no analytics, no advertising, no trackers and no file storage on any server. Your files travel directly between the two browsers, encrypted by WebRTC. The hosting providers and the STUN service still see connection metadata such as your IP address, as any website or internet service does. Zipply is private by keeping as little as possible; it does not make you anonymous.

## What Zipply never does

- It never uploads your files to a server. There is no upload endpoint, and the signaling service rejects every message that is not one of the documented signaling messages (`docs/PROTOCOL.md`).
- It never sends file names, sizes, types or contents through the signaling service. The file list is sent only over the direct, encrypted connection, and only after both people have checked the three words.
- It never compresses, converts or resizes files. The receiver gets the same bytes the sender chose.
- It never writes logs of file names, connection details (SDP, ICE candidates), verification words or room links, in the browser or on the server.
- It never loads third-party scripts, fonts, analytics or advertising. Fonts are served from Zipply's own site.

## What the signaling service sees

To show who is online and to set up a direct connection, the browser keeps a WebSocket open to Zipply's signaling service (a Cloudflare Worker with a Durable Object per room). While you are connected, the service holds in memory:

- a random peer id it assigns to your tab, your display name, whether you are discoverable, and whether you are in the public lobby or a private room;
- for a connection you request or accept: a random request id, and the connection set-up messages it passes between the two browsers (the WebRTC offer and answer, which contain network addresses and encryption fingerprints, and the network candidates).

It does not keep any of this. It writes nothing to storage; when your tab closes or goes silent for 60 seconds, your entry is gone, and a restart of the service forgets everyone. A private room's link keeps its secret in the part of the URL after `#`, which browsers do not send to web servers or in referrers. Your browser does send that secret to the signaling service in its first message so the service can check it; the service then keeps only the room's hash and expiry time, and only while you are connected.

## What the infrastructure providers see

Zipply runs on free plans of two providers, and it uses one STUN server:

- **Vercel** serves the website files. Like any web host, it receives your IP address, the time, the requested file and your browser's user agent, and it may log them under its own policy.
- **Cloudflare** runs the signaling service and the STUN server (`stun.cloudflare.com`). It receives your IP address and connection metadata. The STUN server tells your browser its public address so a direct connection can be made across networks; it sees your IP address but no file data.

Zipply has turned off the logging and metrics features it controls (Workers observability and Wrangler metrics are disabled in `apps/signaling/wrangler.jsonc`), but it cannot control what the providers record at their own level. Their privacy policies apply: [Vercel](https://vercel.com/legal/privacy-policy), [Cloudflare](https://www.cloudflare.com/privacypolicy/).

## What the other person sees

A direct connection needs each browser to know a network route to the other, so **the other person's browser learns your IP addresses** (local and public). Zipply never shows them on screen, but someone with technical skill can read them. Zipply warns about this before you connect. There is no relay mode that would hide your address.

The other person also sees your display name. A display name proves nothing about who someone is; only the three-word check does.

Local pairing codes (offline mode) contain your device's local network addresses. Share a code only with the device you are pairing with. Some systems keep copied text in a clipboard history.

## What stays on your device

- **Settings:** your theme choice (`zipply-theme`) and a display name you typed yourself (`zipply-name`) are kept in the browser's local storage on this device only. Random names are not stored.
- **The offline copy of the website:** after one visit, a service worker keeps Zipply's own files (HTML, scripts, styles, fonts, icons) so the site opens without internet. It stores nothing else: no files, no file lists, no connection details, no room links.
- **Received files:** files you accept are saved as ordinary downloads. Files larger than 256 MiB are written either to a folder you choose (Chrome and Edge on desktop) or first to the browser's private site storage and then downloaded. Partial data is deleted when a transfer is canceled or fails, and any leftover is deleted the next time Zipply starts.
- **Nothing else:** no transfer history, no list of people you connected to, nothing that would let a transfer resume after the page is reloaded.

## Who you are trusting

The files are encrypted between the two browsers (WebRTC DTLS). The three-word check makes sure the encrypted connection really ends at the other person's browser and not at someone in between, **provided both of you read and type the words over a channel you trust**, such as speaking in person or on a call you recognise.

No website can protect you from the website itself. If the site serving Zipply were compromised, or a malicious browser extension or a compromised device were involved, the code running in your browser could be changed to send your files elsewhere. If that matters to you, run your own copy and check it against a published release (`docs/SELF-HOSTING.md`, `docs/RELEASE.md`).

## Questions and reports

Security problems: see [`SECURITY.md`](../SECURITY.md). The security design is in [`docs/SECURITY_DECISIONS.md`](SECURITY_DECISIONS.md).
