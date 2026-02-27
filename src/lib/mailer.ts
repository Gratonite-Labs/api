import nodemailer from 'nodemailer';
import type { Env } from '../env.js';
import { logger } from './logger.js';

type MailSendResult =
  | { sent: true; messageId: string }
  | { sent: false; reason: 'SMTP_NOT_CONFIGURED' | 'SMTP_SEND_FAILED' };

let transporterCache: nodemailer.Transporter | null = null;
let transporterCacheKey = '';

export function isEmailDeliveryConfigured(env: Env): boolean {
  return Boolean(env.SMTP_HOST);
}

function getTransporter(env: Env): nodemailer.Transporter | null {
  if (!env.SMTP_HOST) return null;

  const cacheKey = [
    env.SMTP_HOST,
    env.SMTP_PORT,
    env.SMTP_SECURE,
    env.SMTP_USER ?? '',
    env.SMTP_PASS ? '***' : '',
    env.SMTP_REQUIRE_TLS,
    env.SMTP_IGNORE_TLS,
  ].join('|');

  if (transporterCache && transporterCacheKey === cacheKey) {
    return transporterCache;
  }

  transporterCache = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: env.SMTP_REQUIRE_TLS,
    ignoreTLS: env.SMTP_IGNORE_TLS,
    auth: env.SMTP_USER && env.SMTP_PASS
      ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
      : undefined,
  });
  transporterCacheKey = cacheKey;
  return transporterCache;
}

function buildVerifyEmailLink(env: Env, token: string, email: string): string {
  const base = env.APP_ORIGIN.replace(/\/$/, '');
  const u = new URL(`${base}/verify-email`);
  u.searchParams.set('token', token);
  u.searchParams.set('email', email);
  return u.toString();
}

export async function sendVerificationEmail(params: {
  env: Env;
  toEmail: string;
  displayName?: string | null;
  token: string;
}): Promise<MailSendResult> {
  const transporter = getTransporter(params.env);
  if (!transporter) {
    return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };
  }

  const verifyLink = buildVerifyEmailLink(params.env, params.token, params.toEmail);
  const recipientName = params.displayName?.trim() || 'there';
  const from = `"${params.env.SMTP_FROM_NAME.replace(/"/g, '')}" <${params.env.SMTP_FROM_ADDRESS}>`;

  const subject = 'Verify your Gratonite email';
  const text = [
    `Hi ${recipientName},`,
    '',
    'Please verify your email to finish setting up your Gratonite account.',
    verifyLink,
    '',
    'If the button does not work, copy and paste the link into your browser.',
    '',
    'If you did not create this account, you can ignore this email.',
    '',
    'This link expires in 30 minutes.',
  ].join('\n');

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; background: #f5f7fb; padding: 24px;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
        Verify your email to finish setting up your Gratonite account.
      </div>
      <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px;">
        <p style="margin: 0 0 8px; font-size: 12px; color: #6b7280; letter-spacing: 0.04em; text-transform: uppercase;">Gratonite</p>
        <h1 style="margin: 0 0 12px; font-size: 20px; line-height: 1.25; color: #111827;">Verify your email</h1>
        <p style="margin: 0 0 12px; line-height: 1.5;">Hi ${escapeHtml(recipientName)},</p>
        <p style="margin: 0 0 16px; line-height: 1.5;">
          Please verify your email to finish setting up your Gratonite account.
        </p>
        <p style="margin: 0 0 16px;">
          <a href="${verifyLink}" style="display: inline-block; padding: 10px 14px; border-radius: 8px; background: #0f172a; color: #ffffff; text-decoration: none; font-weight: 600;">
            Verify Email
          </a>
        </p>
        <p style="margin: 0 0 8px; color: #6b7280; font-size: 13px;">
          This link expires in 30 minutes. If you did not create this account, you can ignore this email.
        </p>
        <p style="margin: 0 0 6px; color: #6b7280; font-size: 12px;">Manual link:</p>
        <p style="margin: 0; color: #374151; font-size: 12px; word-break: break-all;">${verifyLink}</p>
      </div>
    </div>
  `.trim();

  try {
    const info = await transporter.sendMail({
      from,
      replyTo: params.env.SMTP_FROM_ADDRESS,
      to: params.toEmail,
      subject,
      text,
      html,
    });
    logger.info({ messageId: info.messageId, toEmail: params.toEmail }, 'Verification email sent');
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    logger.error({ err, toEmail: params.toEmail }, 'SMTP send failed for verification email');
    return { sent: false, reason: 'SMTP_SEND_FAILED' };
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
