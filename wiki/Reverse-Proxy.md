# Reverse Proxy

Spindle is designed to run behind a reverse proxy such as nginx. `app.set('trust proxy', 1)` is already configured so rate limiting uses real client IPs from `X-Forwarded-For`.

---

## nginx

The proxy must forward the `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto` headers so that Spindle can construct correct OAuth callback URLs and apply rate limits by real IP.

```nginx
server {
    listen 443 ssl;
    server_name mail.yourdomain.com;

    # SSL certificate configuration (e.g. via Certbot)
    ssl_certificate     /etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mail.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name mail.yourdomain.com;
    return 301 https://$host$request_uri;
}
```

---

## APP_URL

Make sure `APP_URL` in your `.env` matches the public URL exactly, including the scheme:

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
