import nodemailer, { type Transporter } from 'nodemailer';
import { escapeHtml } from '../mail/reply.js';
import type { AuthConfig } from './config.js';

export function createMailer(config: AuthConfig) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: config.smtpRequireTLS,
    ...(config.smtpUser
      ? { auth: { user: config.smtpUser, pass: config.smtpPassword } }
      : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
  });
}

export type AuthEmail = { subject: string; text: string; html: string };

export async function sendAuthEmail(
  mailer: Transporter,
  config: AuthConfig,
  email: string,
  message: AuthEmail,
) {
  await mailer.sendMail({ from: config.mailFrom, to: email, ...message });
}

// Templates follow the Claude Design export (emails/*.html); see docs/design.md.
// Table layout, inline styles and fixed hex colours are deliberate: mail
// clients ignore custom properties, oklch() and most <style> rules.
const font = 'font-family:Helvetica, Arial, sans-serif;';
const lines = 'mso-line-height-rule:exactly;';
const ink = '#1c1f2b';
const muted = '#565b6e';
const primary = '#3e56c2';

const paragraph = (html: string, size = 16, bottom = 20) =>
  `<tr><td class="e-tv" style="padding:0 0 ${bottom}px;${font}font-size:${size}px;line-height:${size + 10}px;${lines}color:${muted};">${html}</td></tr>`;
const strong = (text: string) =>
  `<strong class="e-tx" style="color:${ink};">${escapeHtml(text)}</strong>`;
const divider = `<tr><td style="padding:4px 0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-line" style="border-top:1px solid #dcdfe9;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table></td></tr>`;
const button = (url: string, label: string) =>
  `<tr><td style="padding:4px 0 28px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-btn" bgcolor="${primary}" style="border-radius:24px;background:${primary};"><a class="e-btnt" href="${escapeHtml(url)}" style="display:block;padding:14px 28px;${font}font-size:16px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:24px;">${label}</a></td></tr></table></td></tr>`;
const fallbackLink = (url: string) =>
  paragraph(
    `If the button doesn’t work, paste this link into your browser:<br><a class="e-link" href="${escapeHtml(url)}" style="color:${primary};word-break:break-all;">${escapeHtml(url)}</a>`,
    14,
  );
const feature = (dot: string, title: string, body: string) =>
  `<tr><td style="padding:0 0 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="26" style="width:26px;vertical-align:top;padding-top:6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="12" height="12" bgcolor="${dot}" style="width:12px;height:12px;background:${dot};border-radius:6px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td><td style="${font}font-size:15px;line-height:23px;${lines}"><strong class="e-tx" style="color:${ink};">${title}</strong><br><span class="e-tv" style="color:${muted};">${body}</span></td></tr></table></td></tr>`;

function layout(
  config: AuthConfig,
  {
    title,
    preheader,
    body,
    footer,
  }: { title: string; preheader: string; body: string; footer: string },
) {
  const asset = (name: string) => escapeHtml(new URL(name, config.appUrl).href);
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${title}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
body{margin:0;padding:0;width:100%!important;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
table,td{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt}
img{border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
@media screen and (max-width:620px){.e-wrap{width:100%!important}.e-pad{padding:28px 22px!important}.e-h1{font-size:26px!important;line-height:32px!important}}
@media (prefers-color-scheme:dark){.e-logo-l{display:none!important}.e-logo-d{display:block!important;width:30px!important;height:30px!important;max-height:30px!important}
.e-bg{background:#161616!important}.e-card{background:#222222!important;border-color:#2e2e2e!important}
.e-tx{color:#ececec!important}.e-tv{color:#b3b3b3!important}.e-line{border-color:#333333!important}
.e-soft{background:#2c2c2c!important}.e-btn{background:#a9b5f5!important}.e-btnt{color:#1f2a6b!important}
.e-link{color:#a9b5f5!important}.e-chip{background:#2f3a78!important;color:#dfe3ff!important}}
[data-ogsc] .e-tx{color:#ececec!important}[data-ogsc] .e-tv{color:#b3b3b3!important}[data-ogsc] .e-link{color:#a9b5f5!important}
[data-ogsb] .e-bg{background:#161616!important}[data-ogsb] .e-card{background:#222222!important}[data-ogsb] .e-soft{background:#2c2c2c!important}[data-ogsb] .e-btn{background:#a9b5f5!important}
</style>
</head>
<body class="e-bg" style="margin:0;padding:0;background:#f1f2f7;">
<span style="display:none!important;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;color:#f1f2f7;">${preheader}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</span>
<table role="presentation" class="e-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f2f7" style="background:#f1f2f7;">
<tr><td align="center" style="padding:32px 16px 40px;">
<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" class="e-wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:separate;">
<tr><td style="padding:0 8px 20px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="30" style="width:30px;padding-right:8px;vertical-align:middle;"><img class="e-logo-l" src="${asset('/spindle-mark.png')}" width="30" height="30" alt="" style="display:block;width:30px;height:30px;"><!--[if !mso]><!--><img class="e-logo-d" src="${asset('/spindle-mark-dark.png')}" width="30" height="30" alt="" style="display:none;width:0;height:0;max-height:0;overflow:hidden;mso-hide:all;"><!--<![endif]--></td>
    <td class="e-tx" style="vertical-align:middle;${font}font-size:21px;line-height:24px;${lines}font-weight:bold;color:${ink};letter-spacing:-0.3px;">Spindle</td>
  </tr></table>
</td></tr>
<tr><td class="e-card" bgcolor="#fcfcfe" style="background:#fcfcfe;border:1px solid #dcdfe9;border-radius:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="e-pad" style="padding:44px 44px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${body}
    </table>
  </td></tr>
  </table>
</td></tr>
<tr><td style="padding:24px 8px 0;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td class="e-tv" style="${font}font-size:13px;line-height:20px;${lines}color:${muted};">${footer}</td></tr>
  </table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`;
}
const heading = (text: string) =>
  `<tr><td class="e-tx e-h1" style="padding:0 0 16px;${font}font-size:30px;line-height:36px;${lines}font-weight:bold;color:${ink};">${text}</td></tr>`;

export function verificationEmail(
  config: AuthConfig,
  email: string,
  url: string,
): AuthEmail {
  return {
    subject: 'Verify your Spindle email',
    text: `Verify your email within one hour:\n\n${url}\n\nOnly continue if you created this Spindle account. If you did not, ignore this email.`,
    html: layout(config, {
      title: 'Verify your Spindle email',
      preheader: 'Confirm your email to finish creating your Spindle account.',
      body: [
        heading('Confirm your email'),
        paragraph(
          `Confirm this address to finish creating your Spindle account for ${strong(email)}.`,
        ),
        button(url, 'Verify email address'),
        divider,
        paragraph(
          'The link expires in one hour. Only continue if you created this Spindle account. If you didn’t, ignore this email.',
          14,
        ),
        fallbackLink(url),
      ].join('\n'),
      footer:
        'You’re getting this because someone created a Spindle account with this address.',
    }),
  };
}

export function passwordResetEmail(
  config: AuthConfig,
  email: string,
  url: string,
): AuthEmail {
  return {
    subject: 'Reset your Spindle password',
    text: `Reset your password within one hour:\n\n${url}\n\nIf you did not request this, ignore this email.`,
    html: layout(config, {
      title: 'Reset your Spindle password',
      preheader:
        'Someone asked to reset your Spindle password. The link expires in one hour.',
      body: [
        heading('Reset your password'),
        paragraph(
          `Someone asked to reset the password for ${strong(email)}. If that was you, choose a new one below.`,
        ),
        button(url, 'Choose a new password'),
        paragraph(
          'Resetting your password signs you out on every device. Your connected mailboxes and settings stay the same.',
          15,
        ),
        divider,
        `<tr><td style="padding:0 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="4" class="e-btn" bgcolor="${primary}" style="width:4px;background:${primary};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td><td class="e-tv" style="padding:2px 0 2px 16px;${font}font-size:15px;line-height:24px;${lines}color:${muted};"><strong class="e-tx" style="color:${ink};">Didn’t ask for this?</strong> Your password hasn’t changed. You can ignore this email.</td></tr></table></td></tr>`,
        paragraph(
          'The link works once and expires in one hour. Spindle will never ask for your password by email.',
          14,
        ),
        fallbackLink(url),
      ].join('\n'),
      footer:
        'This is a security email about your Spindle account, so it was sent even if you don’t receive other email from Spindle.',
    }),
  };
}

export function invitationEmail(
  config: AuthConfig,
  email: string,
  url: string,
  expiresAt: Date,
): AuthEmail {
  const expires = expiresAt.toLocaleDateString('en-US', {
    dateStyle: 'long',
    timeZone: 'UTC',
  });
  return {
    subject: 'You are invited to Spindle',
    text: `You are invited to Spindle. Create your account within seven days using this email address:\n\n${url}\n\nYou will need to verify your email before signing in.`,
    html: layout(config, {
      title: 'You’re invited to Spindle',
      preheader: `Create your Spindle account before ${expires}.`,
      body: [
        `<tr><td style="padding:0 0 18px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-chip" bgcolor="#dfe3ff" style="background:#dfe3ff;border-radius:8px;padding:6px 12px;${font}font-size:12px;line-height:16px;font-weight:bold;letter-spacing:1px;color:#1f2a6b;">INVITATION</td></tr></table></td></tr>`,
        heading('You’re invited to Spindle'),
        paragraph(
          'You can create a Spindle account before it opens to everyone. Spindle puts every inbox you own into one fast stream that you can run from the keyboard.',
        ),
        button(url, 'Create your account'),
        divider,
        feature(
          '#c85a3c',
          'All your mail in one inbox',
          'Connect your IMAP accounts and read them together in one stream.',
        ),
        feature(
          '#3a74c4',
          'Triage with single keys',
          'Archive, trash, reply and search without the mouse. Mail actions can be undone.',
        ),
        feature(
          '#2f9563',
          'Private by design',
          'Every mailbox you connect belongs only to you.',
        ),
        divider,
        paragraph(
          `The invitation is for ${strong(email)} and expires on ${expires} (UTC). Create your account with this address, then verify it before signing in.`,
          14,
        ),
        fallbackLink(url),
      ].join('\n'),
      footer:
        'You’re getting this because a Spindle operator invited this address.',
    }),
  };
}
