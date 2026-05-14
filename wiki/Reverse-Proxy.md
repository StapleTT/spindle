# Reverse Proxy

Spindle is designed to run behind a reverse proxy such as nginx. The `TRUST_PROXY` environment variable controls which upstream machine Spindle trusts for `X-Forwarded-For` and `X-Forwarded-Proto` headers. Trusting only the known proxy IP prevents clients from spoofing their source address to bypass rate limits.

There are two common setups depending on whether nginx runs on the **same machine** or a **separate machine** from Node.js.

---

## Scenario A — nginx on the same machine

Leave `TRUST_PROXY` unset. Spindle defaults to trusting only loopback (`127.0.0.1` / `::1`).

**nginx config:**

```nginx
server {
    listen 443 ssl;
    server_name mail.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name mail.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

**Firewall** — block external access to port 3000 so clients cannot reach Express directly:

```bash
# ufw
ufw deny 3000

# iptables
iptables -A INPUT -p tcp --dport 3000 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

---

## Scenario B — nginx on a separate machine

Set `TRUST_PROXY` in `.env` to the **private IP of the nginx server**. Spindle will trust `X-Forwarded-*` headers only from that address.

```env
TRUST_PROXY=192.168.1.10
```

Replace `192.168.1.10` with the actual private IP of your nginx machine.

**nginx config** (on the nginx machine, proxying to the Node.js machine):

```nginx
server {
    listen 443 ssl;
    server_name mail.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://192.168.1.20:3000;   # private IP of the Node.js machine
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 80;
    server_name mail.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

**Firewall** (on the Node.js machine) — allow port 3000 only from the nginx machine's IP:

```bash
# ufw
ufw allow from 192.168.1.10 to any port 3000
ufw deny 3000

# iptables
iptables -A INPUT -p tcp --dport 3000 -s 192.168.1.10 -j ACCEPT
iptables -A INPUT -p tcp --dport 3000 -j DROP
```

> **Why TRUST_PROXY matters:** express-session only sets the `Secure` cookie attribute when `req.secure` is true. With HTTPS terminated at nginx, Express receives a plain HTTP connection — it only learns the original scheme via `X-Forwarded-Proto: https`. If the proxy's IP is not trusted, that header is ignored, `req.secure` stays false, and the browser never receives the session cookie. Login appears to succeed (HTTP 200) but every subsequent request returns 401 because no cookie was stored.

---

## APP_URL

Make sure `APP_URL` in `.env` matches the public URL exactly, including the scheme:

```
APP_URL=https://mail.yourdomain.com
```

This value is used to build OAuth callback URLs and password recovery links. If it does not match your actual domain, OAuth flows and recovery emails will point to the wrong address.

---

## SSL certificates

[Certbot](https://certbot.eff.org/) with the nginx plugin is the simplest way to obtain and auto-renew a free Let's Encrypt certificate:

```bash
# Debian / Ubuntu
apt install certbot python3-certbot-nginx -y
certbot --nginx -d mail.yourdomain.com

# Alpine Linux
apk add certbot certbot-nginx
certbot --nginx -d mail.yourdomain.com
```
