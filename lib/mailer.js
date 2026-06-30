/**
 * SMTP mail transport (nodemailer). Configured entirely via env vars so no
 * credentials live in the repo — see .env.example:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, ALERT_FROM
 *
 * If SMTP is not configured the module degrades gracefully: isConfigured()
 * returns false and sendMail() logs + resolves without throwing, so the rest of
 * the app (and the nightly scheduler) keep working in dev with no mailserver.
 */
'use strict';
require('dotenv').config();
const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || PORT === 465;
const FROM = process.env.ALERT_FROM || (USER ? `Drona ValueChain <${USER}>` : 'Drona ValueChain <no-reply@localhost>');

let transport = null;
function getTransport() {
  if (!HOST) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: HOST, port: PORT, secure: SECURE,
      auth: USER ? { user: USER, pass: PASS } : undefined,
    });
  }
  return transport;
}

function isConfigured() { return !!HOST; }

// recipients: array of email strings OR a comma-separated string.
async function sendMail({ to, subject, html, text }) {
  const list = (Array.isArray(to) ? to : String(to || '').split(','))
    .map(s => s.trim()).filter(Boolean);
  if (!list.length) return { skipped: 'no-recipients' };
  const t = getTransport();
  if (!t) { console.warn(`[mailer] SMTP not configured — skipped "${subject}" to ${list.join(', ')}`); return { skipped: 'not-configured' }; }
  const info = await t.sendMail({ from: FROM, to: list.join(', '), subject, html, text: text || undefined });
  return { messageId: info.messageId, accepted: info.accepted };
}

module.exports = { sendMail, isConfigured, FROM };
