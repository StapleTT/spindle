import nodemailer, { type Transporter } from 'nodemailer';
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

export async function sendAuthEmail(
  mailer: Transporter,
  config: AuthConfig,
  email: string,
  subject: string,
  text: string,
) {
  await mailer.sendMail({ from: config.mailFrom, to: email, subject, text });
}
