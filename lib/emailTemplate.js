/**
 * Branded HTML email toolkit — a single, colourful, professional design system
 * for every message the app sends (alert digest, daily summary, realtime events).
 *
 * Why a shared module: email clients (Gmail, Outlook, Apple Mail) each strip a
 * different slice of modern CSS, so the whole design is built from nested
 * presentation tables + inline styles + bulletproof fallbacks. Keeping it in one
 * place means every email looks identical and on-brand, and the callers in
 * lib/alerts.js stay readable (they just compose components).
 *
 * Public API:
 *   layout({ title, preheader, subtitle, accent, kicker, body, footerNote })
 *   sectionTitle(text, accent)      statGrid(items)        kvTable(rows, accent)
 *   alertList(items)                pillRow(pills)         noticeCard({...})
 *   badge(text, tone)               button(label, url, tone)
 *   TONES  (named brand colours used across the toolkit)
 */
'use strict';

// ---- Brand palette (mirrors public/styles.css so mail matches the app) -------
const TONES = {
  brand: { base: '#2f63c4', dark: '#1d4ea0', soft: '#e8eefb', ink: '#16356e' },
  teal:  { base: '#1aa3c4', dark: '#0f7892', soft: '#e2f5fa', ink: '#0b5366' },
  ok:    { base: '#1f9d55', dark: '#167a41', soft: '#e6f6ec', ink: '#0f5e31' },
  warn:  { base: '#c2790a', dark: '#9a5f07', soft: '#fdf2dd', ink: '#7a4b06' },
  bad:   { base: '#d23f3f', dark: '#a92e2e', soft: '#fbe6e6', ink: '#8a2525' },
  slate: { base: '#64748b', dark: '#475569', soft: '#eef2f7', ink: '#334155' },
};
const tone = (t) => TONES[t] || TONES.brand;

// Map the alert `level` strings used in lib/alerts.js to a colour tone.
const LEVEL_TONE = { critical: 'bad', warn: 'warn', info: 'brand', ok: 'ok' };

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- Brand mark: three colour dots echoing the pinwheel logo + wordmark. Pure
//     HTML so it renders even where SVG/data-URIs are blocked (Gmail/Outlook).
function brandMark() {
  const dot = (c) => `<td style="padding:0 2px"><div style="width:11px;height:11px;border-radius:50%;background:${c};font-size:0;line-height:0">&nbsp;</div></td>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td style="padding-right:11px;vertical-align:middle">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${dot('#8bc34a')}${dot('#2bb8d8')}${dot('#c0489a')}</tr></table>
    </td>
    <td style="vertical-align:middle">
      <div style="font:700 18px/1.1 ${FONT};color:#ffffff;letter-spacing:.2px">Drona&nbsp;Valuechain</div>
      <div style="font:600 11px/1.4 ${FONT};color:#bcd0f5;letter-spacing:1.4px;text-transform:uppercase">JMC Operations Tracker</div>
    </td></tr></table>`;
}

/**
 * The outer shell every email is poured into.
 *   accent  - tone key driving the header strip + title colour (default 'brand')
 *   kicker  - small upper-case label above the title (e.g. "DAILY SUMMARY")
 *   preheader - hidden inbox-preview text
 */
function layout({ title, preheader = '', subtitle = '', accent = 'brand', kicker = '', body = '', footerNote = '' }) {
  const a = tone(accent);
  const year = new Date().getFullYear();
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "https://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="https://www.w3.org/1999/xhtml"><head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#eef2f8;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef2f8;font-size:1px;line-height:1px">${esc(preheader || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2f8" style="background:#eef2f8">
<tr><td align="center" style="padding:26px 14px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(16,42,90,.12)">

    <!-- Header band -->
    <tr><td bgcolor="${a.dark}" style="background:${a.dark};background:linear-gradient(135deg,#0b2f6b 0%,${a.base} 100%);padding:22px 28px">
      ${brandMark()}
    </td></tr>
    <!-- Accent rule -->
    <tr><td style="height:4px;font-size:0;line-height:0;background:linear-gradient(90deg,#8bc34a,${a.base},#c0489a)">&nbsp;</td></tr>

    <!-- Title block -->
    <tr><td style="padding:26px 28px 4px 28px">
      ${kicker ? `<div style="font:700 11px/1 ${FONT};letter-spacing:1.6px;text-transform:uppercase;color:${a.base};margin-bottom:9px">${esc(kicker)}</div>` : ''}
      <h1 style="margin:0;font:700 22px/1.25 ${FONT};color:#16223c">${esc(title)}</h1>
      ${subtitle ? `<div style="margin-top:6px;font:400 14px/1.5 ${FONT};color:#697587">${subtitle}</div>` : ''}
    </td></tr>

    <!-- Body -->
    <tr><td style="padding:14px 28px 26px 28px;font:400 14px/1.6 ${FONT};color:#2a3346">${body}</td></tr>

    <!-- Footer -->
    <tr><td bgcolor="#f5f7fb" style="background:#f5f7fb;border-top:1px solid #e6ebf3;padding:18px 28px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="font:400 12px/1.55 ${FONT};color:#8a96a8">
          ${footerNote ? esc(footerNote) + '<br/>' : ''}
          Automated message from the <b style="color:#5a6678">JMC Operations Tracker</b>. Please do not reply.
        </td>
        <td align="right" style="font:700 12px/1.4 ${FONT};color:#aeb8c7;white-space:nowrap;vertical-align:bottom">&copy; ${year} Drona&nbsp;Valuechain</td>
      </tr></table>
    </td></tr>

  </table>
  <div style="font:400 11px/1.5 ${FONT};color:#a7b1c0;margin-top:14px">Drona Valuechain &middot; JMC Operations Tracker</div>
</td></tr></table></body></html>`;
}

// A coloured section heading with a short accent underline.
function sectionTitle(text, accent = 'brand') {
  const a = tone(accent);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 12px"><tr><td>
    <div style="font:700 13px/1.2 ${FONT};letter-spacing:.5px;text-transform:uppercase;color:#3a4660">${esc(text)}</div>
    <div style="width:34px;height:3px;border-radius:3px;background:${a.base};margin-top:7px;font-size:0;line-height:0">&nbsp;</div>
  </td></tr></table>`;
}

// Coloured stat cards laid out two-per-row. items: [{ label, value, sub, tone }]
function statGrid(items) {
  const cells = items.map((it) => {
    const a = tone(it.tone || 'brand');
    return `<td width="50%" valign="top" style="padding:6px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${a.soft}" style="background:${a.soft};border-radius:12px;border:1px solid ${a.soft}">
        <tr><td style="padding:14px 16px;border-left:4px solid ${a.base};border-radius:12px">
          <div style="font:600 11px/1.3 ${FONT};letter-spacing:.6px;text-transform:uppercase;color:${a.ink}">${esc(it.label)}</div>
          <div style="font:700 24px/1.2 ${FONT};color:#16223c;margin:5px 0 1px">${it.value}</div>
          ${it.sub ? `<div style="font:400 12px/1.4 ${FONT};color:#7c8698">${it.sub}</div>` : ''}
        </td></tr>
      </table></td>`;
  });
  // Pair the cells into rows of two.
  let rows = '';
  for (let i = 0; i < cells.length; i += 2) {
    const pair = cells[i] + (cells[i + 1] || '<td width="50%" style="padding:6px">&nbsp;</td>');
    rows += `<tr>${pair}</tr>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:2px -6px">${rows}</table>`;
}

// Clean key/value table with a tinted header rule. rows: [[label, value], ...]
function kvTable(rows, accent = 'brand') {
  const a = tone(accent);
  const body = rows.map(([k, v], i) => `<tr bgcolor="${i % 2 ? '#ffffff' : '#fafbfe'}" style="background:${i % 2 ? '#ffffff' : '#fafbfe'}">
    <td style="padding:10px 16px;font:400 13px/1.4 ${FONT};color:#5f6b7e;border-bottom:1px solid #eef1f6">${esc(k)}</td>
    <td align="right" style="padding:10px 16px;font:700 13px/1.4 ${FONT};color:#1c2740;border-bottom:1px solid #eef1f6">${v}</td>
  </tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e7ecf4;border-radius:12px;overflow:hidden">
    <tr><td colspan="2" style="height:3px;font-size:0;line-height:0;background:${a.base}">&nbsp;</td></tr>
    ${body}</table>`;
}

// Vertical list of alert rows, coloured by level. items: [{ title, detail, level }]
function alertList(items) {
  return items.map((it) => {
    const a = tone(LEVEL_TONE[it.level] || 'warn');
    const tag = (it.level || 'warn').toUpperCase();
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px">
      <tr><td bgcolor="${a.soft}" style="background:${a.soft};border:1px solid ${a.soft};border-left:4px solid ${a.base};border-radius:10px;padding:12px 14px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="font:700 14px/1.4 ${FONT};color:${a.ink}">${esc(it.title)}</td>
          <td align="right" valign="top" style="white-space:nowrap;padding-left:10px">
            <span style="display:inline-block;font:700 10px/1 ${FONT};letter-spacing:.6px;color:#ffffff;background:${a.base};border-radius:20px;padding:5px 9px">${esc(tag)}</span>
          </td></tr></table>
        ${it.detail ? `<div style="margin-top:5px;font:400 13px/1.5 ${FONT};color:#5a6678">${esc(it.detail)}</div>` : ''}
      </td></tr></table>`;
  }).join('');
}

// A horizontal run of small status pills. pills: [{ label, value, tone }]
function pillRow(pills) {
  const cells = pills.map((p) => {
    const a = tone(p.tone || 'slate');
    return `<td style="padding:5px 6px 0 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="background:#ffffff;border:1px solid #e7ecf4;border-radius:999px">
        <tr><td style="padding:6px 6px 6px 12px;font:600 12px/1 ${FONT};color:#5f6b7e">${esc(p.label)}</td>
        <td style="padding:6px 12px 6px 4px"><span style="display:inline-block;min-width:18px;text-align:center;font:700 12px/1 ${FONT};color:#ffffff;background:${a.base};border-radius:999px;padding:4px 8px">${esc(p.value)}</span></td></tr>
      </table></td>`;
  }).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:2px 0"><tr>${cells}</tr></table>`;
}

// A callout card for a single highlighted message. { tone, title, html }
function noticeCard({ tone: t = 'brand', title = '', html = '' }) {
  const a = tone(t);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td bgcolor="${a.soft}" style="background:${a.soft};border:1px solid ${a.soft};border-left:4px solid ${a.base};border-radius:12px;padding:16px 18px">
      ${title ? `<div style="font:700 15px/1.35 ${FONT};color:${a.ink};margin-bottom:6px">${esc(title)}</div>` : ''}
      <div style="font:400 14px/1.6 ${FONT};color:#33405a">${html}</div>
    </td></tr></table>`;
}

function badge(text, t = 'brand') {
  const a = tone(t);
  return `<span style="display:inline-block;font:700 11px/1 ${FONT};color:#ffffff;background:${a.base};border-radius:6px;padding:5px 9px">${esc(text)}</span>`;
}

function button(label, url, t = 'brand') {
  const a = tone(t);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0"><tr>
    <td bgcolor="${a.base}" style="background:${a.base};border-radius:10px">
      <a href="${esc(url)}" style="display:inline-block;font:700 14px/1 ${FONT};color:#ffffff;text-decoration:none;padding:13px 22px">${esc(label)}</a>
    </td></tr></table>`;
}

module.exports = { layout, sectionTitle, statGrid, kvTable, alertList, pillRow, noticeCard, badge, button, TONES, LEVEL_TONE, esc };
