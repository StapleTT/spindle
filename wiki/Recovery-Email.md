# Recovery Email

Spindle can send password reset links to users who registered with a recovery email address. This requires an outbound mail server. The recommended approach is a local Postfix instance on the same machine, which requires no external accounts or services.

---

## Install packages

### Debian / Ubuntu

```bash
apt install postfix opendkim opendkim-tools -y
# When prompted, choose "Internet Site" and set the hostname to your domain
```

### Alpine Linux

```bash
apk add postfix opendkim opendkim-utils
rc-update add postfix default
rc-update add opendkim default
```

---

## Generate a DKIM signing key

```bash
mkdir -p /etc/opendkim/keys/yourdomain.com
opendkim-genkey -D /etc/opendkim/keys/yourdomain.com/ -s mail -d yourdomain.com
chmod 600 /etc/opendkim/keys/yourdomain.com/mail.private
```

---

## Configure OpenDKIM

```bash
cat > /etc/opendkim/opendkim.conf << 'EOF'
Domain                  yourdomain.com
KeyFile                 /etc/opendkim/keys/yourdomain.com/mail.private
Selector                mail
Socket                  inet:8891@127.0.0.1
Canonicalization        relaxed/simple
Mode                    sv
OversignHeaders         From
EOF
```

---

## Configure Postfix

```bash
postconf -e "myhostname = yourdomain.com"
postconf -e "myorigin = yourdomain.com"
postconf -e "inet_interfaces = loopback-only"
postconf -e "inet_protocols = ipv4"
postconf -e "milter_protocol = 6"
postconf -e "milter_default_action = accept"
postconf -e "smtpd_milters = inet:127.0.0.1:8891"
postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"
```

---

## Start the services

### Debian / Ubuntu

```bash
systemctl restart postfix opendkim
```

### Alpine Linux

```bash
rc-service opendkim restart
rc-service postfix restart
```

---

## Add DNS records

These records tell receiving mail servers that your instance is authorized to send email.

| Type | Name | Value |
|---|---|---|
| PTR | your server IP | `yourdomain.com` -- set this in your VPS control panel |
| TXT | `yourdomain.com` | `v=spf1 ip4:YOUR_SERVER_IP -all` |
| TXT | `mail._domainkey.yourdomain.com` | contents of `mail.txt` (see below) |
| TXT | `_dmarc.yourdomain.com` | `v=DMARC1; p=none;` |

View your generated DKIM public key:

```bash
cat /etc/opendkim/keys/yourdomain.com/mail.txt
```

Copy the `p=...` value and paste it as a single unbroken string (no quotes, no parentheses) into your DNS panel under `mail._domainkey.yourdomain.com`.

---

## Configure Spindle

Add the following to your `.env`:

```
SYSTEM_SMTP_HOST=127.0.0.1
SYSTEM_SMTP_PORT=25
SYSTEM_SMTP_USER=
SYSTEM_SMTP_PASS=
SYSTEM_FROM_EMAIL=Spindle <noreply@yourdomain.com>
```

Leave `SYSTEM_SMTP_USER` and `SYSTEM_SMTP_PASS` blank. When both are empty, Spindle skips SMTP authentication, which is the correct behavior for a local Postfix relay.

---

## Using an external relay instead

If you prefer an external service such as Resend, SendGrid, or Postmark, use their SMTP credentials instead:

```
SYSTEM_SMTP_HOST=smtp.resend.com
SYSTEM_SMTP_PORT=587
SYSTEM_SMTP_USER=resend
SYSTEM_SMTP_PASS=re_xxxxxxxxxxxxxxxxxxxx
SYSTEM_FROM_EMAIL=Spindle <noreply@yourdomain.com>
```

Port `587` uses STARTTLS. Port `465` uses implicit TLS.
