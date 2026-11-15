# Zipply — Self-hosting

You can run your own copy of Zipply: a static website and a signaling Worker. Both fit the free plans of Vercel (Hobby) and Cloudflare (Workers Free). Running your own copy is the way to avoid trusting someone else's server with the code that runs in your browser (`docs/PRIVACY.md`, "Who you are trusting").

Free plans have quotas and can change. Do not turn on paid features for Zipply; when a quota runs out, discovery stops until it resets and local pairing keeps working.

## 1. Get and check the source

```sh
git clone <repository URL> zipply && cd zipply
git checkout v<version>          # a release tag (docs/RELEASE.md)
npm ci                            # Node.js 24 LTS (see .nvmrc), npm 11
npm run check                     # lint, typecheck, unit tests, format
```

## 2. Deploy the signaling Worker (Cloudflare)

Run these commands in `apps/signaling`.

1. `npx wrangler login`. The first deploy asks you to choose a `workers.dev` subdomain.
2. Set the allowed site origin. The Worker refuses every WebSocket whose `Origin` is not listed exactly, and refuses all of them when the list is empty. In `apps/signaling/wrangler.jsonc`, add to the top-level settings:

   ```jsonc
   "vars": { "ALLOWED_ORIGINS": "https://your-site.example" },
   ```

   Use the exact origin of your website (scheme and host, no path or trailing slash). Add more origins separated by commas only for sites you control. Do not add preview-deployment origins.

3. `npx wrangler deploy` in `apps/signaling`. Note the URL, for example `https://zipply-signaling.<subdomain>.workers.dev`.
4. Check it: `curl https://zipply-signaling.<subdomain>.workers.dev/healthz` → `{"status":"ok","protocolVersion":1}`.

The Worker stores nothing (no KV, D1, R2 or Durable Object storage), and its config turns off Workers observability and Wrangler metrics. Cloudflare's own platform logging is outside the app's control.

## 3. Deploy the website (Vercel)

The build needs two public settings. They are embedded in the JavaScript, so **never put a secret in a `VITE_*` variable**.

| Variable             | Value                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `VITE_SIGNALING_URL` | `wss://zipply-signaling.<subdomain>.workers.dev/ws` (the build refuses `ws://` except localhost) |
| `VITE_STUN_URLS`     | `stun:stun.cloudflare.com:3478`, another `stun:` URL, or empty for no STUN (same network only)   |

Vercel project settings: Root Directory `apps/web`, framework Vite, build command `npm run build`, output `dist`, and the two variables for Production. Or from the repository root with the Vercel CLI:

```sh
npx vercel link                      # choose Root Directory apps/web
npx vercel deploy --prod -b VITE_SIGNALING_URL=wss://…/ws -b VITE_STUN_URLS=stun:stun.cloudflare.com:3478
```

`apps/web/vercel.json` makes Vercel send the security headers (CSP parts that only a header can carry, HSTS, `nosniff`, `Referrer-Policy: no-referrer`, COOP, `Permissions-Policy`). The rest of the Content Security Policy is a `<meta>` tag the build writes. It holds the hash of the inline theme script and your signaling origin.

**Other static hosts** work if they serve HTTPS and send every header in `apps/web/vercel.json` on every path. Without those headers you lose the clickjacking and HSTS protections. No server-side code or rewrites are needed. Serve `dist/sw.js` from the site root, and do not cache it for long, so updates reach users.

## 4. Verify the deployment

Build locally with the same two variables, then run the deployment check from the repository root:

```sh
VITE_SIGNALING_URL=wss://…/ws VITE_STUN_URLS=stun:stun.cloudflare.com:3478 npm run build -w @zipply/web
node scripts/release/verify-deploy.mjs https://your-site.example wss://…/ws apps/web/dist reports/SHA256SUMS
```

It checks the following and exits non-zero on any failure:

- every deployed file is byte-identical to your local build of the same commit, and it writes their SHA-256 list;
- every security header from `vercel.json` is present with the same value;
- `http://` redirects to `https://`;
- both hosts negotiate TLS 1.3, accept TLS 1.2 (the documented minimum) and give no TLS 1.1 session;
- the Worker answers `/healthz`, upgrades a WebSocket from your site's origin, and refuses another origin, a missing origin and plain `ws://`.

Then open the site in two browsers, connect, check words and send a file.

## 5. Updating

Pull the new tag, run `npm ci` and `npm run check`, deploy the Worker first and then the website, and run the check again. Users get the new website when they press **Reload** on the update notice. The service worker never switches versions by itself, so an old tab keeps the old version until then.

## Checking someone else's deployment

Anyone can check a public Zipply site against a release without deploying anything. Build the release tag with that site's `VITE_SIGNALING_URL` and `VITE_STUN_URLS`, then run `verify-deploy.mjs` against it. You can read both values from the site: the signaling origin is in the `connect-src` of the page's `<meta http-equiv="Content-Security-Policy">`, and both URLs are in its main JavaScript file. Matching files show that the site serves that release unmodified **at the moment you checked**. A server can still serve different files to different people or at other times, which no client-side check can rule out.
