# LAN and reverse-proxy access

The default development setup listens only on this computer. Three listeners have separate purposes:

| Listener     | Bind setting                   | Default          | Purpose                                                |
| ------------ | ------------------------------ | ---------------- | ------------------------------------------------------ |
| Web          | `WEB_HOST`                     | `127.0.0.1:5173` | Browser UI, assets, landing page and `/api` forwarding |
| API          | `HOST`, `PORT`                 | `127.0.0.1:3000` | Authentication and local mail APIs                     |
| Mail content | `CONTENT_HOST`, `CONTENT_PORT` | `127.0.0.1:3001` | Isolated HTML, images and attachments                  |

Changing `HOST` alone does not expose the web UI. The API does not serve the frontend. Vite forwards `/api` internally, so the API can remain on loopback even when a remote proxy reaches the web listener.

`APP_URL` is the **exact HTTPS origin users open in their browsers**, including any nonstandard port. It controls authentication links, cookies and write-origin checks; its hostname is also explicitly allowed by Vite. Using `http://192.168.x.x:5173` can test web connectivity, but does not establish a working sign-in origin. Plain HTTP authentication is limited to explicit loopback development. Keep HTTPS for access from other devices.

## Choose the proxy location

For a reverse proxy running directly on the same computer, keep all listeners on `127.0.0.1`. Point the app proxy to `http://127.0.0.1:5173` and the content proxy to `http://127.0.0.1:3001`.

For a proxy on another machine or in its own Docker network, its `127.0.0.1` refers to the proxy itself. Point it to this computer's reachable LAN address instead. Set `WEB_HOST` and `CONTENT_HOST` to that LAN address, or `0.0.0.0` if binding all IPv4 interfaces is needed. Keep `HOST=127.0.0.1`: Vite and the API run on the same computer in the current development setup.

Example `.env` changes for a remote proxy (replace names with your actual DNS names):

```dotenv
HOST=127.0.0.1
PORT=3000
WEB_HOST=0.0.0.0
APP_URL=https://spindle.example.com
ALLOW_INSECURE_LOCALHOST=false
CONTENT_HOST=0.0.0.0
CONTENT_PORT=3001
CONTENT_URL=https://mail-content.example.com
```

Preserve existing secrets, database settings, mailbox encryption keys and SMTP credentials. Restart `npm run dev` after changing `.env`; Node's running API/worker processes do not reload these values automatically. Continue opening Spindle through the configured HTTPS hostname, including on this computer. Existing loopback login cookies will not carry across; sign in again at the new origin.

Switching to an HTTPS app origin also requires TLS for system SMTP. The plaintext Mailpit exception only applies to loopback development; use the existing [Resend configuration](resend.md) for external delivery.

The content hostname must differ from the app hostname. Otherwise formatted email is unsafe and configuration is rejected. Leaving `CONTENT_URL` unset for a hosted app disables formatted content rather than falling back to app-origin HTML. Each accessing device must resolve both names to the proxy and trust its HTTPS certificates.

Allow only the proxy to reach exposed development ports through your firewall. Keep Postgres, Mailpit and ClamAV private. Do not disable Vite host checks with `allowedHosts: true`. Add `TRUST_PROXY` only for the actual API ingress peers after preventing untrusted clients from bypassing the proxy; do not trust arbitrary forwarded-IP headers.

## Proxy routing

The app hostname routes all paths, including `/api`, `/landing/`, assets and Vite's development WebSocket, to port 5173. Mail HTML uses its separate hostname on port 3001, exposing only `/body`, `/image` and `/attachment`. Preserve the app's original `Host`/`Origin`, cookies and security headers. Do not rewrite browser `Origin` to a loopback address or enable wildcard CORS.

Example Caddy routes for a proxy running directly on the same computer:

```caddyfile
spindle.example.com {
    reverse_proxy 127.0.0.1:5173 {
        flush_interval -1
    }
}

mail-content.example.com {
    @mail path /body /image /attachment
    handle @mail {
        reverse_proxy 127.0.0.1:3001
    }
    handle {
        respond 404
    }
}
```

For a remote/container proxy replace each upstream `127.0.0.1` with the app computer's reachable address. Configure valid TLS for your real hostnames. With other proxies, enable WebSocket forwarding, disable response buffering/caching/compression buffering for `/api/mail/events`, and allow streaming read timeouts longer than the five-minute SSE connection lifetime. Keep the content host free of app cookies, injected login gateways and shared authenticated caching. See [SSE deployment](events.md) and [content isolation](reader.md).

## Diagnose by layer

1. Check listeners with `ss -lnt`: a loopback-only listener cannot accept a remote machine's connection.
2. From the proxy machine/container, fetch `http://APP_LAN_IP:5173/` and `http://APP_LAN_IP:5173/api/health`. Connection refusal/timeout points to the bind address, routing or firewall. A blocked-host response points to a hostname mismatch with `APP_URL`.
3. Open the canonical HTTPS app URL. Sign-in/write origin errors mean `APP_URL` differs from the browser origin or a proxy rewrote `Origin`; a bind change alone cannot fix this.
4. A working UI with broken formatted email points to the separate content URL, certificate, hostname, routing or listener. Do not merge it into the app origin.
5. If lists work but live updates repeatedly reconnect, check WebSocket forwarding for Vite and unbuffered SSE for mail updates separately.

This fixes development access; production static web hosting, deployment packaging and the remaining operational/security gates remain their own tasks.

## Local verification — 2026-10-30

The web bind is now independently configurable and Vite allows the configured `APP_URL` hostname. A synthetic HTTP test verified the wildcard listener, approved-host access, rejection of an unrelated hostname and forwarding to a loopback API. Existing auth tests still enforce HTTPS outside explicit loopback development. `npm run check` passed lint, both typechecks, 45 tests and both builds.

On the development machine, setting only `WEB_HOST=0.0.0.0` and reloading Vite made the actual UI and proxied `/api/health` return 200 through the LAN interface while the API/content listeners stayed on loopback. Existing secrets and other environment values were preserved. Browser sign-in and formatted mail through the intended reverse proxy remain unverified until its location and canonical HTTPS app/content hostnames are supplied.
