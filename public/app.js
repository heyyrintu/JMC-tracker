/* Drona ValueChain — JMC Ops Tracker (frontend SPA) */
'use strict';

const State = { user: null, cfg: null, route: 'dashboard' };

// ---- tiny helpers ---------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const todayStr = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
const monthStr = (d = new Date()) => d.toISOString().slice(0, 7);
const fmt = (n) => (n == null ? '0' : Number(n).toLocaleString('en-IN'));

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || ('Error ' + res.status));
  return data;
}
function toast(msg, kind = '') {
  const t = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

const ROLE_NAV = {
  OPERATOR:     ['dashboard','entry','workers','onboarding','attendance','leave','compliance','discrepancies','capa','requests','reports','mis'],
  JMC_APPROVER: ['dashboard','approvals','discrepancies','capa','reports','mis'],
  HQ:           ['dashboard','workers','onboarding','attendance','leave','compliance','discrepancies','capa','requests','reports','mis','billing'],
  ADMIN:        ['dashboard','entry','workers','onboarding','attendance','leave','compliance','approvals','discrepancies','capa','requests','reports','mis','billing','settings','users','audit'],
};
const NAV_META = {
  dashboard:{ic:'▤',label:'Dashboard'}, entry:{ic:'✎',label:'Daily Entry'},
  workers:{ic:'⚇',label:'Blue Collars'}, onboarding:{ic:'🪪',label:'Onboarding'}, attendance:{ic:'🗓',label:'Attendance'},
  leave:{ic:'🏖',label:'Leave'}, compliance:{ic:'⚖',label:'Compliance'},
  approvals:{ic:'✔',label:'EOD Approvals'}, discrepancies:{ic:'⚠',label:'Discrepancies'},
  capa:{ic:'🛠',label:'CAPA / 8D'},
  requests:{ic:'＋',label:'Manpower Requests'},
  reports:{ic:'▦',label:'Reports'}, mis:{ic:'▣',label:'MIS Dashboard'}, billing:{ic:'₹',label:'Billing'},
  settings:{ic:'⚙',label:'Settings'}, users:{ic:'◐',label:'Users'},
  audit:{ic:'🗒',label:'Audit Log'},
};
const DEPARTMENTS = () => (State.cfg.approvedManpower||[]).map(c=>c.category).concat('OTHER');
const inr = (n) => '₹' + fmt(Math.round(+n || 0));
const DISC_TYPES = {
  DISPATCH_VS_BILL:'Dispatched vs Billed', WRONG_PART:'Wrong Part Supplied',
  QR_ISSUE:'QR Code Issue', TPH_HYZINE:'TPH + Hyzine', OTHER:'Other',
};

// ---- boot -----------------------------------------------------------------
(async function boot() {
  try {
    const me = await api('/me');
    State.cfg = me.config;
    if (me.user) { State.user = me.user; renderApp(); }
    else renderLogin();
  } catch (err) {
    $('#root').innerHTML = '';
    const box = h(`<div style="max-width:420px;margin:18vh auto;text-align:center">
      <h2>Can't reach the server</h2><p class="muted">${esc(err.message)}</p>
      <button class="btn primary" id="bootRetry">Retry</button></div>`);
    $('#root').appendChild(box);
    box.querySelector('#bootRetry').addEventListener('click', () => location.reload());
  }
})();

// ---- login ----------------------------------------------------------------
// Forgot-password (emailed OTP) — two-step modal opened from the login screen.
function forgotPasswordModal() {
  const ov = h(`<div class="modal-backdrop"><div class="modal" style="max-width:420px">
    <h3>Reset password</h3>
    <div id="fpStep1">
      <p class="muted small">Enter your username or email. If a matching account with an email exists, we'll send a 6-digit code.</p>
      <div class="field"><label>Username or email</label><input id="fpIdent" autocomplete="username"></div>
      <div class="btn-row" style="justify-content:flex-end"><button class="btn ghost" id="fpCancel">Cancel</button>
        <button class="btn primary" id="fpSend">Send code</button></div>
    </div>
    <div id="fpStep2" style="display:none">
      <p class="muted small">Enter the 6-digit code from your email and choose a new password.</p>
      <div class="field"><label>Reset code</label><input id="fpOtp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
      <div class="field"><label>New password <span class="muted small">(min 5 chars)</span></label><input id="fpPw" type="password" autocomplete="new-password"></div>
      <div class="btn-row" style="justify-content:flex-end"><button class="btn ghost" id="fpBack">Back</button>
        <button class="btn primary" id="fpReset">Reset password</button></div>
    </div>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  const ident = () => $('#fpIdent').value.trim();
  ov.querySelector('#fpCancel').addEventListener('click', close);
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  $('#fpIdent').focus();
  $('#fpSend').addEventListener('click', async () => {
    if (!ident()) { toast('Enter your username or email', 'bad'); return; }
    try {
      const r = await api('/forgot-password', { method: 'POST', body: { ident: ident() } });
      toast(r.message || 'If the account exists, a code was sent', 'ok');
      $('#fpStep1').style.display = 'none'; $('#fpStep2').style.display = 'block'; $('#fpOtp').focus();
    } catch (e) { toast(e.message, 'bad'); }
  });
  $('#fpBack').addEventListener('click', () => { $('#fpStep2').style.display = 'none'; $('#fpStep1').style.display = 'block'; });
  $('#fpReset').addEventListener('click', async () => {
    const otp = $('#fpOtp').value.trim(), password = $('#fpPw').value;
    if (!otp || password.length < 5) { toast('Enter the code and a new password (min 5 chars)', 'bad'); return; }
    try {
      await api('/reset-password', { method: 'POST', body: { ident: ident(), otp, password } });
      toast('Password reset — please sign in', 'ok'); close();
    } catch (e) { toast(e.message, 'bad'); }
  });
}

function renderLogin(errMsg) {
  document.body.classList.add('login-mode');
  $('#root').innerHTML = '';
  const card = h(`<div class="login-wrap"><form class="login" id="loginForm">
    <img class="loginlogo" src="/logo.svg" alt="Drona Valuechain">
    <h1>JMC Operations Tracker</h1>
    <div class="sub">${esc(State.cfg.company.provider)}</div>
    ${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ''}
    <div class="field"><label>Username or email</label><input name="username" autocomplete="username" autofocus required></div>
    <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" style="width:100%" type="submit">Sign in</button>
    <a id="forgotLink" style="display:block;text-align:center;margin-top:10px;color:#9fc3df;cursor:pointer;font-size:13px">Forgot password?</a>
    ${State.cfg.demo ? `<div class="demo"><b>Demo logins</b><br>
      Admin <code>admin / admin123</code><br>
      Operator <code>operator / oper123</code><br>
      HQ <code>hq / hq123</code><br>
      JMC <code>jmc / jmc123</code></div>` : ''}
  </form></div>`);
  $('#root').appendChild(card);
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
      State.user = r.user; document.body.classList.remove('login-mode'); renderApp();
    } catch (err) { renderLogin(err.message); }
  });
  const fl = $('#forgotLink'); if (fl) fl.addEventListener('click', forgotPasswordModal);
}

// ---- shell ----------------------------------------------------------------
function renderApp() {
  const nav = ROLE_NAV[State.user.role] || ['dashboard'];
  if (!nav.includes(State.route)) State.route = 'dashboard';
  $('#root').innerHTML = '';
  const shell = h(`<div class="app">
    <aside class="side">
      <div class="brand"><img class="brandlogo" src="/logo.svg" alt="Drona Valuechain"><div class="bt"><b>Drona Valuechain</b><span>JMC Operations Tracker</span></div></div>
      <nav id="nav"></nav>
      <div class="who"><b>${esc(State.user.name)}</b>${esc(State.user.roleLabel)} · ${esc(State.user.company)}
        <div style="margin-top:8px"><a id="chgpw" style="color:#9fc3df;cursor:pointer">Change password</a>
          <a id="logout" style="color:#9fc3df;cursor:pointer;margin-left:12px">Sign out →</a></div></div>
    </aside>
    <main class="main" id="view"></main>
  </div>`);
  $('#root').appendChild(shell);
  const navEl = $('#nav');
  nav.forEach(r => {
    const m = NAV_META[r];
    const a = h(`<a data-route="${r}" class="${r===State.route?'active':''}"><span class="ic">${m.ic}</span>${m.label}<span class="badge hidden" data-badge="${r}"></span></a>`);
    a.addEventListener('click', () => { State.route = r; renderApp(); });
    navEl.appendChild(a);
  });
  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }); location.reload(); });
  $('#chgpw').addEventListener('click', passwordModal);
  ROUTES[State.route]();
  refreshBadges();
}

async function refreshBadges() {
  try {
    const s = await api('/summary?month=' + monthStr());
    const set = (route, n) => {
      const b = document.querySelector(`[data-badge="${route}"]`);
      if (!b) return;
      if (n > 0) { b.textContent = n; b.classList.remove('hidden'); } else b.classList.add('hidden');
    };
    if (['JMC_APPROVER','ADMIN'].includes(State.user.role)) set('approvals', s.pending_approvals);
    if (['HQ','ADMIN'].includes(State.user.role)) set('requests', s.pending_mp_requests);
    if (['HQ','ADMIN'].includes(State.user.role)) set('onboarding', s.pending_onboarding);
    set('discrepancies', s.open_discrepancies);
    set('capa', s.overdue_capa);
    if (['HQ','ADMIN'].includes(State.user.role)) set('leave', s.pending_leaves);
    set('compliance', s.expiring_docs);
  } catch (_) {}
}

// ---- shared: image resize + QR scanner ------------------------------------
function resizeImage(file, maxPx = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > h && w > maxPx) { h = Math.round(h * maxPx / w); w = maxPx; }
      else if (h > maxPx) { w = Math.round(w * maxPx / h); h = maxPx; }
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    const fr = new FileReader(); fr.onload = () => img.src = fr.result; fr.onerror = reject; fr.readAsDataURL(file);
  });
}

// Worker documents may be PDF or image. PDFs are sent as-is; images are resized.
function fileToUpload(file, maxPx = 1280, quality = 0.7) {
  if (file.type === 'application/pdf')
    return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
  return resizeImage(file, maxPx, quality);
}

// Load the PDI parts master once (cached on State for the autocomplete).
async function ensurePdiParts() {
  if (State.pdiParts) return State.pdiParts;
  try { State.pdiParts = (await api('/pdi-parts')).parts; } catch (_) { State.pdiParts = State.pdiParts || []; }
  return State.pdiParts;
}

// Custom autocomplete for PDI part numbers. Replaces the native <datalist>,
// whose dropdown / scrollbar the browser renders and CSS can't style. Filters
// as you type, supports keyboard nav, and still allows free text.
let pdiDD;
function pdiAutocomplete(input) {
  if (!input) return;
  if (!pdiDD) {
    pdiDD = h('<div class="pdi-dd" style="display:none"></div>');
    document.body.appendChild(pdiDD);
    // Close on page scroll, but NOT when scrolling inside the dropdown itself.
    window.addEventListener('scroll', (ev) => {
      if (ev.target === pdiDD || (pdiDD.contains && ev.target.nodeType && pdiDD.contains(ev.target))) return;
      pdiDD.style.display = 'none'; pdiDD._owner = null;
    }, true);
  }
  let items = [], active = -1;
  const close = () => { if (pdiDD._owner === input) { pdiDD.style.display = 'none'; pdiDD._owner = null; } };
  function render() {
    const q = (input.value || '').trim().toUpperCase();
    const all = State.pdiParts || [];
    items = (q ? all.filter(p => p.part_no.toUpperCase().includes(q)) : all).slice(0, 80);
    if (!items.length) { close(); return; }
    pdiDD._owner = input;
    pdiDD.innerHTML = items.map((p, i) => `<div class="pdi-opt${i === active ? ' active' : ''}" data-i="${i}"><span class="pn">${esc(p.part_no)}</span><span class="cat">${esc(p.category)}</span></div>`).join('');
    const r = input.getBoundingClientRect();
    pdiDD.style.left = Math.round(r.left) + 'px';
    pdiDD.style.top = Math.round(r.bottom + 2) + 'px';
    pdiDD.style.minWidth = Math.round(r.width) + 'px';
    pdiDD.style.display = 'block';
    pdiDD.querySelectorAll('.pdi-opt').forEach(el => el.addEventListener('mousedown', ev => { ev.preventDefault(); choose(+el.dataset.i); }));
  }
  function choose(i) { if (items[i]) { input.value = items[i].part_no; input.dispatchEvent(new Event('input', { bubbles: true })); } close(); }
  function scrollActive() { const el = pdiDD.querySelector('.pdi-opt.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  input.addEventListener('focus', () => ensurePdiParts().then(() => { active = -1; render(); }));
  input.addEventListener('input', () => { active = -1; render(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', ev => {
    if (pdiDD.style.display === 'none' || pdiDD._owner !== input) return;
    if (ev.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); ev.preventDefault(); render(); scrollActive(); }
    else if (ev.key === 'ArrowUp') { active = Math.max(active - 1, 0); ev.preventDefault(); render(); scrollActive(); }
    else if (ev.key === 'Enter') { if (active >= 0) { ev.preventDefault(); choose(active); } }
    else if (ev.key === 'Escape') { close(); }
  });
}

async function scanQR(targetInput) {
  if (!('BarcodeDetector' in window)) { toast('QR scan not supported here — type the code manually', 'bad'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch (e) { toast('Camera blocked — type the code manually', 'bad'); return; }
  const det = new window.BarcodeDetector({ formats: ['qr_code', 'code_128', 'ean_13', 'code_39'] });
  const overlay = h(`<div style="position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px">
    <video autoplay playsinline style="max-width:90vw;max-height:70vh;border-radius:12px"></video>
    <div style="color:#fff">Point the camera at the QR / barcode</div>
    <button class="btn ghost" id="qrCancel">Cancel</button></div>`);
  document.body.appendChild(overlay);
  const video = overlay.querySelector('video'); video.srcObject = stream;
  let stop = false;
  const cleanup = () => { stop = true; stream.getTracks().forEach(t => t.stop()); overlay.remove(); };
  overlay.querySelector('#qrCancel').addEventListener('click', cleanup);
  const tick = async () => {
    if (stop) return;
    try { const codes = await det.detect(video);
      if (codes && codes.length) { targetInput.value = codes[0].rawValue; targetInput.dispatchEvent(new Event('input')); toast('Scanned: ' + codes[0].rawValue, 'ok'); cleanup(); return; }
    } catch (_) {}
    requestAnimationFrame(tick);
  };
  video.addEventListener('loadeddata', () => requestAnimationFrame(tick));
}

function topbar(title, sub) {
  return `<div class="topbar"><div class="crumbs"><h2>${esc(title)}</h2><p>${esc(sub||'')}</p></div></div>`;
}

// Self-service password change — lightweight modal (no native prompt()).
function passwordModal() {
  const ov = h(`<div class="modal-backdrop"><div class="modal">
    <h3>Change password</h3>
    <div class="field"><label>Current password</label><input type="password" id="pwCur" autocomplete="current-password"></div>
    <div class="field"><label>New password <span class="muted small">(min 5 chars)</span></label><input type="password" id="pwNew" autocomplete="new-password"></div>
    <div class="field"><label>Confirm new password</label><input type="password" id="pwNew2" autocomplete="new-password"></div>
    <div class="btn-row" style="justify-content:flex-end;margin-top:4px">
      <button class="btn ghost" id="pwCancel">Cancel</button>
      <button class="btn primary" id="pwSave">Update password</button></div>
  </div></div>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#pwCancel').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('#pwCur').focus();
  ov.querySelector('#pwSave').addEventListener('click', async () => {
    const cur = $('#pwCur').value, nw = $('#pwNew').value, nw2 = $('#pwNew2').value;
    if (nw.length < 5) { toast('New password must be at least 5 characters', 'bad'); return; }
    if (nw !== nw2) { toast('New passwords do not match', 'bad'); return; }
    try {
      await api('/me/password', { method: 'POST', body: { current: cur, password: nw } });
      toast('Password updated', 'ok'); close();
    } catch (e) { toast(e.message, 'bad'); }
  });
}

// ===========================================================================
// DASHBOARD
// ===========================================================================
const ROUTES = {};
ROUTES.dashboard = async function () {
  const v = $('#view');
  v.innerHTML = topbar('Operations Dashboard', `${State.cfg.company.provider} → ${State.cfg.company.client}`) +
    `<div class="btn-row" style="margin-bottom:14px">
       <label class="small" style="margin:0">Month</label>
       <input type="month" id="dashMonth" value="${monthStr()}" style="width:auto">
     </div><div id="dashBody"><div class="empty">Loading…</div></div>`;
  $('#dashMonth').addEventListener('change', loadDash);
  loadDash();

  async function loadDash() {
    const month = $('#dashMonth').value || monthStr();
    const s = await api('/summary?month=' + month);
    const t = s.totals;
    const approvedMp = State.cfg.approvedManpower.reduce((a, x) => a + x.approved, 0);
    const lastMpDay = s.days.slice().reverse().find(d => d.mp_actual > 0);
    const todayMp = lastMpDay ? lastMpDay.mp_actual : 0;
    const kpis = [
      ['tint-brand','Approved Manpower (MG)', approvedMp, 'baseline / day'],
      ['tint-'+(todayMp>=approvedMp?'ok':'warn'),'Latest Actual Manpower', todayMp, todayMp>=approvedMp?'meets baseline':'below baseline'],
      ['tint-brand','Loading Parts', fmt(t.load_parts), `${fmt(t.load_trucks)} trucks`],
      ['tint-brand','Unloading', fmt(t.unload_ton)+' <small>ton</small>', `${fmt(t.unload_trucks)} trucks`],
      ['tint-'+(t.mg_short_days>0?'warn':'ok'),'QC / PDI Parts', fmt(t.qc_parts), `MG ${fmt(s.mg_target)}/day · ${t.mg_short_days} day(s) below`],
      ['tint-brand','Transport Trips', fmt(t.trips), 'this month'],
      ['tint-'+(s.pending_approvals>0?'warn':'ok'),'Pending EOD Approvals', s.pending_approvals, 'awaiting JMC'],
      ['tint-'+(s.pending_mp_requests>0?'warn':'ok'),'Pending MP Requests', s.pending_mp_requests, 'awaiting HQ'],
      ['tint-'+(s.open_discrepancies>0?'bad':'ok'),'Open Discrepancies', s.open_discrepancies, 'concern areas'],
    ];
    let html = `<div class="grid g4" style="margin-bottom:16px">` +
      kpis.map(k => `<div class="kpi ${k[0]}"><div class="l">${k[1]}</div><div class="v">${k[2]}</div><div class="sub muted">${k[3]}</div></div>`).join('') +
      `</div>`;

    // Manpower baseline vs actual
    const mpCat = State.cfg.approvedManpower;
    html += `<div class="card"><h3>Manpower — Approved (MG) vs Latest Actual</h3><table><thead><tr>
      <th>Category</th><th class="num">Approved (MG)</th><th class="num">Latest Actual</th><th>Status</th></tr></thead><tbody>`;
    const lastEntry = lastMpDay ? await api('/entries/' + lastMpDay.id).then(r => r.entry) : null;
    const actualMap = {};
    if (lastEntry) lastEntry.manpower.forEach(m => actualMap[m.category] = m.actual_count);
    mpCat.forEach(c => {
      const act = actualMap[c.category] ?? 0;
      const ok = act >= c.approved;
      html += `<tr><td>${esc(c.label)}</td><td class="num">${c.approved}</td><td class="num">${act}</td>
        <td><span class="pill ${ok?'ok':'bad'}">${ok?'OK':'Short '+(c.approved-act)}</span></td></tr>`;
    });
    html += `</tbody></table>${lastEntry?`<p class="small muted" style="margin-top:8px">Latest entry: ${esc(lastEntry.work_date)} (${esc(lastEntry.status)})</p>`:''}</div>`;

    // Recent days
    html += `<div class="card"><h3>Daily Activity — ${esc(month)}</h3>`;
    if (!s.days.length) html += `<div class="empty">No entries recorded for this month yet.</div>`;
    else {
      html += `<table><thead><tr><th>Date</th><th>Status</th><th class="num">Load (parts)</th>
        <th class="num">Unload (ton)</th><th class="num">QC (parts)</th><th class="num">Trips</th><th class="num">MP</th></tr></thead><tbody>`;
      s.days.slice().reverse().forEach(d => {
        const mgShort = d.qc_parts > 0 && d.qc_parts < s.mg_target;
        html += `<tr><td>${esc(d.work_date)}</td><td><span class="pill ${d.status}">${d.status}</span></td>
          <td class="num">${fmt(d.load_parts)}</td><td class="num">${fmt(d.unload_ton)}</td>
          <td class="num ${mgShort?'flag':''}">${fmt(d.qc_parts)}${mgShort?' ⚠':''}</td>
          <td class="num">${fmt(d.trips)}</td><td class="num">${fmt(d.mp_actual)}</td></tr>`;
      });
      html += `</tbody></table>`;
    }
    html += `</div>`;
    $('#dashBody').innerHTML = html;
  }
};

// ===========================================================================
// DAILY ENTRY  (Operator / Admin)
// ===========================================================================
ROUTES.entry = async function () {
  const v = $('#view');
  v.innerHTML = topbar('Daily Operations Entry', 'Record the day, then submit for JMC end-of-day approval.') +
    `<div class="card"><div class="btn-row">
       <div><label class="small">Operating date</label><input type="date" id="wDate" value="${todayStr()}" style="width:auto"></div>
       <div><label class="small">Shift</label><select id="wShift" style="width:auto"><option>DAY</option><option>NIGHT</option></select></div>
       <button class="btn ghost" id="loadDay">Load date</button>
       <span id="statusPill"></span>
     </div></div><div id="entryForm"></div>`;
  $('#loadDay').addEventListener('click', loadDay);
  loadDay();

  async function loadDay() {
    const date = $('#wDate').value;
    const r = await api('/entry-by-date/' + date);
    const e = r.entry;
    const locked = e && (e.status === 'SUBMITTED' || e.status === 'APPROVED');
    $('#statusPill').innerHTML = e ? `<span class="pill ${e.status}">${e.status}</span>` : `<span class="pill DRAFT">NEW</span>`;
    if (e && e.shift) $('#wShift').value = e.shift;

    const mp = State.cfg.approvedManpower;
    const mpVal = {}; if (e) e.manpower.forEach(m => mpVal[m.category] = m.actual_count);
    const L = e ? e.loading : {}, U = e ? e.unloading : {}, Q = e ? e.qc : {};
    const trips = e ? e.transport : [];

    const mgTarget = State.cfg.mg.qc_daily_parts;
    const form = h(`<div>
      ${locked ? `<div class="card" style="border-left:4px solid var(--warn)"><b>This day is ${e.status}.</b>
        <span class="muted">${e.status==='SUBMITTED'?'Awaiting JMC approval — locked for editing.':'Approved by JMC — locked.'}</span>
        ${e.jmc_remarks?`<div class="small" style="margin-top:6px">JMC remarks: ${esc(e.jmc_remarks)}</div>`:''}</div>`:''}
      ${e && e.status==='REJECTED' ? `<div class="card" style="border-left:4px solid var(--bad)"><b>Rejected by JMC.</b>
        <span class="muted">${esc(e.jmc_remarks||'Please correct and resubmit.')}</span></div>`:''}

      <div class="card"><h3>👷 Manpower (Actual vs Approved baseline)</h3>
        <div class="grid g4" id="mpGrid">
          ${mp.map(c => `<div class="field"><label>${esc(c.label)} <span class="muted small">(MG ${c.approved})</span></label>
            <input type="number" min="0" data-mp="${c.category}" value="${mpVal[c.category]??''}" placeholder="0" ${locked?'disabled':''}></div>`).join('')}
        </div></div>

      <div class="grid g2">
        <div class="card"><h3>📦 Loading <span class="muted small">(per part)</span></h3>
          <div class="field"><label>Parts loaded</label><input type="number" min="0" id="lParts" value="${L.parts_qty||''}" ${locked?'disabled':''}></div>
          <div class="row g2">
            <div class="field"><label>Manpower used</label><input type="number" min="0" id="lMp" value="${L.manpower_count||''}" ${locked?'disabled':''}></div>
            <div class="field"><label>Trucks loaded</label><input type="number" min="0" id="lTrucks" value="${L.truck_count||''}" ${locked?'disabled':''}></div>
          </div></div>

        <div class="card"><h3>🏗️ Unloading <span class="muted small">(per ton)</span></h3>
          <div class="row g2">
            <div class="field"><label>Trucks unloaded</label><input type="number" min="0" id="uTrucks" value="${U.truck_count||''}" ${locked?'disabled':''}></div>
            <div class="field"><label>Weight (Ton)</label><input type="number" min="0" step="0.01" id="uTon" value="${U.weight_ton||''}" ${locked?'disabled':''}></div>
          </div>
          <div class="field"><label>Manpower used</label><input type="number" min="0" id="uMp" value="${U.manpower_count||''}" ${locked?'disabled':''}></div></div>
      </div>

      <div class="card"><h3>🔎 PTL / Quality Check (PDI) <span class="muted small">(per part · MG ${mgTarget}/day)</span></h3>
        <div class="field" style="max-width:220px"><label>QC Inspectors (manpower)</label><input type="number" min="0" id="qMp" value="${Q.manpower_count||''}" ${locked?'disabled':''}></div>
        <div style="overflow-x:auto;margin-top:8px"><table class="qctab"><thead><tr>
          <th style="min-width:120px">Part no.</th><th class="num">Checked</th><th class="num">Rejected</th><th class="num">Rework</th><th>Defect</th><th></th>
        </tr></thead><tbody id="qcRows"></tbody></table></div>
        ${locked?'':`<button class="btn ghost sm" id="qcAdd" style="margin-top:8px">＋ Add part line</button>`}
        <div id="qcSummary" class="qc-summary" style="margin-top:12px"></div>
        <div class="field" style="max-width:300px;margin-top:10px"><label>PPM <span class="muted small">(auto from defects when parts are inspected — target ${fmt(State.cfg.ppmTarget)}, lower is better)</span></label>
          <input type="number" min="0" id="ppm" value="${e&&e.ppm!=null?e.ppm:''}" ${locked?'disabled':''} placeholder="e.g. 850"></div></div>

      <div class="card"><h3>🚚 Transportation <span class="muted small">(from → to · vehicle · time)</span></h3>
        <div id="trips"></div>
        ${locked?'':`<button class="btn ghost sm" id="addTrip">＋ Add trip</button>`}
      </div>

      <div class="card"><h3>📷 Proof Photos <span class="muted small">(truck, parts, gate slip…)</span></h3>
        ${e ? `<div id="photoList" class="inline" style="gap:10px;flex-wrap:wrap"></div>
          ${locked?'':`<div style="margin-top:10px" class="inline"><input type="file" accept="image/*" capture="environment" id="photoInput" style="width:auto">
            <span class="small muted">auto-compressed before upload</span></div>`}`
        : `<div class="muted small">Save the day as a draft first (button below), then you can attach photos.</div>`}
      </div>

      <div class="card"><div class="field"><label>Day notes (optional)</label>
        <textarea id="notes" rows="2" ${locked?'disabled':''}>${esc(e?e.notes||'':'')}</textarea></div>
        ${locked?'':`<div class="btn-row">
          <button class="btn ghost" id="saveDraft">Save draft</button>
          <button class="btn primary" id="submitDay">Submit for JMC approval →</button></div>`}
      </div>
    </div>`);
    $('#entryForm').innerHTML = ''; $('#entryForm').appendChild(form);

    // QC inspection lines + derived quality summary (PPM / FPY)
    const defectTypes = State.cfg.defectTypes || [];
    ensurePdiParts();  // populate the part-number datalist
    const qcRowsEl = $('#qcRows');
    const ppmEl = $('#ppm');
    function readQcRows() {
      return [...qcRowsEl.querySelectorAll('.qc-row')].map(tr => {
        const o = {}; tr.querySelectorAll('[data-q]').forEach(i => o[i.dataset.q] = i.value); return o;
      });
    }
    function updateQcSummary() {
      const rows = readQcRows();
      let chk = 0, rej = 0, rw = 0;
      rows.forEach(r => { chk += +r.checked_qty || 0; rej += +r.rejected_qty || 0; rw += +r.rework_qty || 0; });
      const passed = Math.max(0, chk - rej - rw);
      const fpy = chk ? ((passed / chk) * 100).toFixed(1) : null;
      const ppm = chk ? Math.round((rej / chk) * 1e6) : null;
      const mgPill = chk === 0 ? '' : (chk >= mgTarget ? `<span class="pill ok">MG met</span>` : `<span class="pill bad">Below MG by ${mgTarget - chk}</span>`);
      $('#qcSummary').innerHTML = `<div class="inline" style="gap:16px;flex-wrap:wrap">
        <div><span class="muted small">Checked</span><div><b>${fmt(chk)}</b> ${mgPill}</div></div>
        <div><span class="muted small">Rejected</span><div><b>${fmt(rej)}</b></div></div>
        <div><span class="muted small">Rework</span><div><b>${fmt(rw)}</b></div></div>
        <div><span class="muted small">First-pass yield</span><div><b>${fpy != null ? fpy + '%' : '—'}</b></div></div>
        <div><span class="muted small">PPM (derived)</span><div><b>${ppm != null ? fmt(ppm) : '—'}</b></div></div>
      </div>`;
      if (ppmEl) { if (chk > 0) { ppmEl.value = ppm; ppmEl.disabled = true; } else { ppmEl.disabled = locked; } }
    }
    function qcRow(l = {}) {
      const opt = defectTypes.map(d => `<option ${d === l.defect_type ? 'selected' : ''}>${esc(d)}</option>`).join('');
      const tr = h(`<tr class="qc-row">
        <td><input data-q="part_no" autocomplete="off" value="${esc(l.part_no || '')}" ${locked ? 'disabled' : ''}></td>
        <td><input type="number" min="0" class="num" data-q="checked_qty" value="${l.checked_qty || ''}" ${locked ? 'disabled' : ''}></td>
        <td><input type="number" min="0" class="num" data-q="rejected_qty" value="${l.rejected_qty || ''}" ${locked ? 'disabled' : ''}></td>
        <td><input type="number" min="0" class="num" data-q="rework_qty" value="${l.rework_qty || ''}" ${locked ? 'disabled' : ''}></td>
        <td><select data-q="defect_type" ${locked ? 'disabled' : ''}><option value="">—</option>${opt}</select></td>
        <td class="qc-act"></td></tr>`);
      const act = tr.querySelector('.qc-act');
      if (e) { const rd = h(`<button class="btn ghost sm" title="Raise discrepancy from this defect">⚠</button>`); rd.addEventListener('click', () => discFromQc(tr)); act.appendChild(rd); }
      if (!locked) { const del = h(`<button class="btn ghost sm" data-qdel>✕</button>`); del.addEventListener('click', () => { tr.remove(); updateQcSummary(); }); act.appendChild(del); }
      tr.querySelectorAll('[data-q]').forEach(i => i.addEventListener('input', updateQcSummary));
      if (!locked) pdiAutocomplete(tr.querySelector('[data-q="part_no"]'));
      qcRowsEl.appendChild(tr);
    }
    function discFromQc(tr) {
      const o = {}; tr.querySelectorAll('[data-q]').forEach(i => o[i.dataset.q] = i.value);
      const map = { WRONG_PART: 'WRONG_PART', QR_ISSUE: 'QR_ISSUE' };
      const dtype = map[o.defect_type] || 'OTHER';
      const ov = h(`<div class="modal-backdrop"><div class="modal">
        <h3>Raise discrepancy from QC</h3>
        <div class="field"><label>Type</label><select id="dq_type">${['DISPATCH_VS_BILL','WRONG_PART','QR_ISSUE','TPH_HYZINE','OTHER'].map(t => `<option ${t === dtype ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>Part no.</label><input id="dq_part" value="${esc(o.part_no || '')}"></div>
        <div class="field"><label>Severity</label><select id="dq_sev"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option></select></div>
        <div class="field"><label>Description</label><textarea id="dq_desc" rows="2">QC defect: ${esc(o.defect_type || '—')}${o.rejected_qty ? (' · ' + o.rejected_qty + ' rejected') : ''}</textarea></div>
        <div class="btn-row" style="justify-content:flex-end"><button class="btn ghost" id="dq_cancel">Cancel</button><button class="btn primary" id="dq_save">Raise</button></div>
      </div></div>`);
      document.body.appendChild(ov);
      const close = () => ov.remove();
      ov.querySelector('#dq_cancel').addEventListener('click', close);
      ov.addEventListener('click', ev => { if (ev.target === ov) close(); });
      ov.querySelector('#dq_save').addEventListener('click', async () => {
        try { await api('/discrepancies', { method: 'POST', body: { type: $('#dq_type').value, part_no: $('#dq_part').value, severity: $('#dq_sev').value, description: $('#dq_desc').value, disc_date: date, qc_entry_id: e.id } }); toast('Discrepancy raised', 'ok'); close(); refreshBadges(); }
        catch (err) { toast(err.message, 'bad'); }
      });
    }
    (Q.lines && Q.lines.length ? Q.lines : []).forEach(qcRow);
    if (!locked && qcRowsEl.children.length === 0) qcRow();
    const qcAddBtn = $('#qcAdd'); if (qcAddBtn) qcAddBtn.addEventListener('click', () => qcRow());
    updateQcSummary();

    // Transport rows
    const tripsEl = $('#trips');
    const vt = State.cfg.vehicleTypes, locs = State.cfg.locations;
    function tripRow(t = {}) {
      const opt = (arr, val) => arr.map(o => `<option ${o===val?'selected':''}>${esc(o)}</option>`).join('');
      const row = h(`<div class="trip-row">
        <div><label class="small">From</label><input list="locs" value="${esc(t.from_loc||'')}" data-k="from_loc" ${locked?'disabled':''}></div>
        <div><label class="small">To</label><input list="locs" value="${esc(t.to_loc||'')}" data-k="to_loc" ${locked?'disabled':''}></div>
        <div><label class="small">Vehicle</label><select data-k="vehicle_type" ${locked?'disabled':''}><option value="">—</option>${opt(vt,t.vehicle_type)}</select></div>
        <div><label class="small">Time</label><input type="time" value="${esc(t.trip_time||'')}" data-k="trip_time" ${locked?'disabled':''}></div>
        <div><label class="small">Remarks</label><input value="${esc(t.remarks||'')}" data-k="remarks" ${locked?'disabled':''}></div>
        <div>${locked?'':`<button class="btn ghost sm" data-del style="margin-bottom:1px">✕</button>`}</div>
      </div>`);
      const del = row.querySelector('[data-del]');
      if (del) del.addEventListener('click', () => row.remove());
      tripsEl.appendChild(row);
    }
    if (!document.getElementById('locs')) {
      const dl = h(`<datalist id="locs">${locs.map(l=>`<option value="${esc(l)}">`).join('')}</datalist>`);
      document.body.appendChild(dl);
    }
    trips.forEach(tripRow);
    if (!locked && trips.length === 0) tripRow();
    const addBtn = $('#addTrip'); if (addBtn) addBtn.addEventListener('click', () => tripRow());

    // ---- photos ----
    function renderPhotos() {
      const list = $('#photoList'); if (!list) return;
      const atts = (e && e.attachments) || [];
      list.innerHTML = atts.length ? '' : '<span class="muted small">No photos yet.</span>';
      atts.forEach(a => {
        const card = h(`<div style="text-align:center">
          <a href="${a.url}" target="_blank"><img src="${a.url}" style="width:96px;height:96px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"></a>
          <div class="small muted" style="max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.caption||'')}</div>
          ${!locked?`<button class="btn ghost sm" data-delphoto="${a.id}" style="margin-top:3px">✕</button>`:''}</div>`);
        const d = card.querySelector('[data-delphoto]');
        if (d) d.addEventListener('click', async () => { try { await api('/attachments/'+a.id,{method:'DELETE'});
          e.attachments = e.attachments.filter(x=>x.id!==a.id); renderPhotos(); toast('Photo removed','ok'); } catch(err){ toast(err.message,'bad'); } });
        list.appendChild(card);
      });
    }
    renderPhotos();
    const photoInput = $('#photoInput');
    if (photoInput) photoInput.addEventListener('change', async () => {
      const file = photoInput.files[0]; if (!file) return;
      photoInput.disabled = true;
      try {
        const dataUrl = await resizeImage(file);
        const caption = prompt('Photo caption (optional):') || '';
        await api(`/entries/${e.id}/attachments`, { method:'POST', body:{ dataUrl, caption } });
        const fresh = await api('/entry-by-date/' + date); e.attachments = fresh.entry.attachments;
        renderPhotos(); toast('Photo uploaded','ok');
      } catch (err) { toast(err.message,'bad'); }
      photoInput.value=''; photoInput.disabled = false;
    });

    function collect() {
      const manpower = [...document.querySelectorAll('[data-mp]')].map(i => ({ category: i.dataset.mp, actual_count: i.value }));
      const transport = [...tripsEl.querySelectorAll('.trip-row')].map(r => {
        const o = {}; r.querySelectorAll('[data-k]').forEach(i => o[i.dataset.k] = i.value); return o;
      }).filter(t => t.from_loc && t.to_loc && t.vehicle_type);
      return {
        work_date: date, shift: $('#wShift').value, notes: $('#notes').value, manpower, transport,
        ppm: $('#ppm') ? $('#ppm').value : '',
        loading: { parts_qty: $('#lParts').value, manpower_count: $('#lMp').value, truck_count: $('#lTrucks').value },
        unloading: { truck_count: $('#uTrucks').value, weight_ton: $('#uTon').value, manpower_count: $('#uMp').value },
        qc: { manpower_count: $('#qMp').value, lines: readQcRows() },
      };
    }
    async function save(submit) {
      try {
        await api('/entries', { method: 'POST', body: { ...collect(), submit } });
        toast(submit ? 'Submitted for JMC approval' : 'Draft saved', 'ok');
        loadDay(); refreshBadges();
      } catch (err) { toast(err.message, 'bad'); }
    }
    const sd = $('#saveDraft'), su = $('#submitDay');
    if (sd) sd.addEventListener('click', () => save(false));
    if (su) su.addEventListener('click', () => {
      if (confirm('Submit this day for JMC end-of-day approval? It will be locked for editing.')) save(true);
    });
  }
};

// ===========================================================================
// EOD APPROVALS  (JMC / Admin)
// ===========================================================================
ROUTES.approvals = async function () {
  const v = $('#view');
  v.innerHTML = topbar('End-of-Day Approvals', 'Review submitted daily entries and approve or reject.') +
    `<div class="card"><div class="btn-row"><label class="small" style="margin:0">Show</label>
      <select id="aFilter" style="width:auto"><option value="SUBMITTED">Pending (submitted)</option>
      <option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="">All</option></select></div></div>
    <div id="aList"><div class="empty">Loading…</div></div>`;
  $('#aFilter').addEventListener('change', load);
  load();

  async function load() {
    const st = $('#aFilter').value;
    const r = await api('/entries' + (st ? '?status=' + st : ''));
    if (!r.entries.length) { $('#aList').innerHTML = `<div class="card empty">Nothing here.</div>`; return; }
    const rows = r.entries.map(e => `<tr><td>${esc(e.work_date)}</td><td><span class="pill ${e.status}">${e.status}</span></td>
      <td class="muted small">${esc((e.submitted_at||'').replace('T',' '))}</td>
      <td class="right"><button class="btn ghost sm" data-open="${e.id}">Review</button></td></tr>`).join('');
    $('#aList').innerHTML = `<div class="card"><table><thead><tr><th>Date</th><th>Status</th><th>Submitted</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#aList').querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openEntry(b.dataset.open)));
  }

  async function openEntry(id) {
    const e = (await api('/entries/' + id)).entry;
    const canDecide = e.status === 'SUBMITTED' && ['JMC_APPROVER','ADMIN'].includes(State.user.role);
    const mgShort = e.qc.parts_qty > 0 && !e.mg_met;
    const mpRows = e.manpower.map(m => `<tr><td>${esc(m.category)}</td><td class="num">${m.approved_count}</td>
      <td class="num">${m.actual_count}</td><td><span class="pill ${m.actual_count>=m.approved_count?'ok':'bad'}">${m.actual_count>=m.approved_count?'OK':'Short'}</span></td></tr>`).join('');
    const tripRows = e.transport.length ? e.transport.map(t => `<tr><td>${esc(t.from_loc)} → ${esc(t.to_loc)}</td>
      <td>${esc(t.vehicle_type)}</td><td>${esc(t.trip_time||'—')}</td><td class="muted">${esc(t.remarks||'')}</td></tr>`).join('')
      : `<tr><td colspan="4" class="muted">No trips.</td></tr>`;

    const modal = h(`<div class="card" style="border-left:4px solid var(--brand-2)">
      <div class="sectionhdr"><h3>${esc(e.work_date)} · <span class="pill ${e.status}">${e.status}</span></h3>
        <button class="btn ghost sm" id="closeRev">Close</button></div>
      <div class="grid g4" style="margin-bottom:12px">
        <div class="kpi tint-brand"><div class="l">Loading parts</div><div class="v">${fmt(e.loading.parts_qty)}</div><div class="sub muted">${fmt(e.loading.truck_count)} trucks · ${fmt(e.loading.manpower_count)} MP</div></div>
        <div class="kpi tint-brand"><div class="l">Unloading</div><div class="v">${fmt(e.unloading.weight_ton)}<small> ton</small></div><div class="sub muted">${fmt(e.unloading.truck_count)} trucks</div></div>
        <div class="kpi tint-${mgShort?'warn':'ok'}"><div class="l">QC parts</div><div class="v">${fmt(e.qc.parts_qty)}</div><div class="sub ${mgShort?'flag':'muted'}">${mgShort?('Below MG by '+e.mg_shortfall):'MG '+fmt(e.mg_target)+' met'}</div></div>
        <div class="kpi tint-brand"><div class="l">Transport</div><div class="v">${e.transport.length}</div><div class="sub muted">trips</div></div>
      </div>
      <div class="grid g2">
        <div><h4>Manpower</h4><table><thead><tr><th>Cat</th><th class="num">Appr</th><th class="num">Act</th><th></th></tr></thead><tbody>${mpRows||'<tr><td colspan=4 class=muted>—</td></tr>'}</tbody></table></div>
        <div><h4>Transport trips</h4><table><thead><tr><th>Route</th><th>Vehicle</th><th>Time</th><th>Remarks</th></tr></thead><tbody>${tripRows}</tbody></table></div>
      </div>
      ${e.attachments && e.attachments.length ? `<h4 style="margin-top:12px">Proof photos (${e.attachments.length})</h4>
        <div class="inline" style="gap:10px;flex-wrap:wrap">${e.attachments.map(a=>`<a href="${a.url}" target="_blank">
          <img src="${a.url}" title="${esc(a.caption||'')}" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"></a>`).join('')}</div>`:''}
      ${e.notes?`<p class="small"><b>Notes:</b> ${esc(e.notes)}</p>`:''}
      ${e.jmc_remarks?`<p class="small"><b>JMC remarks:</b> ${esc(e.jmc_remarks)}</p>`:''}
      <p class="small muted">Entered by ${esc(e.created_by_name||'—')}${e.approved_by_name?` · decided by ${esc(e.approved_by_name)}`:''}</p>
      ${canDecide?`<div class="divider"></div>
        <div class="field"><label>Remarks (optional)</label><input id="revRemarks" placeholder="Discrepancy notes, dispatched vs billed, wrong part, QR, etc."></div>
        <div class="btn-row"><button class="btn ok" id="approveBtn">✔ Approve EOD</button>
        <button class="btn bad" id="rejectBtn">✕ Reject</button></div>`:''}
    </div>`);
    $('#aList').prepend(modal);
    modal.scrollIntoView({ behavior: 'smooth' });
    $('#closeRev').addEventListener('click', () => modal.remove());
    if (canDecide) {
      const decide = async (decision) => {
        try {
          await api(`/entries/${id}/decision`, { method: 'POST', body: { decision, remarks: $('#revRemarks').value } });
          toast('Entry ' + (decision === 'APPROVE' ? 'approved' : 'rejected'), 'ok');
          modal.remove(); load(); refreshBadges();
        } catch (err) { toast(err.message, 'bad'); }
      };
      $('#approveBtn').addEventListener('click', () => decide('APPROVE'));
      $('#rejectBtn').addEventListener('click', () => { if (confirm('Reject and send back to operator?')) decide('REJECT'); });
    }
  }
};

// ===========================================================================
// MANPOWER REQUESTS  (Operator raises · HQ approves)
// ===========================================================================
ROUTES.requests = async function () {
  const v = $('#view');
  const canRaise = ['OPERATOR','ADMIN'].includes(State.user.role);
  const canDecide = ['HQ','ADMIN'].includes(State.user.role);
  v.innerHTML = topbar('Extra Manpower Requests', 'Production surge requests — approved by Drona HQ.') +
    (canRaise ? `<div class="card"><h3>Raise a request</h3>
      <div class="grid g4">
        <div class="field"><label>Category</label><select id="rCat">${State.cfg.approvedManpower.map(c=>`<option value="${c.category}">${esc(c.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Extra headcount</label><input type="number" min="1" id="rCount" value="1"></div>
        <div class="field"><label>Needed from</label><input type="date" id="rDate" value="${todayStr()}"></div>
        <div class="field"><label>Current PPM / prod no.</label><input type="number" min="0" id="rPpm" placeholder="e.g. 850"></div>
      </div>
      <div class="field"><label>Reason</label><input id="rReason" placeholder="Production increase / dispatch surge / backlog clearance"></div>
      <button class="btn primary" id="rSubmit">Submit to HQ →</button></div>` : '') +
    `<div class="card"><div class="btn-row"><label class="small" style="margin:0">Show</label>
      <select id="rFilter" style="width:auto"><option value="">All</option><option value="PENDING">Pending</option>
      <option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></select></div></div>
    <div id="rList"></div>`;

  if (canRaise) $('#rSubmit').addEventListener('click', async () => {
    try {
      await api('/manpower-requests', { method: 'POST', body: {
        category: $('#rCat').value, extra_count: $('#rCount').value, needed_date: $('#rDate').value,
        ppm_current: $('#rPpm').value || null, reason: $('#rReason').value } });
      toast('Request submitted to HQ', 'ok'); $('#rReason').value=''; load(); refreshBadges();
    } catch (e) { toast(e.message, 'bad'); }
  });
  $('#rFilter').addEventListener('change', load);
  load();

  async function load() {
    const st = $('#rFilter').value;
    const r = await api('/manpower-requests' + (st ? '?status=' + st : ''));
    if (!r.requests.length) { $('#rList').innerHTML = `<div class="card empty">No requests.</div>`; return; }
    const rows = r.requests.map(q => `<tr>
      <td>${esc(q.req_date)}</td><td>${esc(q.category)}</td><td class="num">+${q.extra_count}</td>
      <td>${esc(q.needed_date||'—')}</td><td class="muted small">${esc(q.reason||'')}</td>
      <td>${q.ppm_current??'—'}</td><td><span class="pill ${q.status}">${q.status}</span></td>
      <td class="right">${q.status==='PENDING'&&canDecide?
        `<button class="btn ok sm" data-app="${q.id}">Approve</button> <button class="btn bad sm" data-rej="${q.id}">Reject</button>`
        :`<span class="muted small">${esc(q.decided_by_name||'')}${q.decision_remarks?': '+esc(q.decision_remarks):''}</span>`}</td></tr>`).join('');
    $('#rList').innerHTML = `<div class="card"><table><thead><tr><th>Raised</th><th>Category</th><th class="num">Extra</th>
      <th>Needed</th><th>Reason</th><th>PPM</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const decide = async (id, decision) => {
      let remarks = '';
      if (decision === 'REJECT') { remarks = prompt('Reason for rejection (optional):') || ''; }
      try { await api(`/manpower-requests/${id}/decision`, { method:'POST', body:{ decision, remarks } });
        toast('Request ' + decision.toLowerCase() + 'd', 'ok'); load(); refreshBadges();
      } catch (e) { toast(e.message, 'bad'); }
    };
    $('#rList').querySelectorAll('[data-app]').forEach(b => b.addEventListener('click', () => decide(b.dataset.app, 'APPROVE')));
    $('#rList').querySelectorAll('[data-rej]').forEach(b => b.addEventListener('click', () => decide(b.dataset.rej, 'REJECT')));
  }
};

// ===========================================================================
// REPORTS
// ===========================================================================
ROUTES.reports = async function () {
  const v = $('#view');
  v.innerHTML = topbar('Monthly Report', 'Consolidated quantities and MG tracking.') +
    `<div class="card"><div class="btn-row">
       <label class="small" style="margin:0">Month</label><input type="month" id="repMonth" value="${monthStr()}" style="width:auto">
       <button class="btn ghost" id="csvBtn">⬇ Export CSV</button></div></div>
     <div id="repBody"><div class="empty">Loading…</div></div>`;
  $('#repMonth').addEventListener('change', load);
  $('#csvBtn').addEventListener('click', exportCsv);
  let last = null;
  load();

  async function load() {
    const s = await api('/summary?month=' + ($('#repMonth').value || monthStr())); last = s;
    const t = s.totals;
    let html = `<div class="grid g4" style="margin-bottom:14px">
      <div class="kpi tint-brand"><div class="l">Loading parts</div><div class="v">${fmt(t.load_parts)}</div><div class="sub muted">${fmt(t.load_trucks)} trucks</div></div>
      <div class="kpi tint-brand"><div class="l">Unloading ton</div><div class="v">${fmt(t.unload_ton)}</div><div class="sub muted">${fmt(t.unload_trucks)} trucks</div></div>
      <div class="kpi tint-${t.mg_short_days>0?'warn':'ok'}"><div class="l">QC parts</div><div class="v">${fmt(t.qc_parts)}</div><div class="sub muted">${t.mg_short_days} day(s) below MG</div></div>
      <div class="kpi tint-brand"><div class="l">Transport trips</div><div class="v">${fmt(t.trips)}</div><div class="sub muted">${t.approved_days} approved day(s)</div></div></div>`;
    html += `<div class="card"><h3>Day-by-day</h3>`;
    if (!s.days.length) html += `<div class="empty">No data.</div>`;
    else {
      html += `<table><thead><tr><th>Date</th><th>Status</th><th class="num">Load parts</th><th class="num">Load trucks</th>
        <th class="num">Unload trucks</th><th class="num">Unload ton</th><th class="num">QC parts</th><th class="num">QC MP</th><th class="num">Trips</th><th>MG</th></tr></thead><tbody>`;
      s.days.forEach(d => { const short = d.qc_parts>0 && d.qc_parts<s.mg_target;
        html += `<tr><td>${esc(d.work_date)}</td><td><span class="pill ${d.status}">${d.status}</span></td>
          <td class="num">${fmt(d.load_parts)}</td><td class="num">${fmt(d.load_trucks)}</td>
          <td class="num">${fmt(d.unload_trucks)}</td><td class="num">${fmt(d.unload_ton)}</td>
          <td class="num">${fmt(d.qc_parts)}</td><td class="num">${fmt(d.qc_mp)}</td><td class="num">${fmt(d.trips)}</td>
          <td>${d.qc_parts===0?'<span class="muted">—</span>':short?`<span class="pill bad">−${s.mg_target-d.qc_parts}</span>`:'<span class="pill ok">met</span>'}</td></tr>`; });
      html += `<tr style="font-weight:700;background:#f8fafc"><td colspan="2">TOTAL</td>
        <td class="num">${fmt(t.load_parts)}</td><td class="num">${fmt(t.load_trucks)}</td>
        <td class="num">${fmt(t.unload_trucks)}</td><td class="num">${fmt(t.unload_ton)}</td>
        <td class="num">${fmt(t.qc_parts)}</td><td></td><td class="num">${fmt(t.trips)}</td><td></td></tr>`;
      html += `</tbody></table>`;
    }
    html += `</div>`;
    $('#repBody').innerHTML = html;
  }
  function exportCsv() {
    if (!last || !last.days.length) { toast('Nothing to export', 'bad'); return; }
    const head = ['Date','Status','Load_parts','Load_trucks','Unload_trucks','Unload_ton','QC_parts','QC_MP','Trips','MP_actual'];
    const lines = [head.join(',')].concat(last.days.map(d =>
      [d.work_date,d.status,d.load_parts,d.load_trucks,d.unload_trucks,d.unload_ton,d.qc_parts,d.qc_mp,d.trips,d.mp_actual].join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `JMC_report_${last.month}.csv`; a.click();
  }
};

// ===========================================================================
// SETTINGS (Admin)
// ===========================================================================
// ===========================================================================
// CAPA / 8D  (corrective & preventive actions)
// ===========================================================================
const CAPA_STATUS = ['OPEN','IN_PROGRESS','DONE','VERIFIED'];
function capaModal(prefill = {}, onSaved) {
  const isEdit = !!prefill.id;
  const prioOpt = (v)=>['LOW','MEDIUM','HIGH'].map(s=>`<option ${s===(v||'MEDIUM')?'selected':''}>${s}</option>`).join('');
  const statusOpt = (v)=>CAPA_STATUS.map(s=>`<option ${s===(v||'OPEN')?'selected':''}>${s}</option>`).join('');
  const canVerify = ['HQ','ADMIN'].includes(State.user.role);
  const ov = h(`<div class="modal-backdrop"><div class="modal" style="max-width:560px">
    <h3>${isEdit?'Edit CAPA / 8D':'New CAPA / 8D'}</h3>
    <div class="field"><label>Title</label><input id="cpTitle" value="${esc(prefill.title||'')}"></div>
    <div class="grid g2">
      <div class="field"><label>Owner</label><input id="cpOwner" value="${esc(prefill.owner||'')}"></div>
      <div class="field"><label>Due date</label><input type="date" id="cpDue" value="${esc(prefill.due_date||'')}"></div>
      <div class="field"><label>Priority</label><select id="cpPrio">${prioOpt(prefill.priority)}</select></div>
      ${isEdit?`<div class="field"><label>Status</label><select id="cpStatus">${statusOpt(prefill.status)}</select></div>`:''}
    </div>
    <div class="field"><label>Root cause</label><textarea id="cpRoot" rows="2">${esc(prefill.root_cause||'')}</textarea></div>
    <div class="field"><label>Corrective action</label><textarea id="cpCorr" rows="2">${esc(prefill.corrective_action||'')}</textarea></div>
    <div class="field"><label>Preventive action</label><textarea id="cpPrev" rows="2">${esc(prefill.preventive_action||'')}</textarea></div>
    ${isEdit?`<div class="field"><label>Verification remarks ${canVerify?'':'<span class="muted small">(only HQ/Admin can set VERIFIED)</span>'}</label><input id="cpVer" value="${esc(prefill.verification_remarks||'')}"></div>`:''}
    <div class="btn-row" style="justify-content:flex-end"><button class="btn ghost" id="cpCancel">Cancel</button>
      <button class="btn primary" id="cpSave">${isEdit?'Save':'Create CAPA'}</button></div>
  </div></div>`);
  document.body.appendChild(ov);
  const close=()=>ov.remove();
  ov.querySelector('#cpCancel').addEventListener('click', close);
  ov.addEventListener('click', e=>{ if(e.target===ov) close(); });
  ov.querySelector('#cpTitle').focus();
  ov.querySelector('#cpSave').addEventListener('click', async () => {
    const body = { title:$('#cpTitle').value, owner:$('#cpOwner').value, due_date:$('#cpDue').value,
      priority:$('#cpPrio').value, root_cause:$('#cpRoot').value, corrective_action:$('#cpCorr').value,
      preventive_action:$('#cpPrev').value };
    if (!body.title.trim()) { toast('Title is required','bad'); return; }
    if (isEdit) { body.status=$('#cpStatus').value; const ver=$('#cpVer'); if(ver) body.verification_remarks=ver.value; }
    if (!isEdit && prefill.discrepancy_id) body.discrepancy_id = prefill.discrepancy_id;
    try { await api(isEdit?('/capa/'+prefill.id):'/capa', { method:isEdit?'PUT':'POST', body });
      toast(isEdit?'CAPA updated':'CAPA created','ok'); close(); if(onSaved) onSaved(); refreshBadges(); }
    catch (e) { toast(e.message,'bad'); }
  });
}

ROUTES.capa = async function () {
  const v = $('#view');
  const canCreate = ['OPERATOR','JMC_APPROVER','HQ','ADMIN'].includes(State.user.role);
  v.innerHTML = topbar('CAPA / 8D', 'Corrective & preventive actions — close quality concerns with accountability.') +
    `<div class="card"><div class="btn-row">
       <label class="small" style="margin:0">Status</label>
       <select id="cFilter" style="width:auto"><option value="">All</option>${CAPA_STATUS.map(s=>`<option value="${s}">${s.replace('_',' ')}</option>`).join('')}</select>
       ${canCreate?`<button class="btn primary sm" id="cNew" style="margin-left:auto">＋ New CAPA</button>`:''}
     </div></div><div id="cList"><div class="empty">Loading…</div></div>`;
  const cNew = $('#cNew'); if (cNew) cNew.addEventListener('click', ()=>capaModal({}, load));
  $('#cFilter').addEventListener('change', load);
  load();

  async function load() {
    const st = $('#cFilter').value;
    const r = await api('/capa' + (st?'?status='+st:''));
    if (!r.capa.length) { $('#cList').innerHTML = `<div class="card empty">No CAPAs yet.</div>`; return; }
    const stPill = s => `<span class="pill ${s==='VERIFIED'?'ok':s==='OPEN'?'bad':''}" ${s==='IN_PROGRESS'?'style="background:#dbeafe;color:#1e40af"':s==='DONE'?'style="background:#dcfce7;color:#166534"':''}>${esc(s.replace('_',' '))}</span>`;
    const rows = r.capa.map(c => `<tr${c.overdue?' style="background:#fff1f2"':''}>
      <td><b>${esc(c.title)}</b>${c.disc_type?`<br><span class="tag">from ${esc(c.disc_type)}${c.disc_part_no?(' '+esc(c.disc_part_no)):''}</span>`:''}</td>
      <td>${esc(c.owner||'—')}</td>
      <td class="small ${c.overdue?'flag':''}">${esc(c.due_date||'—')}${c.overdue?' ⚠':''}</td>
      <td><span class="pill ${c.priority==='HIGH'?'bad':c.priority==='LOW'?'ok':''}" ${c.priority==='MEDIUM'?'style="background:#fef3c7;color:#92400e"':''}>${esc(c.priority)}</span></td>
      <td>${stPill(c.status)}</td>
      <td class="right"><button class="btn ghost sm" data-edit="${c.id}">Open</button></td></tr>`).join('');
    $('#cList').innerHTML = `<div class="card"><table><thead><tr><th>Title</th><th>Owner</th><th>Due</th><th>Priority</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#cList').querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click', ()=>{
      const c = r.capa.find(x=>String(x.id)===b.dataset.edit); if(c) capaModal(c, load); }));
  }
};

ROUTES.settings = async function () {
  const v = $('#view'); const c = State.cfg;
  v.innerHTML = topbar('Settings', 'Rates, MG and approved manpower baseline.') +
    `<div class="card"><h3>Approved manpower (MG baseline)</h3>
      <div class="grid g4" id="mpSet">${c.approvedManpower.map((m,i)=>`<div class="field"><label>${esc(m.label)}</label>
        <input type="number" min="0" data-i="${i}" value="${m.approved}"></div>`).join('')}</div></div>
     <div class="card"><h3>QC Minimum Guarantee</h3>
      <div class="row g2"><div class="field"><label>MG parts / day</label><input type="number" id="mgParts" value="${c.mg.qc_daily_parts}"></div>
      <div class="field"><label>Guarantee months</label><input type="number" id="mgMonths" value="${c.mg.guarantee_months}"></div></div></div>
     <div class="card"><h3>Rates <span class="muted small">(used when billing is enabled)</span></h3>
      <div class="grid g3">
        <div class="field"><label>Loading (₹/part)</label><input type="number" step="0.01" id="rLoad" value="${c.rates.loading.rate}"></div>
        <div class="field"><label>Unloading (₹/ton)</label><input type="number" step="0.01" id="rUnload" value="${c.rates.unloading.rate}"></div>
        <div class="field"><label>QC (₹/part)</label><input type="number" step="0.01" id="rQc" value="${c.rates.qc.rate}"></div>
      </div>
      <label class="inline" style="margin-top:6px"><input type="checkbox" id="showBill" ${c.showBilling?'checked':''} style="width:auto"> Show billing / revenue across the app</label></div>
     <div class="card"><h3>PPM Target</h3>
      <div class="field" style="max-width:260px"><label>Target PPM (lower is better)</label><input type="number" id="ppmTarget" value="${c.ppmTarget}"></div></div>
     <div class="card"><h3>Monthly Costs <span class="muted small">(internal P&L only)</span></h3>
      <div class="grid g3">
        <div class="field"><label>Manpower (₹/mo)</label><input type="number" id="costMp" value="${(c.costs||{}).manpower_monthly||0}"></div>
        <div class="field"><label>Overhead (₹/mo)</label><input type="number" id="costOh" value="${(c.costs||{}).overhead_monthly||0}"></div>
        <div class="field"><label>Transport (₹/mo · 0 = pass-through)</label><input type="number" id="costTr" value="${(c.costs||{}).transport_monthly||0}"></div>
      </div></div>
     <div class="card"><h3>Invoice</h3>
      <div class="grid g3">
        <div class="field"><label>GST %</label><input type="number" step="0.01" id="invGst" value="${(c.invoice||{}).gst_pct||0}"></div>
        <div class="field"><label>GSTIN</label><input id="invGstin" value="${esc((c.invoice||{}).gstin||'')}"></div>
        <div class="field"><label>Bill to</label><input id="invBillTo" value="${esc((c.invoice||{}).bill_to||'')}"></div>
      </div>
      <div class="field"><label>Invoice notes</label><input id="invNotes" value="${esc((c.invoice||{}).notes||'')}"></div>
      <label class="inline"><input type="checkbox" id="mgBill" ${c.mgBilling?'checked':''} style="width:auto"> Bill QC at the guaranteed minimum (MG floor per day)</label></div>
     <div class="card"><h3>Email Alerts <span class="muted small">(SMTP via .env · recipients below)</span></h3>
      <label class="inline"><input type="checkbox" id="alEnabled" ${(c.alerts||{}).enabled?'checked':''} style="width:auto"> Enable email alerts (nightly digest + real-time)</label>
      <div class="field" style="margin-top:8px"><label>Recipients <span class="muted small">(comma-separated emails)</span></label>
        <textarea id="alRecip" rows="2" placeholder="ops@drona.com, hq@drona.com">${esc((c.alerts||{}).recipients||'')}</textarea></div>
      <div class="grid g3">
        <div class="field"><label>Digest hour (0–23)</label><input type="number" min="0" max="23" id="alHour" value="${(c.alerts||{}).digest_hour??2}"></div>
        <div class="field"><label>Flag P&L negative after day</label><input type="number" min="1" max="28" id="alPnlDay" value="${(c.alerts||{}).pnl_day_threshold??20}"></div>
        <div class="field"><label>Pending approvals over</label><input type="number" min="0" id="alPa" value="${(c.alerts||{}).pending_approvals_max??3}"></div>
        <div class="field"><label>Pending MP requests over</label><input type="number" min="0" id="alPm" value="${(c.alerts||{}).pending_mp_max??1}"></div>
        <div class="field"><label>Doc expiry within (days)</label><input type="number" min="1" id="alDoc" value="${(c.alerts||{}).doc_expiry_days??45}"></div>
        <div class="field"><label>MG-short days over</label><input type="number" min="0" id="alMg" value="${(c.alerts||{}).mg_short_days_max??1}"></div>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn ghost sm" id="alTest">Send test email</button>
        <button class="btn ghost sm" id="alPreview">Preview alerts now</button>
      </div>
      <div id="alOut" class="small" style="margin-top:8px"></div></div>
     <button class="btn primary" id="saveSet">Save settings</button>
     <div class="card" style="margin-top:16px"><h3>PDI Parts Master <span class="muted small">(part numbers suggested on QC inspection lines)</span></h3>
       <div id="pdiSummary" class="muted small">Loading…</div>
       <div class="btn-row" style="margin-top:10px">
         <input id="pdiNewNo" placeholder="Part no." style="max-width:160px">
         <select id="pdiNewCat" style="width:auto"><option>CHASSIS</option><option>BUS_BODY</option><option>OTHER</option></select>
         <button class="btn ghost sm" id="pdiAddBtn">＋ Add part</button>
       </div>
       <details style="margin-top:10px"><summary class="small" style="cursor:pointer">Bulk import / re-upload (paste part numbers)</summary>
         <div style="margin-top:8px"><select id="pdiImpCat" style="width:auto"><option>CHASSIS</option><option>BUS_BODY</option><option>OTHER</option></select>
           <textarea id="pdiImpText" rows="3" placeholder="Paste part numbers — space, comma or newline separated" style="margin-top:6px;width:100%"></textarea>
           <button class="btn ghost sm" id="pdiImpBtn" style="margin-top:6px">Import</button></div></details>
       <div id="pdiList" style="margin-top:12px;max-height:320px;overflow:auto"></div>
     </div>`;
  $('#saveSet').addEventListener('click', async () => {
    const approvedManpower = c.approvedManpower.map((m,i)=>({ ...m, approved: Number(document.querySelector(`[data-i="${i}"]`).value)||0 }));
    const body = {
      approvedManpower,
      mg: { qc_daily_parts: Number($('#mgParts').value)||0, guarantee_months: Number($('#mgMonths').value)||0 },
      rates: { loading:{unit:'PART',rate:+$('#rLoad').value||0}, unloading:{unit:'TON',rate:+$('#rUnload').value||0}, qc:{unit:'PART',rate:+$('#rQc').value||0} },
      showBilling: $('#showBill').checked,
      ppmTarget: $('#ppmTarget').value,
      costs: { manpower_monthly:+$('#costMp').value||0, overhead_monthly:+$('#costOh').value||0, transport_monthly:+$('#costTr').value||0 },
      invoice: { gst_pct:+$('#invGst').value||0, gstin:$('#invGstin').value, bill_to:$('#invBillTo').value, notes:$('#invNotes').value },
      mgBilling: $('#mgBill').checked,
      alerts: {
        enabled: $('#alEnabled').checked, recipients: $('#alRecip').value.trim(),
        digest_hour: +$('#alHour').value||0, pnl_day_threshold: +$('#alPnlDay').value||0,
        pending_approvals_max: +$('#alPa').value||0, pending_mp_max: +$('#alPm').value||0,
        doc_expiry_days: +$('#alDoc').value||0, mg_short_days_max: +$('#alMg').value||0,
      },
    };
    try { const r = await api('/settings', { method:'PUT', body }); State.cfg = r.config; toast('Settings saved','ok'); ROUTES.settings(); }
    catch (e) { toast(e.message,'bad'); }
  });
  const alTest = $('#alTest'); if (alTest) alTest.addEventListener('click', async () => {
    try { const r = await api('/alerts/test', { method:'POST', body:{} });
      toast(r.result && r.result.skipped ? ('Skipped: '+r.result.skipped) : 'Test email sent','ok'); }
    catch (e) { toast(e.message,'bad'); } });
  const alPrev = $('#alPreview'); if (alPrev) alPrev.addEventListener('click', async () => {
    try { const r = await api('/alerts/preview');
      $('#alOut').innerHTML = r.items.length
        ? `<b>Would alert (${r.items.length}):</b><ul style="margin:4px 0">${r.items.map(i=>`<li><span class="${i.level==='critical'?'flag':''}">${esc(i.title)}</span> — <span class="muted">${esc(i.detail||'')}</span></li>`).join('')}</ul>${r.smtp_configured?'':'<div class="flag">SMTP not configured in .env — emails are logged &amp; skipped.</div>'}`
        : '<span class="pill ok">No alerts would fire right now.</span>'; }
    catch (e) { toast(e.message,'bad'); } });

  // ---- PDI parts master management ----
  async function loadPdi() {
    let parts;
    try { parts = (await api('/pdi-parts?all=1')).parts; } catch (e) { $('#pdiList').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; return; }
    const byCat = {}; parts.forEach(p => (byCat[p.category] = byCat[p.category] || []).push(p));
    const activeCount = parts.filter(p => p.active).length;
    $('#pdiSummary').innerHTML = `${activeCount} active / ${parts.length} total · ` + Object.keys(byCat).map(k => `${esc(k)}: ${byCat[k].length}`).join(' · ');
    $('#pdiList').innerHTML = Object.keys(byCat).sort().map(cat => `<div style="margin-bottom:10px">
      <div class="small" style="font-weight:600;margin-bottom:4px">${esc(cat)} <span class="muted">(${byCat[cat].length})</span></div>
      <div class="inline" style="gap:6px;flex-wrap:wrap">${byCat[cat].map(p => `<span class="pill ${p.active?'ok':'bad'}" data-pid="${p.id}" style="cursor:pointer" title="click to ${p.active?'deactivate':'activate'}">${esc(p.part_no)}</span>`).join('')}</div></div>`).join('');
    $('#pdiList').querySelectorAll('[data-pid]').forEach(el => el.addEventListener('click', async () => { try { await api('/pdi-parts/'+el.dataset.pid+'/toggle',{method:'POST'}); State.pdiParts = null; loadPdi(); } catch (e) { toast(e.message,'bad'); } }));
  }
  $('#pdiAddBtn').addEventListener('click', async () => { const part_no = $('#pdiNewNo').value.trim(); if (!part_no) { toast('Enter a part number','bad'); return; }
    try { await api('/pdi-parts',{method:'POST',body:{part_no,category:$('#pdiNewCat').value}}); $('#pdiNewNo').value=''; State.pdiParts = null; toast('Part added','ok'); loadPdi(); } catch (e) { toast(e.message,'bad'); } });
  $('#pdiImpBtn').addEventListener('click', async () => { const text = $('#pdiImpText').value; if (!text.trim()) { toast('Paste some part numbers','bad'); return; }
    try { const r = await api('/pdi-parts/import',{method:'POST',body:{category:$('#pdiImpCat').value,text}}); $('#pdiImpText').value=''; State.pdiParts = null; toast(`Imported: ${r.added} new, ${r.updated} updated`,'ok'); loadPdi(); } catch (e) { toast(e.message,'bad'); } });
  loadPdi();
};

// ===========================================================================
// USERS (Admin)
// ===========================================================================
ROUTES.users = async function () {
  const v = $('#view');
  v.innerHTML = topbar('User Management', 'Create logins for Drona and JMC staff.') +
    `<div class="card"><h3>Add user</h3>
      <div class="grid g3">
        <div class="field"><label>Full name</label><input id="uName"></div>
        <div class="field"><label>Username</label><input id="uUser"></div>
        <div class="field"><label>Password</label><input id="uPass"></div>
        <div class="field"><label>Role</label><select id="uRole">${Object.entries(State.cfg.roles).map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join('')}</select></div>
        <div class="field"><label>Company</label><select id="uCo"><option>DRONA</option><option>JMC</option></select></div>
        <div class="field"><label>Email <span class="muted small">(for password reset)</span></label><input id="uEmail" type="email" placeholder="name@company.com"></div>
      </div><button class="btn primary" id="uAdd">Add user</button></div>
     <div id="uList"></div>`;
  $('#uAdd').addEventListener('click', async () => {
    try { await api('/users', { method:'POST', body:{ name:$('#uName').value, username:$('#uUser').value,
      password:$('#uPass').value, role:$('#uRole').value, company:$('#uCo').value, email:$('#uEmail').value } });
      toast('User created','ok'); $('#uName').value=$('#uUser').value=$('#uPass').value=$('#uEmail').value=''; load();
    } catch (e) { toast(e.message,'bad'); }
  });
  load();
  async function load() {
    const r = await api('/users');
    const rows = r.users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.username)}</td>
      <td>${esc(State.cfg.roles[u.role]||u.role)}</td><td>${esc(u.company)}</td>
      <td class="small">${u.email?esc(u.email):'<span class="muted">— none —</span>'}</td>
      <td><span class="pill ${u.active?'ok':'bad'}">${u.active?'Active':'Disabled'}</span></td>
      <td class="right"><button class="btn ghost sm" data-em="${u.id}">Email</button>
        <button class="btn ghost sm" data-pw="${u.id}">Reset PW</button>
        <button class="btn ghost sm" data-tg="${u.id}">${u.active?'Disable':'Enable'}</button></td></tr>`).join('');
    $('#uList').innerHTML = `<div class="card"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Company</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#uList').querySelectorAll('[data-tg]').forEach(b=>b.addEventListener('click', async ()=>{ await api(`/users/${b.dataset.tg}/toggle`,{method:'POST'}); load(); }));
    $('#uList').querySelectorAll('[data-em]').forEach(b=>b.addEventListener('click', async ()=>{
      const em = prompt('Email for password reset (leave blank to clear):'); if(em===null) return;
      try { await api(`/users/${b.dataset.em}/email`,{method:'POST',body:{email:em.trim()}}); toast('Email updated','ok'); load(); }
      catch(e){ toast(e.message,'bad'); }
    }));
    $('#uList').querySelectorAll('[data-pw]').forEach(b=>b.addEventListener('click', async ()=>{
      const p = prompt('New password (min 5 chars):'); if(!p) return;
      try { await api(`/users/${b.dataset.pw}/reset-password`,{method:'POST',body:{password:p}}); toast('Password reset','ok'); }
      catch(e){ toast(e.message,'bad'); }
    }));
  }
};

// ===========================================================================
// AUDIT LOG (Admin)
// ===========================================================================
ROUTES.audit = async function () {
  const v = $('#view');
  v.innerHTML = topbar('Audit Log', 'Recent actions across the system (most recent first).') +
    `<div id="auBody"><div class="empty">Loading…</div></div>`;
  try {
    const r = await api('/audit?limit=300');
    if (!r.entries.length) { $('#auBody').innerHTML = `<div class="card empty">No activity logged yet.</div>`; return; }
    const rows = r.entries.map(e => `<tr>
      <td class="small muted">${esc((e.at||'').replace('T',' '))}</td>
      <td>${esc(e.user_name||'—')}<div class="small muted">${esc(e.username||'')}</div></td>
      <td><span class="tag">${esc(e.action)}</span></td>
      <td class="small muted">${esc(e.detail||'')}</td></tr>`).join('');
    $('#auBody').innerHTML = `<div class="card"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="small muted" style="margin-top:8px">Showing the latest ${r.entries.length} events.</p></div>`;
  } catch (e) { $('#auBody').innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
};

// ===========================================================================
// DISCREPANCIES (concern areas: dispatched vs billed, wrong part, QR, TPH+Hyzine)
// ===========================================================================
ROUTES.discrepancies = async function () {
  const v = $('#view');
  const canRaise = ['OPERATOR','JMC_APPROVER','ADMIN'].includes(State.user.role);
  const canResolve = canRaise;
  const typeOpts = Object.entries(DISC_TYPES).map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join('');
  v.innerHTML = topbar('Discrepancy Log', 'Track and resolve the JMC concern areas.') +
    (canRaise ? `<div class="card"><h3>Raise a discrepancy</h3>
      <div class="grid g4">
        <div class="field"><label>Type</label><select id="dType">${typeOpts}</select></div>
        <div class="field"><label>Date</label><input type="date" id="dDate" value="${todayStr()}"></div>
        <div class="field"><label>Part no.</label><input id="dPart" placeholder="e.g. ABC-123"></div>
        <div class="field"><label>Severity</label><select id="dSev"><option>LOW</option><option selected>MEDIUM</option><option>HIGH</option></select></div>
      </div>
      <div class="grid g4" id="qtyRow">
        <div class="field"><label>Qty dispatched</label><input type="number" min="0" id="dDisp"></div>
        <div class="field"><label>Qty billed</label><input type="number" min="0" id="dBill"></div>
        <div class="field"><label>Variance</label><input id="dVar" disabled placeholder="auto"></div>
        <div class="field"><label>QR / barcode</label><div class="inline" style="gap:6px"><input id="dQr" placeholder="scan or type"><button class="btn ghost sm" id="dScan" type="button">Scan</button></div></div>
      </div>
      <div class="field"><label>Description</label><input id="dDesc" placeholder="What happened? (e.g. wrong part supplied to line, QR mismatch, TPH+Hyzine shortfall)"></div>
      <button class="btn primary" id="dSubmit">Raise discrepancy</button></div>` : '') +
    `<div class="card"><div class="btn-row">
       <label class="small" style="margin:0">Status</label>
       <select id="fStatus" style="width:auto"><option value="OPEN">Open</option><option value="RESOLVED">Resolved</option><option value="">All</option></select>
       <label class="small" style="margin:0">Type</label>
       <select id="fType" style="width:auto"><option value="">All types</option>${typeOpts}</select>
       <label class="small" style="margin:0">Month</label><input type="month" id="fMonth" style="width:auto">
     </div></div>
     <div id="dList"></div>`;

  if (canRaise) {
    const disp = $('#dDisp'), bill = $('#dBill'), varEl = $('#dVar');
    const updVar = () => { const d=Number(disp.value), b=Number(bill.value);
      varEl.value = (disp.value===''&&bill.value==='') ? '' : (d-b); };
    disp.addEventListener('input', updVar); bill.addEventListener('input', updVar);
    $('#dScan').addEventListener('click', () => scanQR($('#dQr')));
    $('#dSubmit').addEventListener('click', async () => {
      try {
        await api('/discrepancies', { method:'POST', body:{
          type:$('#dType').value, disc_date:$('#dDate').value, part_no:$('#dPart').value,
          description:$('#dDesc').value, qty_dispatched:$('#dDisp').value, qty_billed:$('#dBill').value,
          qr_code:$('#dQr').value, severity:$('#dSev').value } });
        toast('Discrepancy raised','ok');
        ['dPart','dDesc','dDisp','dBill','dVar','dQr'].forEach(id=>{const el=$('#'+id); if(el) el.value='';});
        load(); refreshBadges();
      } catch (e) { toast(e.message,'bad'); }
    });
  }
  ['fStatus','fType','fMonth'].forEach(id=>$('#'+id).addEventListener('change', load));
  load();

  async function load() {
    const qs = new URLSearchParams();
    if ($('#fStatus').value) qs.set('status',$('#fStatus').value);
    if ($('#fType').value) qs.set('type',$('#fType').value);
    if ($('#fMonth').value) qs.set('month',$('#fMonth').value);
    const r = await api('/discrepancies' + (qs.toString()?'?'+qs:''));
    if (!r.discrepancies.length) { $('#dList').innerHTML = `<div class="card empty">No discrepancies.</div>`; return; }
    const sevPill = s => `<span class="pill ${s==='HIGH'?'bad':s==='LOW'?'ok':''}" ${s==='MEDIUM'?'style="background:#fef3c7;color:#92400e"':''}>${s}</span>`;
    const rows = r.discrepancies.map(d => {
      const detail = d.type==='DISPATCH_VS_BILL'
        ? `Disp ${d.qty_dispatched??'—'} / Bill ${d.qty_billed??'—'} <b class="${d.variance!==0?'flag':''}">(Δ ${d.variance})</b>`
        : esc(d.description||'');
      return `<tr>
        <td>${esc(d.disc_date)}</td>
        <td>${esc(DISC_TYPES[d.type]||d.type)}</td>
        <td>${esc(d.part_no||'—')}</td>
        <td class="small">${detail}${d.qr_code?`<br><span class="tag">QR ${esc(d.qr_code)}</span>`:''}</td>
        <td>${sevPill(d.severity)}</td>
        <td><span class="pill ${d.status==='OPEN'?'bad':'ok'}">${d.status}</span></td>
        <td class="small muted">${esc(d.raised_by_name||'')} <span class="tag">${esc(d.raised_company||'')}</span></td>
        <td class="right"><button class="btn ghost sm" data-capa="${d.id}" data-ctype="${esc(d.type)}" data-cpart="${esc(d.part_no||'')}" title="Raise a CAPA / 8D from this concern">＋ CAPA</button>
          ${d.status==='OPEN'&&canResolve
          ? ` <button class="btn ok sm" data-res="${d.id}">Resolve</button>`
          : (d.resolution?` <span class="small muted" title="${esc(d.resolution)}">✓ ${esc(d.resolved_by_name||'')}</span>`:'')}</td></tr>`;
    }).join('');
    $('#dList').innerHTML = `<div class="card"><table><thead><tr><th>Date</th><th>Type</th><th>Part</th>
      <th>Detail</th><th>Severity</th><th>Status</th><th>Raised by</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#dList').querySelectorAll('[data-capa]').forEach(b=>b.addEventListener('click',()=>capaModal({ discrepancy_id:b.dataset.capa,
      title:`${DISC_TYPES[b.dataset.ctype]||b.dataset.ctype}${b.dataset.cpart?(' — '+b.dataset.cpart):''}` }, load)));
    $('#dList').querySelectorAll('[data-res]').forEach(b=>b.addEventListener('click', async ()=>{
      const resolution = prompt('Resolution / closing note:') ; if (resolution===null) return;
      try { await api(`/discrepancies/${b.dataset.res}/resolve`,{method:'POST',body:{resolution}});
        toast('Discrepancy resolved','ok'); load(); refreshBadges();
      } catch(e){ toast(e.message,'bad'); }
    }));
  }
};

// ===========================================================================
// MIS DASHBOARD (management info — charts + export)
// ===========================================================================
function svgBars(items, opts = {}) {
  const H = opts.height || 170, padB = 22, padT = 16, padX = 12;
  const max = Math.max(opts.target || 0, ...items.map(i => +i.value || 0), 1);
  const n = Math.max(items.length, 1), slot = 28, bw = 17;
  const W = Math.max(320, padX * 2 + n * slot), plotH = H - padB - padT;
  let bars = '';
  items.forEach((it, i) => {
    const x = padX + i * slot + (slot - bw) / 2;
    const bh = Math.round(((+it.value || 0) / max) * plotH), y = padT + plotH - bh;
    bars += `<rect x="${x}" y="${y}" width="${bw}" height="${bh || 1}" rx="2" fill="${it.color || '#1565a8'}"><title>${esc(it.label)}: ${fmt(it.value)}</title></rect>`;
    if (opts.showVal && (+it.value)) bars += `<text x="${x+bw/2}" y="${y-2}" font-size="8.5" text-anchor="middle" fill="#6b7a8c">${esc(it.value)}</text>`;
    bars += `<text x="${x+bw/2}" y="${H-7}" font-size="8.5" text-anchor="middle" fill="#94a3b8">${esc(it.label)}</text>`;
  });
  let target = '';
  if (opts.target) { const ty = padT + plotH - Math.round((opts.target / max) * plotH);
    target = `<line x1="${padX}" y1="${ty}" x2="${W-padX}" y2="${ty}" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="5 3"/>
      <text x="${W-padX}" y="${ty-3}" font-size="9" text-anchor="end" fill="#dc2626">${esc(opts.targetLabel||('Target '+opts.target))}</text>`; }
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="max-width:100%">${target}${bars}</svg></div>`;
}
function chartCard(title, sub, inner) {
  return `<div class="card"><h3>${esc(title)}${sub?` <span class="muted small">${esc(sub)}</span>`:''}</h3>${inner}</div>`;
}

ROUTES.mis = async function () {
  const v = $('#view');
  v.innerHTML = topbar('MIS Dashboard', `${State.cfg.company.provider} → ${State.cfg.company.client}`) +
    `<div class="card noprint"><div class="btn-row">
       <label class="small" style="margin:0">Month</label><input type="month" id="misMonth" value="${monthStr()}" style="width:auto">
       <button class="btn ghost" id="misPrint">🖨 Print / Save PDF</button>
       <button class="btn ghost" id="misCsv">⬇ Export CSV</button>
     </div></div><div id="misBody"><div class="empty">Loading…</div></div>`;
  $('#misMonth').addEventListener('change', load);
  $('#misPrint').addEventListener('click', () => window.print());
  let M = null;
  $('#misCsv').addEventListener('click', () => {
    if (!M || !M.days.length) { toast('Nothing to export', 'bad'); return; }
    const head = ['Date','Status','Load_parts','Load_trucks','Unload_trucks','Unload_ton','QC_parts','QC_MP','Trips','MP_actual'];
    const lines = [head.join(',')].concat(M.days.map(d => [d.work_date,d.status,d.load_parts,d.load_trucks,d.unload_trucks,d.unload_ton,d.qc_parts,d.qc_mp,d.trips,d.mp_actual].join(',')));
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `JMC_MIS_${M.month}.csv`; a.click();
  });
  load();

  async function load() {
    const month = $('#misMonth').value || monthStr();
    M = await api('/mis?month=' + month);
    const t = M.totals;
    if (!M.opDays) { $('#misBody').innerHTML = `<div class="card empty">No data recorded for ${esc(month)}.</div>`; return; }

    // KPI strip
    const kpis = [
      ['tint-brand','Operating Days', M.opDays, `${t.approved_days} approved`],
      ['tint-'+(M.utilization>=100?'ok':M.utilization>=80?'warn':'bad'),'Manpower Utilization', M.utilization+'%', `${M.avgMpPerDay.toFixed(1)} of ${M.approvedTotal}/day`],
      ['tint-'+(M.mgAchievement>=100?'ok':'warn'),'MG Achievement', M.mgAchievement+'%', `${t.mg_met_days}/${M.qcDays} QC days ≥ ${fmt(M.mgTarget)}`],
      ['tint-brand','QC Parts', fmt(t.qc_parts), 'checked this month'],
      ['tint-brand','Loading / Unloading', fmt(t.load_parts)+' / '+fmt(t.unload_ton)+'t', `${fmt(t.load_trucks)} / ${fmt(t.unload_trucks)} trucks`],
      ['tint-brand','Transport Trips', fmt(t.trips), 'this month'],
      ['tint-'+(M.discTot.open_c>0?'bad':'ok'),'Open Discrepancies', M.discTot.open_c, `${M.discTot.total} total`],
      ['tint-'+(M.discTot.variance!==0?'warn':'ok'),'Dispatch−Bill Variance', fmt(M.discTot.variance), `disp ${fmt(M.discTot.disp)} / bill ${fmt(M.discTot.bill)}`],
    ];
    let html = `<div class="printonly" style="margin-bottom:10px"><h2 style="margin:0">JMC Operations — MIS Report</h2>
      <div class="muted small">${esc(State.cfg.company.provider)} · Month: ${esc(month)} · Generated ${new Date().toLocaleString('en-IN')}</div></div>`;
    html += `<div class="grid g4" style="margin-bottom:16px">` +
      kpis.map(k => `<div class="kpi ${k[0]}"><div class="l">${k[1]}</div><div class="v">${k[2]}</div><div class="sub muted">${k[3]}</div></div>`).join('') + `</div>`;

    // QC vs MG trend
    const qcItems = M.days.map(d => ({ label: d.work_date.slice(8), value: d.qc_parts, color: (d.qc_parts>0&&d.qc_parts<M.mgTarget)?'#d97706':'#0f9d8c' }));
    html += chartCard('QC / PDI Parts per Day', `vs MG ${fmt(M.mgTarget)}/day`, svgBars(qcItems, { target: M.mgTarget, targetLabel: 'MG '+M.mgTarget, showVal:false }));

    // Loading & Unloading
    html += `<div class="grid g2">`;
    html += chartCard('Loading Parts per Day', '', svgBars(M.days.map(d=>({label:d.work_date.slice(8),value:d.load_parts})), {}));
    html += chartCard('Unloading Tons per Day', '', svgBars(M.days.map(d=>({label:d.work_date.slice(8),value:d.unload_ton,color:'#1565a8'})), {}));
    html += `</div>`;

    // Trips/day
    html += chartCard('Transport Trips per Day', '', svgBars(M.days.map(d=>({label:d.work_date.slice(8),value:d.trips,color:'#0b3d64'})), { showVal:true }));

    // PPM trend
    const ppmItems = M.days.filter(d => d.ppm != null).map(d => ({ label: d.work_date.slice(8), value: d.ppm, color: (M.ppmTarget && d.ppm > M.ppmTarget) ? '#dc2626' : '#1f9d55' }));
    if (ppmItems.length) html += chartCard('PPM Trend', `target ${fmt(M.ppmTarget)} · avg ${M.ppmAvg!=null?fmt(M.ppmAvg):'—'} (lower is better)`,
      svgBars(ppmItems, { target: M.ppmTarget, targetLabel: 'Target '+M.ppmTarget, showVal:true }));

    // QC quality — inspection outcomes (from per-part PDI lines)
    const qq = M.qcQuality;
    if (qq && qq.checked > 0) {
      const qkpis = [
        ['tint-brand','Parts Inspected', fmt(qq.checked), `${fmt(qq.passed)} passed`],
        ['tint-'+(qq.rejection_rate>0?'warn':'ok'),'Rejection Rate', qq.rejection_rate+'%', `${fmt(qq.rejected)} rejected · ${fmt(qq.rework)} rework`],
        ['tint-'+(qq.fpy>=99?'ok':'warn'),'First-Pass Yield', (qq.fpy!=null?qq.fpy+'%':'—'), 'passed / checked'],
        ['tint-'+(M.ppmTarget && qq.ppm_derived>M.ppmTarget?'warn':'ok'),'PPM (from defects)', qq.ppm_derived!=null?fmt(qq.ppm_derived):'—', `target ${fmt(M.ppmTarget)}`],
      ];
      html += `<div class="grid g4" style="margin:4px 0 16px">` +
        qkpis.map(k => `<div class="kpi ${k[0]}"><div class="l">${k[1]}</div><div class="v">${k[2]}</div><div class="sub muted">${k[3]}</div></div>`).join('') + `</div>`;
      if (M.defectPareto && M.defectPareto.length) {
        const dItems = M.defectPareto.map(d => ({ label: d.defect_type, value: d.qty, color: '#dc2626' }));
        html += chartCard('Defect Pareto', 'rejected parts by defect type', svgBars(dItems, { showVal:true }));
      }
    }

    // Manpower utilization
    const mpMap = Object.fromEntries(M.mpCat.map(m => [m.category, m]));
    html += `<div class="card"><h3>Manpower Utilization <span class="muted small">avg actual vs approved (MG)</span></h3>
      <table><thead><tr><th>Category</th><th class="num">Approved</th><th class="num">Avg Actual</th><th class="num">Util %</th><th style="width:40%">　</th></tr></thead><tbody>`;
    M.approved.forEach(c => {
      const avg = mpMap[c.category] ? mpMap[c.category].avg_actual : 0;
      const util = c.approved ? Math.round((avg / c.approved) * 100) : 0;
      const col = util >= 100 ? 'var(--ok)' : util >= 80 ? 'var(--warn)' : 'var(--bad)';
      html += `<tr><td>${esc(c.label)}</td><td class="num">${c.approved}</td><td class="num">${avg.toFixed(1)}</td>
        <td class="num">${util}%</td><td><div style="background:#eef2f7;border-radius:6px;height:12px;overflow:hidden">
        <div style="width:${Math.min(util,100)}%;height:100%;background:${col}"></div></div></td></tr>`;
    });
    html += `</tbody></table></div>`;

    // Discrepancy analytics
    const typeItems = M.discByType.map(d => ({ label: (DISC_TYPES[d.type]||d.type).split(' ')[0], value: d.c, color:'#1565a8' }));
    const sevColor = { HIGH:'#dc2626', MEDIUM:'#d97706', LOW:'#1f9d55' };
    const sevItems = M.discBySev.map(d => ({ label: d.severity, value: d.c, color: sevColor[d.severity]||'#64748b' }));
    html += `<div class="grid g2">`;
    html += chartCard('Discrepancies by Type', `${M.discTot.open_c} open / ${M.discTot.total} total`,
      typeItems.length ? svgBars(typeItems, { showVal:true, height:150 }) : '<div class="empty">None.</div>');
    html += chartCard('Discrepancies by Severity', '',
      sevItems.length ? svgBars(sevItems, { showVal:true, height:150 }) : '<div class="empty">None.</div>');
    html += `</div>`;

    // Transport breakdown
    html += `<div class="grid g2">`;
    html += chartCard('Trips by Vehicle', '', M.trByVehicle.length ? svgBars(M.trByVehicle.map(x=>({label:x.vehicle_type.split(' ')[0],value:x.c,color:'#0f9d8c'})),{showVal:true,height:150}) : '<div class="empty">None.</div>');
    let routeTbl = `<div class="card"><h3>Trips by Route</h3>`;
    routeTbl += M.trByRoute.length ? `<table><thead><tr><th>Route</th><th>Vehicle</th><th class="num">Trips</th></tr></thead><tbody>` +
      M.trByRoute.map(r=>`<tr><td>${esc(r.route)}</td><td>${esc(r.vehicle_type)}</td><td class="num">${r.c}</td></tr>`).join('') + `</tbody></table>` : '<div class="empty">No trips.</div>';
    routeTbl += `</div>`;
    html += routeTbl + `</div>`;

    // MP requests summary
    if (M.mpReq.length) {
      html += `<div class="card"><h3>Extra Manpower Requests</h3><table><thead><tr><th>Status</th><th class="num">Requests</th><th class="num">Extra headcount</th></tr></thead><tbody>` +
        M.mpReq.map(r=>`<tr><td><span class="pill ${r.status}">${r.status}</span></td><td class="num">${r.c}</td><td class="num">${r.extra}</td></tr>`).join('') + `</tbody></table></div>`;
    }

    $('#misBody').innerHTML = html;
  }
};

// ===========================================================================
// BILLING & INVOICE (Drona internal — ADMIN / HQ)
// ===========================================================================
ROUTES.billing = async function () {
  const v = $('#view');
  v.innerHTML = topbar('Billing & Invoice', 'Revenue, P&L and the monthly JMC invoice (Drona internal).') +
    `<div class="card noprint"><div class="btn-row">
       <label class="small" style="margin:0">Month</label><input type="month" id="bMonth" value="${monthStr()}" style="width:auto">
       <button class="btn ghost" id="bReport">▦ Monthly report (PDF)</button>
       <button class="btn ghost" id="bInvoice">₹ GST invoice (PDF)</button>
       <button class="btn ghost" id="bPrint">🖨 Print</button></div></div>
     <div id="bBody"><div class="empty">Loading…</div></div>`;
  $('#bMonth').addEventListener('change', load);
  $('#bPrint').addEventListener('click', () => window.print());
  $('#bReport').addEventListener('click', () => window.open('/api/reports/monthly.pdf?month=' + ($('#bMonth').value || monthStr()), '_blank'));
  $('#bInvoice').addEventListener('click', () => window.open('/api/invoice.pdf?month=' + ($('#bMonth').value || monthStr()), '_blank'));
  load();

  async function load() {
    const b = await api('/billing?month=' + ($('#bMonth').value || monthStr()));
    const r = b.revenue, p = b.pnl, inv = b.invoice, q = b.quantities;
    let html = `<div class="grid g4" style="margin-bottom:14px">
      <div class="kpi tint-brand"><div class="l">Total Revenue</div><div class="v">${inr(r.total)}</div><div class="sub muted">service + transport</div></div>
      <div class="kpi tint-brand"><div class="l">Service Revenue</div><div class="v">${inr(r.service)}</div><div class="sub muted">load + unload + QC</div></div>
      <div class="kpi tint-brand"><div class="l">Transport Revenue</div><div class="v">${inr(r.transport)}</div><div class="sub muted">${b.unknown_trips?('⚠ '+b.unknown_trips+' unrated trip(s)'):'all trips rated'}</div></div>
      <div class="kpi tint-${p.gross_profit>=0?'ok':'bad'}"><div class="l">Gross Profit</div><div class="v">${inr(p.gross_profit)}</div><div class="sub muted">margin ${(p.margin*100).toFixed(1)}%</div></div>
    </div>`;

    html += `<div class="card"><h3>Revenue Breakdown</h3><table><thead><tr><th>Service</th><th>Basis</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>
      <tr><td>Loading</td><td class="muted">per part</td><td class="num">${fmt(q.load_parts)}</td><td class="num">₹${b.rates.loading.rate}</td><td class="num">${inr(r.loading)}</td></tr>
      <tr><td>Unloading</td><td class="muted">per ton</td><td class="num">${fmt(q.unload_ton)}</td><td class="num">₹${b.rates.unloading.rate}</td><td class="num">${inr(r.unloading)}</td></tr>
      <tr><td>QC / PDI ${b.mgBilling?'<span class="tag">MG floor</span>':''}</td><td class="muted">per part</td><td class="num">${fmt(q.qc_billed)}${q.qc_mg_uplift?` <span class="muted">(+${fmt(q.qc_mg_uplift)} MG)</span>`:''}</td><td class="num">₹${b.rates.qc.rate}</td><td class="num">${inr(r.qc)}</td></tr>
      <tr><td>Transport</td><td class="muted">per trip</td><td class="num">—</td><td class="num">—</td><td class="num">${inr(r.transport)}</td></tr>
      <tr style="font-weight:700;background:#f8fafc"><td colspan="4">TOTAL REVENUE</td><td class="num">${inr(r.total)}</td></tr>
    </tbody></table></div>`;

    html += `<div class="card"><h3>Transport by Route</h3>`;
    html += b.transport_routes.length ? `<table><thead><tr><th>Route</th><th class="num">Trips</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead><tbody>` +
      b.transport_routes.map(t => `<tr><td>${esc(t.route)} ${t.known?'':'<span class="pill bad">no rate</span>'}</td><td class="num">${t.trips}</td><td class="num">${t.rate!=null?'₹'+t.rate:'—'}</td><td class="num">${inr(t.amount)}</td></tr>`).join('') + `</tbody></table>` : '<div class="empty">No trips.</div>';
    if (b.unknown_trips) html += `<p class="small flag">${b.unknown_trips} trip(s) have no configured rate — add the route under Settings to bill them.</p>`;
    html += `</div>`;

    html += `<div class="card"><h3>Profit &amp; Loss <span class="muted small">(internal)</span></h3><table><tbody>
      <tr><td>Revenue</td><td class="num">${inr(p.revenue)}</td></tr>
      <tr><td>Manpower cost</td><td class="num">−${fmt(p.manpower)}</td></tr>
      <tr><td>Overhead</td><td class="num">−${fmt(p.overhead)}</td></tr>
      <tr><td>Transport cost</td><td class="num">−${fmt(p.transport)}</td></tr>
      <tr style="font-weight:700;border-top:2px solid var(--line)"><td>Gross Profit</td><td class="num">${inr(p.gross_profit)} <span class="muted">(${(p.margin*100).toFixed(1)}%)</span></td></tr>
    </tbody></table><p class="small muted">Costs are editable in Settings → Monthly Costs.</p></div>`;

    html += `<div class="card"><div class="printonly" style="margin-bottom:8px"><h2 style="margin:0">TAX INVOICE</h2>
        <div class="muted small">${esc(State.cfg.company.provider)} · Month ${esc(b.month)} · ${new Date().toLocaleDateString('en-IN')}</div></div>
      <div class="sectionhdr"><h3>Invoice — ${esc(b.month)}</h3></div>
      <div class="grid g2" style="margin-bottom:8px">
        <div class="small"><b>From:</b> ${esc(State.cfg.company.provider)}${inv.gstin?`<br>GSTIN: ${esc(inv.gstin)}`:''}</div>
        <div class="small right"><b>Bill to:</b> ${esc(inv.bill_to)}</div>
      </div>
      <table><thead><tr><th>Description</th><th class="num">Amount</th></tr></thead><tbody>
        <tr><td>Loading — ${fmt(q.load_parts)} parts</td><td class="num">${inr(r.loading)}</td></tr>
        <tr><td>Unloading — ${fmt(q.unload_ton)} ton</td><td class="num">${inr(r.unloading)}</td></tr>
        <tr><td>QC / PDI — ${fmt(q.qc_billed)} parts</td><td class="num">${inr(r.qc)}</td></tr>
        <tr><td>Transportation</td><td class="num">${inr(r.transport)}</td></tr>
        <tr style="font-weight:600"><td class="right">Subtotal</td><td class="num">${inr(inv.subtotal)}</td></tr>
        <tr><td class="right">GST @ ${inv.gst_pct}%</td><td class="num">${inr(inv.gst_amt)}</td></tr>
        <tr style="font-weight:700;background:#f8fafc"><td class="right">Grand Total</td><td class="num">${inr(inv.grand_total)}</td></tr>
      </tbody></table>
      ${inv.notes?`<p class="small muted" style="margin-top:8px">${esc(inv.notes)}</p>`:''}</div>`;

    $('#bBody').innerHTML = html;
  }
};

// ===========================================================================
// WORKERS (HR master) + ATTENDANCE
// ===========================================================================
const F = (label, id, value, dis, type='text') => `<div class="field"><label>${label}</label><input type="${type}" id="${id}" value="${value==null?'':esc(value)}" ${dis||''}></div>`;
const S = (label, id, opts, val, dis) => `<div class="field"><label>${label}</label><select id="${id}" ${dis||''}>${opts.map(o=>`<option ${o===val?'selected':''}>${esc(o)}</option>`).join('')}</select></div>`;
const deb = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

ROUTES.workers = async function () {
  const canManage = ['OPERATOR','ADMIN'].includes(State.user.role);
  const v = $('#view');
  const deep = State.openWorker; State.openWorker = null;  // deep-link from Onboarding queue
  if (deep) showForm(deep); else showList();

  async function showList() {
    v.innerHTML = topbar('Blue Collars — HR Master', 'Manpower profiles, salary structure and documents.') +
      `<div class="card"><div class="btn-row">
        <input id="wq" placeholder="Search name / roll / mobile" style="max-width:240px">
        <select id="wdept" style="width:auto"><option value="">All departments</option>${DEPARTMENTS().map(d=>`<option>${esc(d)}</option>`).join('')}</select>
        <select id="wstatus" style="width:auto"><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="">All</option></select>
        ${canManage?`<button class="btn primary" id="wadd" style="margin-left:auto">＋ Add worker</button>`:''}
      </div></div><div id="wlist"><div class="empty">Loading…</div></div>`;
    $('#wq').addEventListener('input', deb(loadList, 300));
    $('#wdept').addEventListener('change', loadList);
    $('#wstatus').addEventListener('change', loadList);
    if (canManage) $('#wadd').addEventListener('click', () => showForm(null));
    loadList();
  }
  async function loadList() {
    const qs = new URLSearchParams();
    if ($('#wq').value) qs.set('q', $('#wq').value);
    if ($('#wdept').value) qs.set('department', $('#wdept').value);
    if ($('#wstatus').value) qs.set('status', $('#wstatus').value);
    const r = await api('/workers' + (qs.toString()?'?'+qs:''));
    if (!r.workers.length) { $('#wlist').innerHTML = `<div class="card empty">No workers found.</div>`; return; }
    const rows = r.workers.map(w => `<tr>
      <td>${esc(w.roll_no||'—')}</td><td>${esc(w.name)}<div class="small muted">${esc(w.father_name||'')}</div></td>
      <td>${esc(w.department||'—')}<div class="small muted">${esc(w.designation||'')}</div></td>
      <td>${esc(w.mobile||'—')}</td>
      <td class="small">${w.wage_type==='DAILY'?('₹'+fmt(w.daily_wage)+'/day'):('₹'+fmt(w.monthly_gross)+'/mo')}</td>
      <td><span class="pill ${w.status==='ACTIVE'?'ok':'bad'}">${w.status}</span></td>
      <td class="right"><button class="btn ghost sm" data-w="${w.id}">${canManage?'Open':'View'}</button></td></tr>`).join('');
    $('#wlist').innerHTML = `<div class="card"><table><thead><tr><th>Roll</th><th>Name</th><th>Dept</th><th>Mobile</th><th>Wage</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#wlist').querySelectorAll('[data-w]').forEach(b => b.addEventListener('click', () => showForm(b.dataset.w)));
  }

  async function showForm(id) {
    const w = id ? (await api('/workers/'+id)).worker : {};
    const ro = !canManage, dis = ro ? 'disabled' : '';
    const sel = (val, opts) => opts.map(o => `<option ${o===val?'selected':''}>${esc(o)}</option>`).join('');
    v.innerHTML = topbar(id?('Worker — '+w.name):'New Worker', id?('Roll '+(w.roll_no||'—')):'Add a manpower profile') +
     `<div class="card noprint"><button class="btn ghost sm" id="wback">← Back to list</button></div>
      ${id?'<div id="wbanner"></div>':''}
      <div class="card"><div class="inline" style="gap:16px">
        <div id="wphoto" style="width:84px;height:84px;border-radius:10px;background:#eef2f7;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:11px">${w.photo_url?`<img src="${w.photo_url}" style="width:100%;height:100%;object-fit:cover">`:'No photo'}</div>
        <div>${id&&!ro?`<input type="file" accept="image/*" id="wphotoInput"><div class="small muted">passport-size photo</div>`:''}${!id?'<div class="small muted">Save the worker first, then add photo & documents.</div>':''}</div>
      </div></div>
      <div class="card"><h3>Personal</h3><div class="grid g3">
        ${F('Employee Code','f_roll_no',w.roll_no,dis)}${F('Full name *','f_name',w.name,dis)}${F("Father's name",'f_father_name',w.father_name,dis)}
        ${S('Gender','f_gender',['','Male','Female','Other'],w.gender,dis)}${F('Date of birth','f_dob',w.dob,dis,'date')}${F('Blood group','f_blood_group',w.blood_group,dis)}
        ${F('Mobile','f_mobile',w.mobile,dis)}${F('Aadhaar','f_aadhaar',w.aadhaar,dis)}${F('PAN','f_pan',w.pan,dis)}
      </div><div class="field"><label>Address</label><input id="f_address" value="${esc(w.address||'')}" ${dis}></div></div>
      <div class="card"><h3>Employment & Statutory</h3><div class="grid g3">
        <div class="field"><label>Department</label><select id="f_department" ${dis}><option value="">—</option>${sel(w.department,DEPARTMENTS())}</select></div>
        ${F('Designation','f_designation',w.designation,dis)}${F('Supervisor','f_supervisor',w.supervisor,dis)}
        ${F('Date of joining','f_date_of_joining',w.date_of_joining,dis,'date')}${F('Date of exit','f_date_of_exit',w.date_of_exit,dis,'date')}
        <div class="field"><label>Status</label><select id="f_status" ${dis}>${sel(w.status||'ACTIVE',['ACTIVE','INACTIVE'])}</select></div>
        ${F('PF UAN','f_uan',w.uan,dis)}${F('ESIC No','f_esic_no',w.esic_no,dis)}
      </div></div>
      <div class="card"><h3>Salary Structure</h3><div class="grid g3">
        <div class="field"><label>Wage type</label><select id="f_wage_type" ${dis}>${sel(w.wage_type||'MONTHLY',['MONTHLY','DAILY'])}</select></div>
        ${F('Monthly gross (₹)','f_monthly_gross',w.monthly_gross,dis,'number')}${F('Daily wage (₹)','f_daily_wage',w.daily_wage,dis,'number')}
        ${F('Basic (₹)','f_basic',w.basic,dis,'number')}${F('HRA (₹)','f_hra',w.hra,dis,'number')}${F('Allowances (₹)','f_allowances',w.allowances,dis,'number')}
      </div><div class="btn-row"><label class="inline"><input type="checkbox" id="f_pf_applicable" ${w.pf_applicable?'checked':''} ${dis} style="width:auto"> PF applicable</label>
        <label class="inline"><input type="checkbox" id="f_esi_applicable" ${w.esi_applicable?'checked':''} ${dis} style="width:auto"> ESI applicable</label></div></div>
      <div class="card"><h3>Bank</h3><div class="grid g2">
        ${F('Account holder','f_bank_holder',w.bank_holder,dis)}${F('Bank name','f_bank_name',w.bank_name,dis)}
        ${F('Account no','f_account_no',w.account_no,dis)}${F('IFSC','f_ifsc',w.ifsc,dis)}
      </div></div>
      <div class="card"><h3>Emergency contact</h3><div class="grid g3">
        ${F('Name','f_emergency_name',w.emergency_name,dis)}${F('Phone','f_emergency_phone',w.emergency_phone,dis)}${F('Relation','f_emergency_relation',w.emergency_relation,dis)}
      </div></div>
      ${id?`<div class="card"><h3>Onboarding documents <span class="muted small">(image or PDF — Aadhaar, PAN, passbook / cheque)</span></h3>
        <div id="wslots" class="grid g3" style="gap:12px"></div>
        <h4 style="margin:16px 0 6px">Other documents</h4>
        <div id="wdocs" class="inline" style="gap:10px;flex-wrap:wrap"></div>
        ${!ro?`<div class="inline" style="margin-top:10px"><input id="wdocType" placeholder="Doc label (e.g. Driving licence)" style="max-width:200px"><label class="small" style="margin:0">Expiry</label><input type="date" id="wdocExpiry" style="width:auto"><button class="btn ghost sm" id="wdocAdd">＋ Add other</button></div>`:''}
        <input type="file" accept="image/*,application/pdf" id="wdocFile" style="display:none"></div>
       <div id="woffer"></div>`:''}
      ${!ro?`<div class="btn-row" style="margin-bottom:20px"><button class="btn primary" id="wsave">${id?'Save changes':'Create worker'}</button></div>`:''}`;
    $('#wback').addEventListener('click', showList);
    if (id) { renderDocs(w); renderBanner(w); }
    const pi = $('#wphotoInput');
    if (pi) pi.addEventListener('change', async () => { const f=pi.files[0]; if(!f) return;
      try { const dataUrl=await resizeImage(f,640,0.8); const r=await api('/workers/'+id+'/photo',{method:'POST',body:{dataUrl}}); $('#wphoto').innerHTML=`<img src="${r.url}" style="width:100%;height:100%;object-fit:cover">`; toast('Photo updated','ok'); } catch(e){ toast(e.message,'bad'); } pi.value=''; });
    let currentSlot = 'OTHER';
    const fileInput = $('#wdocFile');
    const uploadDoc = (slot) => { currentSlot = slot; if (fileInput) fileInput.click(); };
    if (fileInput) fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0]; if (!f) return;
      const body = { doc_slot: currentSlot };
      if (currentSlot === 'OTHER') { body.doc_type = ($('#wdocType')||{}).value || 'Document'; body.expiry_date = ($('#wdocExpiry')||{}).value || ''; }
      try {
        body.dataUrl = await fileToUpload(f);
        await api('/workers/'+id+'/documents',{method:'POST',body});
        const wk = (await api('/workers/'+id)).worker; renderDocs(wk); renderBanner(wk);
        if (currentSlot === 'OTHER' && $('#wdocType')) $('#wdocType').value = '';
        toast('Document added','ok');
      } catch(e){ toast(e.message,'bad'); }
      fileInput.value = '';
    });
    const addOther = $('#wdocAdd'); if (addOther) addOther.addEventListener('click', () => uploadDoc('OTHER'));
    const sb = $('#wsave');
    if (sb) sb.addEventListener('click', async () => {
      const body = {};
      ['roll_no','name','father_name','gender','dob','blood_group','mobile','address','aadhaar','pan','uan','esic_no','department','designation','date_of_joining','date_of_exit','supervisor','wage_type','monthly_gross','daily_wage','basic','hra','allowances','bank_holder','bank_name','account_no','ifsc','emergency_name','emergency_phone','emergency_relation','status'].forEach(k => body[k] = ($('#f_'+k)||{}).value);
      body.pf_applicable = $('#f_pf_applicable').checked; body.esi_applicable = $('#f_esi_applicable').checked;
      if (!body.name) { toast('Name is required','bad'); return; }
      try { if (id) { await api('/workers/'+id,{method:'PUT',body}); toast('Saved','ok'); }
            else { const r=await api('/workers',{method:'POST',body}); toast('Worker created','ok'); showForm(r.id); } }
      catch(e){ toast(e.message,'bad'); }
    });
    const SLOTS = [['AADHAAR','Aadhaar card'],['PAN','PAN card'],['PASSBOOK','Passbook / cheque']];
    function renderDocs(wk) {
      const docs = wk.documents || [];
      const todayISO = new Date().toISOString().slice(0,10);
      const slotsEl = $('#wslots');
      if (slotsEl) {
        slotsEl.innerHTML = '';
        SLOTS.forEach(([slot,label]) => {
          const d = docs.find(x => x.doc_slot === slot);
          const tile = h(`<div class="slot ${d?'ok':'miss'}">
            <div class="slot-h">${esc(label)} ${d?'<span class="pill ok">✓</span>':'<span class="pill bad">missing</span>'}</div>
            <div class="inline" style="gap:6px;margin-top:6px">
              ${d?`<a href="${d.url}" target="_blank" class="btn ghost sm">${d.is_pdf?'📄 PDF':'🖼 View'}</a>`:''}
              ${!ro?`<button class="btn ${d?'ghost':'primary'} sm" data-up="${slot}">${d?'Replace':'Upload'}</button>`:(d?'':'<span class="muted small">—</span>')}
            </div></div>`);
          const b = tile.querySelector('[data-up]'); if (b) b.addEventListener('click', () => uploadDoc(slot));
          slotsEl.appendChild(tile);
        });
      }
      const el = $('#wdocs'); if (!el) return;
      const others = docs.filter(d => !['AADHAAR','PAN','PASSBOOK'].includes(d.doc_slot));
      el.innerHTML = others.length ? '' : '<span class="muted small">No other documents.</span>';
      others.forEach(d => {
        const exp = d.expiry_date ? `<div class="small ${d.expiry_date<todayISO?'flag':'muted'}">exp ${esc(d.expiry_date)}${d.expiry_date<todayISO?' ⚠':''}</div>` : '';
        const thumb = d.is_pdf
          ? `<div style="width:90px;height:90px;display:flex;align-items:center;justify-content:center;border-radius:8px;border:1px solid var(--line);font-size:30px">📄</div>`
          : `<img src="${d.url}" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">`;
        const c = h(`<div style="text-align:center"><a href="${d.url}" target="_blank">${thumb}</a><div class="small muted">${esc(d.doc_type||'')}</div>${exp}${!ro?`<button class="btn ghost sm" data-dd="${d.id}">✕</button>`:''}</div>`);
        const x = c.querySelector('[data-dd]'); if (x) x.addEventListener('click', async () => { try { await api('/worker-documents/'+d.id,{method:'DELETE'}); const nw=(await api('/workers/'+id)).worker; renderDocs(nw); renderBanner(nw); } catch(e){ toast(e.message,'bad'); } });
        el.appendChild(c);
      });
    }

    function renderBanner(wk) {
      const el = $('#wbanner'); if (!el) return;
      const st = wk.onboard_status || 'APPROVED';
      const meta = {
        DRAFT:   ['Draft',               '#64748b', 'Complete the profile, passport photo and the required documents, then submit for HQ approval.'],
        PENDING: ['Pending HQ approval',  '#b45309', 'Submitted'+(wk.submitted_at?' on '+wk.submitted_at.slice(0,10):'')+' — awaiting HQ decision.'],
        APPROVED:['Approved',             '#15803d', 'Approved'+(wk.approved_at?' on '+wk.approved_at.slice(0,10):'')+'. An offer letter can now be generated.'],
        REJECTED:['Rejected',             '#b91c1c', (wk.approval_remarks?('Reason: '+wk.approval_remarks+'. '):'')+'Fix the issues and resubmit.'],
      }[st] || ['—','#64748b',''];
      const canSubmit = ['OPERATOR','ADMIN'].includes(State.user.role);
      const canDecide = ['HQ','ADMIN'].includes(State.user.role);
      let actions = '';
      if ((st==='DRAFT'||st==='REJECTED') && canSubmit) actions += `<button class="btn primary sm" id="obSubmit">Submit for approval</button>`;
      if (st==='PENDING' && canDecide) actions += `<button class="btn primary sm" id="obApprove">Approve</button><button class="btn ghost sm" id="obReject">Reject</button>`;
      el.innerHTML = `<div class="card" style="border-left:4px solid ${meta[1]}">
        <div class="inline" style="justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div><b style="color:${meta[1]}">Onboarding · ${meta[0]}</b><div class="small muted">${esc(meta[2])}</div></div>
          <div class="btn-row" style="margin:0">${actions}</div></div></div>`;
      const reload = async () => { const nw=(await api('/workers/'+id)).worker; renderBanner(nw); renderOffer(nw); refreshBadges(); };
      const sb=$('#obSubmit'); if(sb) sb.addEventListener('click', async()=>{ try{ await api('/workers/'+id+'/submit',{method:'POST'}); toast('Submitted for HQ approval','ok'); reload(); }catch(e){ toast(e.message,'bad'); } });
      const ab=$('#obApprove'); if(ab) ab.addEventListener('click', async()=>{ if(!confirm('Approve this employee for onboarding?')) return; try{ await api('/workers/'+id+'/approve',{method:'POST',body:{remarks:''}}); toast('Approved','ok'); reload(); }catch(e){ toast(e.message,'bad'); } });
      const rb=$('#obReject'); if(rb) rb.addEventListener('click', async()=>{ const remarks=prompt('Reason for rejection (optional):')||''; try{ await api('/workers/'+id+'/reject',{method:'POST',body:{remarks}}); toast('Rejected','ok'); reload(); }catch(e){ toast(e.message,'bad'); } });
      renderOffer(wk);
    }

    function renderOffer(wk) {
      const el = $('#woffer'); if (!el) return;
      if ((wk.onboard_status||'') !== 'APPROVED') { el.innerHTML = ''; return; }
      const canOffer = ['HQ','ADMIN'].includes(State.user.role);
      el.innerHTML = `<div class="card"><h3>Offer letter</h3>
        ${wk.offer_letter_url
          ? `<div class="inline" style="gap:10px"><a href="${wk.offer_letter_url}" target="_blank" class="btn ghost sm">📄 View current offer letter</a><span class="small muted">${wk.offer_letter_at?'generated '+wk.offer_letter_at.slice(0,10):''}</span></div>`
          : '<div class="small muted">No offer letter generated yet.</div>'}
        ${canOffer?`<div class="btn-row" style="margin-top:10px"><button class="btn primary sm" id="obOffer">${wk.offer_letter_url?'Regenerate':'Generate'} offer letter</button></div>`:''}</div>`;
      const ob=$('#obOffer'); if(ob) ob.addEventListener('click', () => offerModal(wk));
    }

    function offerModal(wk) {
      const isDaily = wk.wage_type === 'DAILY';
      const ov = h(`<div class="modal-backdrop"><div class="modal" style="max-width:480px">
        <h3>Generate offer letter</h3>
        <div class="muted small" style="margin-bottom:8px">Pre-filled from the employee record — edit before generating if needed.</div>
        <div class="field"><label>Designation</label><input id="of_designation" value="${esc(wk.designation||'')}"></div>
        <div class="field"><label>Department</label><input id="of_department" value="${esc(wk.department||'')}"></div>
        <div class="grid g2"><div class="field"><label>Date of joining</label><input type="date" id="of_doj" value="${esc(wk.date_of_joining||'')}"></div>
          <div class="field"><label>Letter date</label><input type="date" id="of_date" value="${todayStr()}"></div></div>
        ${isDaily
          ? `<div class="field"><label>Daily wage (₹)</label><input type="number" id="of_daily" value="${wk.daily_wage||0}"></div>`
          : `<div class="grid g3"><div class="field"><label>Basic (₹)</label><input type="number" id="of_basic" value="${wk.basic||0}"></div>
              <div class="field"><label>HRA (₹)</label><input type="number" id="of_hra" value="${wk.hra||0}"></div>
              <div class="field"><label>Allowances (₹)</label><input type="number" id="of_allow" value="${wk.allowances||0}"></div></div>
             <div class="field"><label>Monthly gross (₹)</label><input type="number" id="of_gross" value="${wk.monthly_gross||0}"></div>`}
        <div class="btn-row" style="justify-content:flex-end;margin-top:4px">
          <button class="btn ghost" id="of_cancel">Cancel</button>
          <button class="btn primary" id="of_gen">Generate PDF</button></div>
      </div></div>`);
      document.body.appendChild(ov);
      const close=()=>ov.remove();
      ov.querySelector('#of_cancel').addEventListener('click', close);
      ov.addEventListener('click', e => { if (e.target === ov) close(); });
      ov.querySelector('#of_gen').addEventListener('click', async () => {
        const body = { designation:$('#of_designation').value, department:$('#of_department').value, date_of_joining:$('#of_doj').value, letter_date:$('#of_date').value };
        if (isDaily) body.daily_wage = $('#of_daily').value;
        else { body.basic=$('#of_basic').value; body.hra=$('#of_hra').value; body.allowances=$('#of_allow').value; body.monthly_gross=$('#of_gross').value; }
        try { const r=await api('/workers/'+id+'/offer-letter',{method:'POST',body}); toast('Offer letter generated','ok'); close(); window.open(r.url,'_blank'); const nw=(await api('/workers/'+id)).worker; renderOffer(nw); renderBanner(nw); }
        catch(e){ toast(e.message,'bad'); }
      });
    }
  }
};

ROUTES.onboarding = async function () {
  const v = $('#view');
  const canDecide = ['HQ','ADMIN'].includes(State.user.role);
  let tab = 'PENDING';
  render();
  function render() {
    const tabs = { PENDING:'Pending approval', DRAFT:'Drafts', APPROVED:'Approved', REJECTED:'Rejected' };
    v.innerHTML = topbar('Employee Onboarding', 'Track new hires from draft through HQ approval and offer letter.') +
      `<div class="card noprint"><div class="btn-row">
        ${Object.keys(tabs).map(s=>`<button class="btn ${tab===s?'primary':'ghost'}" data-tab="${s}">${tabs[s]}</button>`).join('')}
      </div></div><div id="obList"><div class="empty">Loading…</div></div>`;
    v.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{ tab=b.dataset.tab; render(); }));
    load();
  }
  async function load() {
    const r = await api('/workers?onboard='+tab);
    if (!r.workers.length) { $('#obList').innerHTML = `<div class="card empty">No employees in this stage.</div>`; return; }
    const rows = r.workers.map(w=>`<tr>
      <td>${esc(w.name)}<div class="small muted">${esc(w.roll_no||'')}</div></td>
      <td>${esc(w.department||'—')}<div class="small muted">${esc(w.designation||'')}</div></td>
      <td class="small">${w.wage_type==='DAILY'?('₹'+fmt(w.daily_wage)+'/day'):('₹'+fmt(w.monthly_gross)+'/mo')}</td>
      <td>${w.has_offer?'<span class="pill ok">Offer ✓</span>':'<span class="muted small">—</span>'}</td>
      <td class="right"><div class="btn-row" style="justify-content:flex-end;margin:0">
        ${(tab==='PENDING'&&canDecide)?`<button class="btn primary sm" data-ap="${w.id}">Approve</button><button class="btn ghost sm" data-rj="${w.id}">Reject</button>`:''}
        <button class="btn ghost sm" data-open="${w.id}">Open</button></div></td></tr>`).join('');
    $('#obList').innerHTML = `<div class="card"><table><thead><tr><th>Employee</th><th>Dept / role</th><th>Wage</th><th>Offer</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    $('#obList').querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>{ State.openWorker=b.dataset.open; State.route='workers'; renderApp(); }));
    $('#obList').querySelectorAll('[data-ap]').forEach(b=>b.addEventListener('click',async()=>{ if(!confirm('Approve this employee?')) return; try{ await api('/workers/'+b.dataset.ap+'/approve',{method:'POST',body:{remarks:''}}); toast('Approved','ok'); load(); refreshBadges(); }catch(e){ toast(e.message,'bad'); } }));
    $('#obList').querySelectorAll('[data-rj]').forEach(b=>b.addEventListener('click',async()=>{ const remarks=prompt('Reason for rejection (optional):')||''; try{ await api('/workers/'+b.dataset.rj+'/reject',{method:'POST',body:{remarks}}); toast('Rejected','ok'); load(); refreshBadges(); }catch(e){ toast(e.message,'bad'); } }));
  }
};

ROUTES.attendance = async function () {
  const canManage = ['OPERATOR','ADMIN'].includes(State.user.role);
  const v = $('#view');
  let mode = 'mark';
  render();
  function render() {
    v.innerHTML = topbar('Attendance', 'Mark daily attendance and view the monthly register.') +
      `<div class="card noprint"><div class="btn-row">
        <button class="btn ${mode==='mark'?'primary':'ghost'}" id="tabMark">Mark daily</button>
        <button class="btn ${mode==='reg'?'primary':'ghost'}" id="tabReg">Monthly register</button></div></div>
       <div id="attBody"></div>`;
    $('#tabMark').addEventListener('click', () => { mode='mark'; render(); });
    $('#tabReg').addEventListener('click', () => { mode='reg'; render(); });
    if (mode==='mark') markView(); else regView();
  }
  function markView() {
    $('#attBody').innerHTML = `<div class="card"><div class="btn-row">
      <label class="small" style="margin:0">Date</label><input type="date" id="aDate" value="${todayStr()}" style="width:auto">
      <select id="aDept" style="width:auto"><option value="">All departments</option>${DEPARTMENTS().map(d=>`<option>${esc(d)}</option>`).join('')}</select>
      ${canManage?`<button class="btn ghost" id="allPresent">Mark all present</button><button class="btn primary" id="aSave" style="margin-left:auto">Save attendance</button>`:''}
    </div></div><div id="attTable"><div class="empty">Loading…</div></div>`;
    $('#aDate').addEventListener('change', loadMark); $('#aDept').addEventListener('change', loadMark);
    if (canManage) { $('#allPresent').addEventListener('click', ()=>document.querySelectorAll('[data-st]').forEach(s=>s.value='PRESENT')); $('#aSave').addEventListener('click', save); }
    loadMark();
  }
  async function loadMark() {
    const qs = new URLSearchParams(); qs.set('date', $('#aDate').value); if ($('#aDept').value) qs.set('department', $('#aDept').value);
    const r = await api('/attendance?'+qs);
    if (!r.rows.length) { $('#attTable').innerHTML = `<div class="card empty">No active workers${$('#aDept').value?' in this department':''}.</div>`; return; }
    const STAT=['PRESENT','ABSENT','HALF_DAY','LEAVE','WEEKLY_OFF']; const dis=canManage?'':'disabled';
    const rows = r.rows.map(w => `<tr data-wid="${w.worker_id}">
      <td>${esc(w.roll_no||'')}</td><td>${esc(w.name)}<div class="small muted">${esc(w.department||'')}</div></td>
      <td><select data-st ${dis}>${STAT.map(s=>`<option ${(w.status||'PRESENT')===s?'selected':''}>${s}</option>`).join('')}</select></td>
      <td><input type="time" data-in value="${esc(w.in_time||'')}" ${dis} style="width:108px"></td>
      <td><input type="time" data-out value="${esc(w.out_time||'')}" ${dis} style="width:108px"></td>
      <td><input type="number" data-ot value="${w.ot_hours||''}" ${dis} style="width:64px" placeholder="0"></td>
      <td><input data-rem value="${esc(w.remarks||'')}" ${dis} placeholder="—"></td></tr>`).join('');
    $('#attTable').innerHTML = `<div class="card"><table><thead><tr><th>Roll</th><th>Worker</th><th>Status</th><th>In</th><th>Out</th><th>OT</th><th>Remarks</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  async function save() {
    const records = [...document.querySelectorAll('[data-wid]')].map(tr => ({ worker_id: tr.dataset.wid, status: tr.querySelector('[data-st]').value, in_time: tr.querySelector('[data-in]').value, out_time: tr.querySelector('[data-out]').value, ot_hours: tr.querySelector('[data-ot]').value, remarks: tr.querySelector('[data-rem]').value }));
    try { const r=await api('/attendance',{method:'POST',body:{date:$('#aDate').value,records}}); toast('Saved '+r.saved+' records','ok'); } catch(e){ toast(e.message,'bad'); }
  }
  function regView() {
    $('#attBody').innerHTML = `<div class="card"><div class="btn-row"><label class="small" style="margin:0">Month</label><input type="month" id="rMonth" value="${monthStr()}" style="width:auto"><button class="btn ghost" id="rCsv">⬇ Export CSV</button></div></div><div id="regTable"><div class="empty">Loading…</div></div>`;
    let R=null;
    $('#rMonth').addEventListener('change', loadReg); $('#rCsv').addEventListener('click', csv);
    async function loadReg() {
      R = await api('/attendance/register?month='+($('#rMonth').value||monthStr()));
      if (!R.workers.length) { $('#regTable').innerHTML = `<div class="card empty">No active workers.</div>`; return; }
      const dim = new Date(+R.month.slice(0,4), +R.month.slice(5,7), 0).getDate();
      const dayHdr = Array.from({length:dim},(_,i)=>`<th class="num" style="padding:4px">${i+1}</th>`).join('');
      const code={PRESENT:'P',ABSENT:'A',HALF_DAY:'H',LEAVE:'L',WEEKLY_OFF:'O'}, col={P:'#dcfce7',A:'#fee2e2',H:'#fef3c7',L:'#e0e7ff',O:'#eef2f7'};
      const body = R.workers.map(w => { const cells = Array.from({length:dim},(_,i)=>{ const dd=String(i+1).padStart(2,'0'); const d=w.days[dd]; const c=d?code[d.s]:''; return `<td class="num" style="padding:4px;background:${c?col[c]:''}">${c}</td>`; }).join('');
        return `<tr><td style="white-space:nowrap">${esc(w.name)}<div class="small muted">${esc(w.department||'')}</div></td>${cells}<td class="num"><b>${w.present_days}</b></td><td class="num">${w.absent_days}</td><td class="num">${w.ot_hours}</td></tr>`; }).join('');
      $('#regTable').innerHTML = `<div class="card" style="overflow-x:auto"><table style="font-size:11.5px"><thead><tr><th>Worker</th>${dayHdr}<th class="num">P</th><th class="num">A</th><th class="num">OT</th></tr></thead><tbody>${body}</tbody></table>
        <p class="small muted" style="margin-top:8px">P=Present · A=Absent · H=Half-day · L=Leave · O=Weekly off</p></div>`;
    }
    function csv() {
      if (!R || !R.workers.length) { toast('Nothing to export','bad'); return; }
      const dim = new Date(+R.month.slice(0,4), +R.month.slice(5,7), 0).getDate();
      const code={PRESENT:'P',ABSENT:'A',HALF_DAY:'H',LEAVE:'L',WEEKLY_OFF:'O'};
      const head = ['Roll','Name','Department',...Array.from({length:dim},(_,i)=>i+1),'Present','Absent','Leave','OT'];
      const lines = [head.join(',')];
      R.workers.forEach(w => { const cells = Array.from({length:dim},(_,i)=>{ const dd=String(i+1).padStart(2,'0'); return w.days[dd]?code[w.days[dd].s]:''; });
        lines.push([w.roll_no||'', '"'+w.name+'"', w.department||'', ...cells, w.present_days, w.absent_days, w.leave_days, w.ot_hours].join(',')); });
      const blob = new Blob([lines.join('\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`JMC_attendance_${R.month}.csv`; a.click();
    }
    loadReg();
  }
};

// ===========================================================================
// LEAVE MANAGEMENT
// ===========================================================================
ROUTES.leave = async function () {
  const canApply = ['OPERATOR','ADMIN'].includes(State.user.role);
  const canDecide = ['HQ','ADMIN'].includes(State.user.role);
  const v = $('#view'); let mode = 'apps';
  const workers = (await api('/workers?status=ACTIVE')).workers;
  render();
  function render() {
    v.innerHTML = topbar('Leave Management', 'Apply, approve and track leave balances.') +
      `<div class="card noprint"><div class="btn-row">
        <button class="btn ${mode==='apps'?'primary':'ghost'}" id="tA">Applications</button>
        <button class="btn ${mode==='bal'?'primary':'ghost'}" id="tB">Balances</button></div></div><div id="lvBody"></div>`;
    $('#tA').addEventListener('click', () => { mode='apps'; render(); });
    $('#tB').addEventListener('click', () => { mode='bal'; render(); });
    if (mode==='apps') appsView(); else balView();
  }
  function appsView() {
    const wopts = workers.map(w => `<option value="${w.id}">${esc(w.name)} (${esc(w.roll_no||w.id)})</option>`).join('');
    const topts = State.cfg.leaveTypes.map(t => `<option>${t}</option>`).join('');
    $('#lvBody').innerHTML = (canApply?`<div class="card"><h3>Apply for leave</h3>
      <div class="grid g4">
        <div class="field"><label>Worker</label><select id="lW">${wopts}</select></div>
        <div class="field"><label>Type</label><select id="lT">${topts}</select></div>
        <div class="field"><label>From</label><input type="date" id="lF" value="${todayStr()}"></div>
        <div class="field"><label>To</label><input type="date" id="lTo" value="${todayStr()}"></div>
      </div><div class="field"><label>Reason</label><input id="lR" placeholder="optional"></div>
      <button class="btn primary" id="lSubmit">Submit application</button></div>`:'') +
      `<div class="card"><div class="btn-row"><label class="small" style="margin:0">Status</label>
        <select id="lFilter" style="width:auto"><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="">All</option></select></div></div>
       <div id="lList"></div>`;
    if (canApply) $('#lSubmit').addEventListener('click', async () => {
      try { await api('/leave',{method:'POST',body:{worker_id:$('#lW').value,leave_type:$('#lT').value,from_date:$('#lF').value,to_date:$('#lTo').value,reason:$('#lR').value}}); toast('Leave applied','ok'); $('#lR').value=''; loadList(); refreshBadges(); } catch(e){ toast(e.message,'bad'); }
    });
    $('#lFilter').addEventListener('change', loadList);
    loadList();
    async function loadList() {
      const st = $('#lFilter').value;
      const r = await api('/leave'+(st?'?status='+st:''));
      if (!r.leaves.length) { $('#lList').innerHTML = `<div class="card empty">No applications.</div>`; return; }
      const rows = r.leaves.map(l => `<tr><td>${esc(l.worker_name)}<div class="small muted">${esc(l.roll_no||'')}</div></td>
        <td>${esc(l.leave_type)}</td><td>${esc(l.from_date)} → ${esc(l.to_date)}</td><td class="num">${l.days}</td>
        <td class="small">${esc(l.reason||'')}</td><td><span class="pill ${l.status}">${l.status}</span></td>
        <td class="right">${l.status==='PENDING'&&canDecide?`<button class="btn ok sm" data-ap="${l.id}">Approve</button> <button class="btn bad sm" data-rj="${l.id}">Reject</button>`:`<span class="small muted">${esc(l.decided_by_name||'')}</span>`}</td></tr>`).join('');
      $('#lList').innerHTML = `<div class="card"><table><thead><tr><th>Worker</th><th>Type</th><th>Period</th><th class="num">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
      const decide = async (id, decision) => { let remarks=''; if(decision==='REJECT') remarks=prompt('Reason (optional):')||''; try { await api(`/leave/${id}/decision`,{method:'POST',body:{decision,remarks}}); toast('Leave '+decision.toLowerCase()+'d','ok'); loadList(); refreshBadges(); } catch(e){ toast(e.message,'bad'); } };
      $('#lList').querySelectorAll('[data-ap]').forEach(b=>b.addEventListener('click',()=>decide(b.dataset.ap,'APPROVE')));
      $('#lList').querySelectorAll('[data-rj]').forEach(b=>b.addEventListener('click',()=>decide(b.dataset.rj,'REJECT')));
    }
  }
  async function balView() {
    $('#lvBody').innerHTML = `<div class="card"><div class="btn-row"><label class="small" style="margin:0">Year</label><input type="number" id="bYear" value="${new Date().getFullYear()}" style="width:100px"></div></div><div id="balTable"><div class="empty">Loading…</div></div>`;
    $('#bYear').addEventListener('change', loadBal); loadBal();
    async function loadBal() {
      const d = await api('/leave/balances?year='+$('#bYear').value);
      if (!d.workers.length) { $('#balTable').innerHTML = `<div class="card empty">No active workers.</div>`; return; }
      const th = d.types.map(t => `<th class="num">${t}</th>`).join('');
      const rows = d.workers.map(w => `<tr><td>${esc(w.name)}<div class="small muted">${esc(w.department||'')}</div></td>${w.byType.map(b=>`<td class="num" title="entitlement ${b.entitlement} · taken ${b.taken}">${b.balance}<span class="small muted">/${b.entitlement}</span></td>`).join('')}</tr>`).join('');
      $('#balTable').innerHTML = `<div class="card"><table><thead><tr><th>Worker</th>${th}</tr></thead><tbody>${rows}</tbody></table><p class="small muted" style="margin-top:8px">Each cell: remaining / entitlement. Annual policy editable in Settings.</p></div>`;
    }
  }
};

// ===========================================================================
// COMPLIANCE (wage register + document expiry)
// ===========================================================================
ROUTES.compliance = async function () {
  const canWage = ['ADMIN','HQ'].includes(State.user.role);
  const v = $('#view'); let mode = canWage ? 'wage' : 'docs';
  render();
  function render() {
    v.innerHTML = topbar('Compliance', 'Statutory wage register and document-expiry tracking.') +
      `<div class="card noprint"><div class="btn-row">
        ${canWage?`<button class="btn ${mode==='wage'?'primary':'ghost'}" id="tW">Wage Register</button>`:''}
        <button class="btn ${mode==='docs'?'primary':'ghost'}" id="tD">Document Expiry</button></div></div><div id="cBody"></div>`;
    if (canWage) $('#tW').addEventListener('click', () => { mode='wage'; render(); });
    $('#tD').addEventListener('click', () => { mode='docs'; render(); });
    if (mode==='wage' && canWage) wageView(); else docsView();
  }
  function wageView() {
    $('#cBody').innerHTML = `<div class="card noprint"><div class="btn-row"><label class="small" style="margin:0">Month</label><input type="month" id="wgMonth" value="${monthStr()}" style="width:auto"><button class="btn ghost" id="wgPrint">🖨 Print</button><button class="btn ghost" id="wgCsv">⬇ CSV</button></div></div><div id="wgBody"><div class="empty">Loading…</div></div>`;
    let W = null;
    $('#wgMonth').addEventListener('change', loadW); $('#wgPrint').addEventListener('click', ()=>window.print()); $('#wgCsv').addEventListener('click', csv);
    loadW();
    async function loadW() {
      W = await api('/compliance/wage-register?month='+($('#wgMonth').value||monthStr()));
      if (!W.rows.length) { $('#wgBody').innerHTML = `<div class="card empty">No active workers.</div>`; return; }
      const t = W.totals;
      const rows = W.rows.map(r => `<tr><td>${esc(r.roll_no||'')}</td><td>${esc(r.name)}<div class="small muted">${esc(r.department||'')}</div></td><td class="num">${r.present_days}</td><td class="num">${inr(r.gross)}</td><td class="num">${inr(r.ot_pay)}</td><td class="num">−${fmt(r.pf)}</td><td class="num">−${fmt(r.esi)}</td><td class="num"><b>${inr(r.net)}</b></td></tr>`).join('');
      $('#wgBody').innerHTML = `<div class="card"><div class="printonly"><h2 style="margin:0">Wage Register — ${esc(W.month)}</h2><div class="muted small">${esc(State.cfg.company.provider)} · standard ${W.std_days} days</div></div>
        <table><thead><tr><th>Roll</th><th>Worker</th><th class="num">Present</th><th class="num">Gross</th><th class="num">OT</th><th class="num">PF</th><th class="num">ESI</th><th class="num">Net</th></tr></thead><tbody>${rows}
        <tr style="font-weight:700;background:#f8fafc"><td colspan="2">TOTAL</td><td class="num">${t.present}</td><td class="num">${inr(t.gross)}</td><td class="num">${inr(t.ot)}</td><td class="num">−${fmt(t.pf)}</td><td class="num">−${fmt(t.esi)}</td><td class="num">${inr(t.net)}</td></tr>
        </tbody></table><p class="small muted" style="margin-top:8px">Computed from attendance × salary structure. PF 12% of basic; ESI 0.75% of gross (≤ ₹21,000). Costs/policy in Settings.</p></div>`;
    }
    function csv() {
      if (!W || !W.rows.length) { toast('Nothing to export','bad'); return; }
      const head = ['Roll','Name','Department','Present','Gross','OT','PF','ESI','Net'];
      const lines = [head.join(',')];
      W.rows.forEach(r => lines.push([r.roll_no||'', '"'+r.name+'"', r.department||'', r.present_days, r.gross, r.ot_pay, r.pf, r.esi, r.net].join(',')));
      const blob = new Blob([lines.join('\n')],{type:'text/csv'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=`JMC_wage_register_${W.month}.csv`; a.click();
    }
  }
  function docsView() {
    $('#cBody').innerHTML = `<div class="card noprint"><div class="btn-row"><label class="small" style="margin:0">Expiring within</label>
      <select id="dDays" style="width:auto"><option value="30">30 days</option><option value="45" selected>45 days</option><option value="90">90 days</option><option value="365">1 year</option></select></div></div><div id="dxBody"><div class="empty">Loading…</div></div>`;
    $('#dDays').addEventListener('change', loadD); loadD();
    async function loadD() {
      const d = await api('/compliance/document-expiry?days='+$('#dDays').value);
      if (!d.documents.length) { $('#dxBody').innerHTML = `<div class="card empty">No documents expiring in this window. ✓</div>`; return; }
      const rows = d.documents.map(x => `<tr><td>${esc(x.worker_name)}<div class="small muted">${esc(x.roll_no||'')} · ${esc(x.department||'')}</div></td><td>${esc(x.doc_type||'')}</td><td>${esc(x.expiry_date)}</td><td><span class="pill ${x.expired?'bad':'PENDING'}">${x.expired?'EXPIRED':'Expiring'}</span></td><td class="right"><a href="${x.url}" target="_blank" class="btn ghost sm">View</a></td></tr>`).join('');
      $('#dxBody').innerHTML = `<div class="card"><table><thead><tr><th>Worker</th><th>Document</th><th>Expiry</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }
  }
};
