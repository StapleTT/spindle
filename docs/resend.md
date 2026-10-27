# Resend email delivery

Spindle sends authentication email directly through Resend using the existing Nodemailer SMTP transport. No SDK or Mailpit relay is needed. The example configuration still uses Mailpit; active Resend settings deliver to real recipients instead.

## Verified and pending

On 2026-10-27 the user selected Resend. The existing ignored `.env` already contained its settings and a sending key. SMTP authentication over TLS on port 465 passed, with From address `noreply@spindle.staplett.xyz`. No credentials were printed or changed.

Public DNS contains DKIM at `resend._domainkey.spindle.staplett.xyz` and SPF/MX records at `send.spindle.staplett.xyz`. The user confirmed that Resend shows the sender domain as verified. The sending-only key cannot read domain-management status; its restricted scope was preserved. No DMARC record was found at `_dmarc.spindle.staplett.xyz` during the DNS check; that policy remains unconfirmed.

External delivery is confirmed: with the user's explicit recipient authorization, exactly one message with subject **Spindle email delivery test** was sent from the configured sender. Resend accepted it with SMTP status 250, and the user confirmed receipt in Proton Mail. This proves delivery for that test, not universal inbox placement. No additional messages were sent after confirmation.

Public HTTPS deployment and real-user verification/reset-link acceptance remain separate work; the current development app origin still points to this computer.

## Setup

1. In [Resend Domains](https://resend.com/domains), add `spindle.staplett.xyz` if absent. Verify this exact sending subdomain.
2. Publish the exact DNS names/types/values Resend supplies at the authoritative DNS provider. Preserve existing root-domain forwarding/MX records; sending setup does not require switching incoming mail to Resend.
3. Confirm that Resend shows the domain verified with sending enabled. Do not guess DKIM values, regional records or IPs.
4. Create an application-specific API key with **Sending access**, restricted to this domain where supported. Store it locally as `SMTP_PASSWORD`, never in chat, issues or tracked files. A full-access key is unnecessary for sending.
5. Keep open/click tracking disabled for authentication email. DMARC remains a separate DNS policy task; confirm legitimate sender alignment before enforcing a policy.

References: [domain verification](https://resend.com/docs/dashboard/domains/introduction), [API keys](https://resend.com/docs/dashboard/api-keys/introduction).

Replace the active SMTP block in the ignored `.env` with:

```dotenv
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASSWORD=<your Resend sending key>
MAIL_FROM=noreply@spindle.staplett.xyz
```

These match [Resend's SMTP settings](https://resend.com/docs/send-with-smtp). Port 465 uses implicit TLS with certificate validation. Preserve the database URL, auth secret and registration mode. Avoid duplicate active SMTP entries.

Restart the API after changing `.env`: its transport is created at startup. With `npm run dev`, stop it with Ctrl-C and start it again. Editing the file alone does not reload a running process's SMTP configuration.

Keep `APP_URL` matching the actual browser origin. The current `http://127.0.0.1:5173` works for development on this computer. Before inviting other people, deploy at a public HTTPS origin and set `APP_URL` accordingly; otherwise emailed links point to the recipient's own computer. Changing the sender address does not require changing the app origin.

## Receipt check and rollback

After domain verification, designate one recipient for a single test. Confirm From address and inbox receipt, and inspect the matching event in Resend. Do not automatically release old captured messages or resend existing invitations during setup.

For a new invited user, `npm run auth:invite -- recipient@example.com` creates and sends an invitation through the active relay. Existing unverified users use **Resend verification email** in Spindle; existing verified users need no new invitation. These actions send real email when Resend is active.

If delivery fails, inspect Resend's delivery/bounce result and the recipient's spam folder before retrying. Preserve sender authentication and TLS while diagnosing.

To return to capture, restore the Mailpit settings from `.env.example`, remove active `SMTP_USER`/`SMTP_PASSWORD` entries, and restart the API. Keep the Resend key in the agreed secret store. Switching changes new mail only; it does not resend or delete earlier messages.
