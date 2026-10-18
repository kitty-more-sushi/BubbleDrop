/* BubbleDrop UI — talks only to the local engine (/local/*), identical on Windows and Android. */
'use strict';

const TOKEN = document.querySelector('meta[name="bd-token"]').content;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- icons ----------
const P = {
  radar: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  swap: '<path d="M7 20V4M3 8l4-4 4 4M17 4v16M13 16l4 4 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  archive: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.14L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
  phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14 0M8.5 16.05a6 6 0 0 1 7 0M2 8.82a15 15 0 0 1 20 0"/><circle cx="12" cy="20" r="1"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM17 17h4v4h-4"/>',
  scan: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"/>',
  down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const I = (n) => `<svg class="i" viewBox="0 0 24 24">${P[n] || P.file}</svg>`;

// ---------- formatting ----------
function fmtSize(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
const fmtSpeed = (b) => fmtSize(b) + '/s';
function fmtEta(s) {
  if (!isFinite(s) || s <= 0) return '';
  if (s < 60) return Math.ceil(s) + 's left';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's left';
  return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm left';
}
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function dayLabel(ts) {
  const d = new Date(ts); const t = new Date();
  const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
const platIcon = (p) => (p === 'android' || p === 'ios' ? 'phone' : p === 'web' ? 'globe' : 'laptop');
function fileKind(name) {
  const e = String(name).split('.').pop().toLowerCase();
  if (/^(jpe?g|png|gif|webp|heic|bmp|svg|avif)$/.test(e)) return ['image', 'var(--sky)'];
  if (/^(mp4|mkv|mov|avi|webm|3gp|m4v)$/.test(e)) return ['video', 'var(--pink)'];
  if (/^(mp3|wav|flac|aac|ogg|m4a|opus)$/.test(e)) return ['audio', 'var(--amber)'];
  if (/^(zip|rar|7z|tar|gz|xz)$/.test(e)) return ['archive', 'var(--lilac)'];
  if (e === 'apk' || e === 'apks' || e === 'exe' || e === 'msi') return ['apps', 'var(--mint)'];
  return ['file', 'var(--lilac)'];
}
const isUrl = (t) => /^https?:\/\/\S+$/i.test(String(t).trim());

// ---------- api ----------
async function api(op, body) {
  const r = await fetch('/local/' + op, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-bd-token': TOKEN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const act = (op, body, okMsg) => api(op, body).then((r) => { if (okMsg) toast(okMsg, 'success'); return r; }).catch((e) => { toast(e.message, 'error'); throw e; });

// ---------- state ----------
let S = null;
let H = { rev: -1, items: [] };
const ui = { page: 'nearby', histFilter: 'all', histQuery: '', expanded: new Set(), shownOffer: null, prevStatus: new Map(), mounted: null };
const NAV = [
  { id: 'nearby', label: 'Nearby', icon: 'radar' },
  { id: 'transfers', label: 'Transfers', icon: 'swap' },
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'connect', label: 'Connect', icon: 'link' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

function connectEvents() {
  const es = new EventSource('/local/events?t=' + encodeURIComponent(TOKEN));
  es.onopen = () => $('#offline').classList.remove('on');
  es.onerror = () => $('#offline').classList.add('on');
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'state') { S = ev.state; update(); }
    else if (ev.type === 'toast') toast(ev.msg, ev.kind);
    else if (ev.type === 'text') showText(ev.from, ev.text);
  };
}

// ---------- shell ----------
function renderNav() {
  const active = S ? S.transfers.filter((t) => t.active).length : 0;
  const html = NAV.map((n) => `<button class="${ui.page === n.id ? 'on' : ''}" data-act="go" data-page="${n.id}">${I(n.icon)}<span>${n.label}</span>${n.id === 'transfers' && active ? `<b class="badge">${active}</b>` : ''}</button>`).join('');
  $('#nav').innerHTML = html;
  $('#tabs').innerHTML = html;
}

function renderMe() {
  const m = S.me;
  $('#me-card').innerHTML = `<div class="av" style="--c:${esc(m.color)}">${esc(m.avatar)}</div><div class="meta"><b>${esc(m.name)}</b><small><i class="dot"></i>${m.ips.length ? esc(m.ips[0]) : 'No network'}</small></div>`;
}

function applyTheme() {
  const t = S.settings.theme;
  const dark = t === 'auto' ? matchMedia('(prefers-color-scheme: dark)').matches : t !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.body.classList.toggle('no-bubbles', !S.settings.bubbles);
  if (window.bd && window.bd.setTheme) window.bd.setTheme(dark ? 'dark' : 'light');
}

function go(page) {
  ui.page = page;
  ui.mounted = null;
  closeAllModals(true);
  update();
  $('#page').scrollTop = 0;
}

function update() {
  if (!S) return;
  document.body.classList.toggle('is-android', S.me.platform === 'android');
  applyTheme();
  renderNav();
  renderMe();
  const pg = PAGES[ui.page];
  if (ui.mounted !== ui.page) { $('#page').innerHTML = pg.mount(); ui.mounted = ui.page; pg.after && pg.after(); }
  pg.update();
  handleOffers();
  celebrate();
  if (S.historyRev !== H.rev && ui.page === 'history') loadHistory();
}

// ---------- nearby ----------
const TILES = () => [
  { kind: 'files', label: 'Files', sub: 'Anything at all', icon: 'file', c: 'linear-gradient(135deg,#ff6fae,#ff9a8b)' },
  S.caps.pickMedia && { kind: 'media', label: 'Photos', sub: 'Pics & videos', icon: 'image', c: 'linear-gradient(135deg,#6fd3ff,#8b9cff)' },
  S.caps.pickFolder && { kind: 'folder', label: 'Folder', sub: 'Keeps structure', icon: 'folder', c: 'linear-gradient(135deg,#ffb86b,#ff7eb3)' },
  S.caps.apps && { kind: 'apps', label: 'Apps', sub: 'Share APKs', icon: 'apps', c: 'linear-gradient(135deg,#7ef0c1,#4fc3f7)' },
  { kind: 'text', label: 'Text', sub: 'Notes & links', icon: 'chat', c: 'linear-gradient(135deg,#b28dff,#ff6fae)' },
].filter(Boolean);

const nearby = {
  mount: () => `
    <div class="head"><div><h1>Nearby</h1><p class="sub" id="nb-sub"></p></div>
      <div class="row"><button class="btn ghost sm" data-act="scan">${I('search')}<span id="scan-lbl">Scan network</span></button><button class="btn ghost sm" data-act="go" data-page="connect">${I('qr')}Connect</button></div></div>
    <div class="nearby">
      <div class="radar-wrap">
        <div class="radar" id="radar">
          <div class="orbit o1"></div><div class="orbit o2"></div><div class="sweep"></div>
          <div class="pulse"></div><div class="pulse d2"></div><div class="pulse d3"></div>
          <div class="me"><img src="/static/mascot.jpg" alt=""><span class="me-label" id="me-label"></span></div>
          <div id="devs"></div>
        </div>
        <div class="empty-hint" id="nb-empty"></div>
      </div>
      <div>
        <section class="card">
          <h3>What are we sending?</h3>
          <div class="tiles">${TILES().map((t) => `<button class="tile" data-act="pick" data-kind="${t.kind}"><span class="ti" style="--tc:${t.c}">${I(t.icon)}</span>${t.label}<small>${t.sub}</small></button>`).join('')}</div>
          ${S.caps.dragDrop ? '<div class="drop-hint">or drag & drop files anywhere ✨</div>' : ''}
        </section>
        <section class="card" id="tray"></section>
        <div id="nb-active" style="margin-top:16px"></div>
      </div>
    </div>
    <div class="sig-foot page-sig">made with 💗 by <b>kitty_no_sushie</b></div>`,
  update() {
    const devs = S.devices;
    const sel = S.selection;
    $('#me-label').innerHTML = 'You<span class="me-full"> · ' + esc(S.me.name) + '</span>';
    $('#nb-sub').textContent = devs.length ? `${devs.length} device${devs.length > 1 ? 's' : ''} nearby${sel.count ? ' — tap one to send' : ''}` : 'Looking for bubbles nearby…';
    $('#scan-lbl').textContent = S.scanning ? 'Scanning…' : 'Scan network';
    $('#nb-empty').innerHTML = devs.length ? '' : `<b>No one here yet.</b><br>Open BubbleDrop on your other device and join the same Wi-Fi or hotspot. No internet or mobile data needed.`;
    renderDevices(devs, sel.count > 0);
    // tray
    const tray = $('#tray');
    if (!sel.count) {
      tray.innerHTML = `<div class="row"><div class="av sm" style="--c:var(--lilac)">🫧</div><div class="grow"><b>Your bubble is empty</b><div class="muted" style="font-size:13px">Pick files above, then tap a device to send.</div></div></div>`;
    } else {
      const chips = sel.items.slice(0, 60).map((i) => `<span class="chip">${i.icon ? `<img src="${esc(i.icon)}&t=${encodeURIComponent(TOKEN)}" alt="">` : ''}<span title="${esc(i.rel || i.name)}">${esc(i.name)}</span><small>${fmtSize(i.size)}</small><button data-act="unselect" data-id="${esc(i.id)}" aria-label="Remove">${I('x')}</button></span>`).join('');
      tray.innerHTML = `<div class="tray-head"><span class="count">${sel.count}</span><div class="grow"><b>item${sel.count > 1 ? 's' : ''} ready</b><div class="muted" style="font-size:13px">${fmtSize(sel.total)} total</div></div><button class="btn sm ghost" data-act="clear-sel">${I('trash')}Clear</button></div>
        <div class="chips">${chips}${sel.count > 60 ? `<span class="chip">+${sel.count - 60} more</span>` : ''}</div>
        <div class="cta">${devs.length ? '💨 Now tap a device bubble to send' : '⏳ Waiting for a device to show up…'}</div>`;
    }
    const act = S.transfers.filter((t) => t.active);
    $('#nb-active').innerHTML = act.length ? act.map(transferCard).join('') : '';
  },
};

function hashAngle(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function renderDevices(devs, ready) {
  const box = $('#devs');
  const seen = new Set();
  const n = devs.length;
  const inner = Math.min(n, 6);
  const base = n ? hashAngle(devs[0].id) : 0;
  devs.forEach((d, i) => {
    seen.add(d.id);
    const onInner = i < inner;
    const count = onInner ? inner : n - inner;
    const idx = onInner ? i : i - inner;
    const ang = ((base + (360 / count) * idx + (onInner ? -90 : -60)) * Math.PI) / 180;
    const rad = onInner ? 31 : 46;
    const x = 50 + rad * Math.cos(ang);
    const y = 50 + rad * Math.sin(ang);
    const tr = S.transfers.find((t) => t.active && t.peer.id === d.id);
    const pct = tr && tr.total ? Math.round((tr.bytes / tr.total) * 100) : tr ? 3 : 0;
    let el = box.querySelector(`[data-id="${CSS.escape(d.id)}"]`);
    if (!el) {
      el = document.createElement('button');
      el.className = 'dev pop-in';
      el.dataset.act = 'dev';
      el.dataset.id = d.id;
      el.style.setProperty('--dl', (i * 0.37) % 2 + 's');
      box.appendChild(el);
      setTimeout(() => el.classList.remove('pop-in'), 600);
    }
    el.classList.toggle('ready', ready && !tr);
    el.style.left = x + '%';
    el.style.top = y + '%';
    const sig = [d.name, d.avatar, d.color, d.platform, d.trusted, pct].join('|');
    if (el._sig !== sig) {
      el._sig = sig;
      el.title = `${d.name} · ${d.ip}`;
      el.innerHTML = `<span class="bub" style="--c:${esc(d.color)}">${tr ? `<i class="prog" style="--p:${pct}"></i>` : ''}${esc(d.avatar)}<span class="plat">${I(platIcon(d.platform))}</span>${d.trusted ? '<span class="heart">💗</span>' : ''}</span><span class="nm">${esc(d.name)}</span>`;
    }
  });
  for (const el of [...box.children]) {
    if (!seen.has(el.dataset.id) && !el.classList.contains('pop-out')) {
      el.classList.add('pop-out');
      setTimeout(() => el.remove(), 350);
    }
  }
}

// ---------- transfers ----------
function statusPill(t) {
  const m = { waiting: ['Waiting for OK', 'warn'], transferring: [t.dir === 'in' ? 'Receiving' : 'Sending', 'live'], done: ['Done', 'ok'], partial: ['Partly done', 'warn'], declined: ['Declined', 'bad'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', ''] }[t.status] || [t.status, ''];
  return `<span class="pill ${m[1]}">${m[0]}</span>`;
}

function transferCard(t) {
  const pct = t.total ? Math.min(100, (t.bytes / t.total) * 100) : t.status === 'done' ? 100 : 0;
  const what = t.text && !t.count ? '💬 ' + esc(t.text.slice(0, 80)) : esc(t.count === 1 ? t.names[0] : `${t.count} files`) + (t.count > 1 && t.names.length ? ` <span class="faint">· ${esc(t.names.slice(0, 2).join(', '))}${t.count > 2 ? '…' : ''}</span>` : '');
  const eta = t.active && t.speed ? fmtEta((t.total - t.bytes) / t.speed) : '';
  const acts = t.active
    ? `<button class="btn sm ghost" data-act="cancel" data-sid="${t.sid}">${I('x')}Cancel</button>`
    : `${t.dir === 'out' && t.status !== 'done' ? `<button class="btn sm" data-act="retry" data-sid="${t.sid}">${I('refresh')}Retry</button>` : ''}<button class="icon-btn sm" data-act="dismiss" data-sid="${t.sid}" aria-label="Dismiss">${I('x')}</button>`;
  return `<div class="tr">
    <div class="av" style="--c:${esc(t.peer.color)}">${esc(t.peer.avatar)}</div>
    <div style="min-width:0"><div class="t1"><span class="dir ${t.dir}">${I(t.dir === 'in' ? 'down' : 'up')}</span>${t.dir === 'in' ? 'From' : 'To'} ${esc(t.peer.name)} ${statusPill(t)}</div><div class="t2">${what}</div></div>
    <div class="acts">${acts}</div>
    ${t.count ? `<div class="bar ${t.active && t.status === 'transferring' ? 'live' : ''}"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="stats"><span>${fmtSize(t.bytes)} / ${fmtSize(t.total)}</span><span>${t.done}/${t.count} files</span>${t.active && t.speed ? `<span>⚡ ${fmtSpeed(t.speed)}</span>` : ''}${eta ? `<span>${eta}</span>` : ''}${t.error ? `<span style="color:var(--red)">${esc(t.error)}</span>` : ''}${t.active && t.current ? `<span class="faint">${esc(t.current)}</span>` : ''}</div>` : t.error ? `<div class="stats"><span style="color:var(--red)">${esc(t.error)}</span></div>` : ''}
  </div>`;
}

const transfers = {
  mount: () => `<div class="head"><div><h1>Transfers</h1><p class="sub">Live progress for everything flying around</p></div><button class="btn sm ghost" data-act="clear-finished">${I('trash')}Clear finished</button></div><div id="tr-list"></div>`,
  update() {
    const list = S.transfers;
    $('#tr-list').innerHTML = list.length ? list.map(transferCard).join('') : emptyState('Nothing in the air', 'Transfers show up here while they happen.');
  },
};

function emptyState(title, text) {
  return `<div class="empty"><img src="/static/mascot.jpg" alt=""><b>${title}</b>${text}</div>`;
}

// ---------- history ----------
async function loadHistory() {
  try {
    const r = await api('history');
    H = { rev: r.rev, items: r.items };
    if (ui.page === 'history') history.update();
  } catch { /* offline */ }
}

const history = {
  mount: () => `<div class="head"><div><h1>History</h1><p class="sub">Everything you sent and received</p></div>
      <div class="row"><button class="btn sm" data-act="open-folder">${I('folder')}${S.me.platform === 'android' ? 'Downloads' : 'Received folder'}</button><button class="btn sm ghost danger" data-act="history-clear">${I('trash')}Clear</button></div></div>
    <div class="row" style="margin-bottom:6px"><div class="seg" id="hist-seg">${['all', 'in', 'out'].map((f) => `<button data-act="hist-filter" data-f="${f}" class="${ui.histFilter === f ? 'on' : ''}">${{ all: 'All', in: 'Received', out: 'Sent' }[f]}</button>`).join('')}</div>
    <input class="input grow" id="hist-q" placeholder="Search files, devices, messages…" style="max-width:340px" value="${esc(ui.histQuery)}"></div>
    <div id="hist-list"></div>`,
  after() {
    $('#hist-q').addEventListener('input', (e) => { ui.histQuery = e.target.value; history.update(); });
    if (S.historyRev !== H.rev) loadHistory();
  },
  update() {
    $$('#hist-seg button').forEach((b) => b.classList.toggle('on', b.dataset.f === ui.histFilter));
    const q = ui.histQuery.trim().toLowerCase();
    const items = H.items.filter((h) => (ui.histFilter === 'all' || h.dir === ui.histFilter)
      && (!q || h.peer.name.toLowerCase().includes(q) || (h.text || '').toLowerCase().includes(q) || h.items.some((i) => i.name.toLowerCase().includes(q))));
    if (!items.length) { $('#hist-list').innerHTML = emptyState(H.items.length ? 'No matches' : 'No history yet', H.items.length ? 'Try a different search.' : 'Send or receive something and it lands here.'); return; }
    let html = '';
    let lastDay = '';
    for (const h of items.slice(0, 300)) {
      const day = dayLabel(h.ts);
      if (day !== lastDay) { html += `<div class="day">${day}</div>`; lastDay = day; }
      const n = h.items.length;
      const verb = h.dir === 'in' ? 'Received' : 'Sent';
      const what = n ? `${n === 1 ? esc(h.items[0].name) : n + ' files'}` : 'a message';
      const exp = ui.expanded.has(h.id);
      const shown = exp ? h.items : h.items.slice(0, 3);
      const files = shown.map((it, idx) => {
        const [k, c] = fileKind(it.name);
        const canOpen = h.dir === 'in' && it.loc;
        return `<div class="file"><span class="fi" style="--fc:${c}">${I(k)}</span><span class="fn" title="${esc(it.rel || it.name)}">${esc(it.name)}</span><span class="fs">${fmtSize(it.size)}</span>${canOpen ? `<button class="icon-btn sm" data-act="hist-open" data-id="${h.id}" data-idx="${idx}" aria-label="Open">${I('open')}</button>${S.me.platform !== 'android' ? `<button class="icon-btn sm" data-act="hist-reveal" data-id="${h.id}" data-idx="${idx}" aria-label="Show in folder">${I('folder')}</button>` : ''}` : ''}</div>`;
      }).join('');
      html += `<div class="hist">
        <div class="av" style="--c:${esc(h.peer.color)}">${esc(h.peer.avatar)}</div>
        <div style="min-width:0">
          <div class="t1">${verb} <b>${what}</b> ${h.dir === 'in' ? 'from' : 'to'} <b>${esc(h.peer.name)}</b></div>
          <div class="t2"><span>${fmtTime(h.ts)}</span>${h.total ? `<span>· ${fmtSize(h.total)}</span>` : ''}${h.status !== 'done' ? statusPill(h) : ''}${h.error ? `<span class="faint">${esc(h.error)}</span>` : ''}</div>
          ${h.text ? `<div class="msg">${esc(h.text)}</div><div class="row" style="margin-top:6px"><button class="btn sm ghost" data-act="copy" data-text="${esc(h.text)}">${I('copy')}Copy</button>${isUrl(h.text) ? `<button class="btn sm ghost" data-act="open-url" data-url="${esc(h.text.trim())}">${I('open')}Open link</button>` : ''}</div>` : ''}
          ${n ? `<div class="files">${files}${n > 3 ? `<button class="more" data-act="hist-more" data-id="${h.id}">${exp ? 'Show less' : `Show all ${n} files`}</button>` : ''}</div>` : ''}
        </div>
        <button class="icon-btn sm" data-act="hist-remove" data-id="${h.id}" aria-label="Remove">${I('x')}</button>
      </div>`;
    }
    $('#hist-list').innerHTML = html;
  },
};

// ---------- connect ----------
function drawQR(canvas, text) {
  const qr = qrcode(0, 'Q');
  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const px = 8;
  canvas.width = canvas.height = n * px;
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, n * px, n * px);
  grad.addColorStop(0, '#e2468f');
  grad.addColorStop(1, '#7c4dff');
  g.fillStyle = grad;
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || finder(r, c)) continue;
      g.beginPath();
      g.arc(c * px + px / 2, r * px + px / 2, px * 0.42, 0, Math.PI * 2);
      g.fill();
    }
  }
  const eye = (r, c) => {
    g.lineWidth = px;
    g.strokeStyle = grad;
    g.beginPath(); g.roundRect(c * px + px / 2, r * px + px / 2, px * 6, px * 6, px * 1.8); g.stroke();
    g.beginPath(); g.roundRect((c + 2) * px, (r + 2) * px, px * 3, px * 3, px); g.fill();
  };
  eye(0, 0); eye(0, n - 7); eye(n - 7, 0);
}

const connect = {
  mount: () => {
    const c = S.caps;
    return `<div class="head"><div><h1>Connect</h1><p class="sub">No Wi-Fi router? No internet? No problem.</p></div></div>
    <div class="grid2">
      <section class="card glow">
        <h3>Scan me</h3>
        <div class="qr-box"><div class="qr"><canvas id="qr-me"></canvas></div>
          <div class="grow" style="min-width:180px"><p class="muted" style="margin:0 0 10px">Scan with BubbleDrop on your phone to connect instantly. Scan with a normal camera to open <b>Web Share</b> when it's on.</p>
          <div id="my-addrs" class="row"></div></div></div>
      </section>
      <section class="card">
        <h3>Connect by address</h3>
        <form id="conn-form" class="row"><input class="input grow" id="conn-addr" placeholder="e.g. 192.168.43.1" inputmode="decimal" autocomplete="off"><button class="btn primary" type="submit">${I('link')}Connect</button></form>
        <div class="row" style="margin-top:12px">
          <button class="btn" data-act="scan">${I('search')}Scan network</button>
          ${c.scanQr ? `<button class="btn" data-act="scan-qr">${I('scan')}Scan QR code</button>` : ''}
        </div>
        <ul class="steps"><li>Both devices must be on the <b>same Wi-Fi</b> or one device's <b>hotspot</b>.</li><li>Transfers stay on your local network: zero mobile data.</li></ul>
      </section>
      ${c.hotspot ? `<section class="card" id="hotspot-card"></section>` : ''}
      ${c.joinWifi ? `<section class="card">
        <h3>${I('wifi')} Join a phone's hotspot</h3>
        <p class="muted" style="margin-top:0">On your Android phone tap <b>Connect → Start hotspot</b>, then type what it shows here.</p>
        <form id="join-form"><label class="field"><span>Network name (SSID)</span><input class="input" id="join-ssid" autocomplete="off"></label>
        <label class="field"><span>Password</span><input class="input" id="join-pass" autocomplete="off"></label>
        <button class="btn primary" type="submit">${I('wifi')}Join hotspot</button></form>
      </section>` : ''}
      <section class="card" id="web-card"></section>
    </div>`;
  },
  after() {
    $('#conn-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#conn-addr').value.trim();
      if (v) act('connect', { address: v }).then(() => go('nearby')).catch(() => {});
    });
    const jf = $('#join-form');
    if (jf) jf.addEventListener('submit', (e) => {
      e.preventDefault();
      const ssid = $('#join-ssid').value.trim();
      if (!ssid) return toast('Type the hotspot name first', 'error');
      toast('Joining ' + ssid + '…');
      act('join-wifi', { ssid, password: $('#join-pass').value }).then((r) => toast(r.message || 'Joined!', 'success')).catch(() => {});
    });
    ui.qrText = '';
  },
  update() {
    const url = S.me.ips.length ? `http://${S.me.ips[0]}:${S.me.port}/` : '';
    if (url !== ui.qrText) { ui.qrText = url; if (url) drawQR($('#qr-me'), url); }
    $('#my-addrs').innerHTML = S.me.ips.length ? S.me.ips.map((ip) => `<span class="addr">${esc(ip)}<span class="faint">:${S.me.port}</span><button class="icon-btn sm" style="width:26px;height:26px" data-act="copy" data-text="${esc(ip)}" aria-label="Copy">${I('copy')}</button></span>`).join('') : '<span class="muted">Not connected to any network yet.</span>';
    const w = S.webshare;
    $('#web-card').innerHTML = `<div class="row"><h3 class="grow" style="margin:0">${I('globe')} Web Share</h3><label class="switch"><input type="checkbox" data-act="webshare" ${w.enabled ? 'checked' : ''}><i></i></label></div>
      <p class="muted">Share with <b>any</b> phone or computer through its browser, no app needed. They can download what's in your bubble and upload files to you.</p>
      ${w.enabled ? `<div class="kv" style="margin-bottom:12px"><span>Open</span><b>${w.urls.map(esc).join('<br>') || '—'}</b><span>PIN</span><div class="pin">${w.pin.split('').map((d) => `<span>${d}</span>`).join('')}</div></div>
      <p class="faint" style="font-size:13px;margin:0">Tip: they can also just scan the QR code above with their camera.</p>` : ''}`;
    const hc = $('#hotspot-card');
    if (hc) {
      const h = S.hotspot || {};
      hc.innerHTML = `<h3>${I('wifi')} No Wi-Fi? Start a hotspot</h3>
        <p class="muted" style="margin-top:0">Creates a private Wi-Fi just for sharing. It never uses your mobile data.</p>
        ${h.active ? `<div class="qr-box"><div class="qr" style="width:150px;height:150px"><canvas id="qr-wifi"></canvas></div><div class="kv grow"><span>Name</span><b>${esc(h.ssid)}</b><span>Password</span><b>${esc(h.password)}</b></div></div>
          <ul class="steps"><li>Other phones: scan this code with the camera to join.</li><li>PC: BubbleDrop → Connect → <b>Join a phone's hotspot</b>.</li></ul>
          <button class="btn danger" data-act="hotspot" data-on="0" style="margin-top:10px">${I('power')}Stop hotspot</button>`
          : `<button class="btn primary" data-act="hotspot" data-on="1" ${h.starting ? 'disabled' : ''}>${I('wifi')}${h.starting ? 'Starting…' : 'Start hotspot'}</button>${h.error ? `<p style="color:var(--red)">${esc(h.error)}</p>` : ''}`}`;
      const cw = $('#qr-wifi');
      if (cw) drawQR(cw, `WIFI:T:WPA;S:${h.ssid.replace(/([\\;,:"])/g, '\\$1')};P:${h.password.replace(/([\\;,:"])/g, '\\$1')};;`);
    }
  },
};

// ---------- settings ----------
const AVATARS = ['🍓', '🫧', '🦄', '🐱', '🍒', '🌸', '🐰', '🍭', '🎀', '🐼', '🦊', '🍑', '🐸', '🌈', '⭐', '🍩', '🐙', '👾', '🎧', '🚀', '🌙', '🧸'];
const COLORS = ['#ff6fae', '#b28dff', '#6fd3ff', '#7ef0c1', '#ffb86b', '#ff8080', '#f7d154', '#9aa7ff'];

function toggleRow(key, title, sub) {
  return `<div class="setting"><div class="txt"><b>${title}</b><small>${sub}</small></div><label class="switch"><input type="checkbox" data-act="toggle" data-key="${key}" ${S.settings[key] ? 'checked' : ''}><i></i></label></div>`;
}

const settings = {
  mount: () => {
    const s = S.settings;
    const c = S.caps;
    const trusted = Object.entries(s.trusted || {});
    return `<div class="head"><div><h1>Settings</h1><p class="sub">Make your bubble yours</p></div></div>
    <div class="grid2">
      <section class="card">
        <h3>Your profile</h3>
        <div class="row" style="margin-bottom:16px"><div class="av lg" id="set-av" style="--c:${esc(s.color)}">${esc(s.avatar)}</div>
          <label class="field grow" style="margin:0"><span>Name nearby devices see</span><input class="input" id="set-name" maxlength="40" value="${esc(s.name)}"></label></div>
        <label class="field"><span>Avatar</span></label><div class="emoji-grid" style="margin-top:-6px">${AVATARS.map((a) => `<button data-act="avatar" data-v="${a}" class="${a === s.avatar ? 'on' : ''}">${a}</button>`).join('')}</div>
        <label class="field" style="margin-top:16px"><span>Bubble colour</span></label><div class="swatches" style="margin-top:-6px">${COLORS.map((col) => `<button data-act="color" data-v="${col}" style="--c:${col}" class="${col === s.color ? 'on' : ''}" aria-label="${col}"></button>`).join('')}</div>
      </section>
      <section class="card">
        <h3>Receiving</h3>
        <div class="setting"><div class="txt"><b>Save files to</b><small style="word-break:break-all">${esc(c.chooseSaveDir ? s.saveDir : 'Download / BubbleDrop')}</small></div>
          ${c.chooseSaveDir ? `<button class="btn sm" data-act="choose-save-dir">Change</button>` : ''}<button class="btn sm ghost" data-act="open-folder">${I('folder')}Open</button></div>
        ${toggleRow('autoAcceptTrusted', 'Auto-accept trusted devices', 'Devices marked 💗 skip the "Accept?" question')}
        ${toggleRow('acceptAll', 'Accept everything automatically', 'Handy at home. Anyone nearby can then drop files on you')}
        ${trusted.length ? `<div class="setting" style="display:block"><b>Trusted devices</b>${trusted.map(([id, name]) => `<div class="trusted-row"><span>💗</span><span class="grow">${esc(name)}</span><button class="btn sm ghost" data-act="untrust" data-id="${esc(id)}">Remove</button></div>`).join('')}</div>` : ''}
      </section>
      <section class="card">
        <h3>Look & feel</h3>
        <div class="setting"><div class="txt"><b>Theme</b><small>Dark bubblegum or light candy</small></div><div class="seg">${['dark', 'light', 'auto'].map((t) => `<button data-act="theme" data-v="${t}" class="${s.theme === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div>
        ${toggleRow('bubbles', 'Floating bubbles', 'The little bubbles in the background')}
        ${toggleRow('notifications', 'Notifications', 'Get pinged when something arrives')}
        ${c.tray ? toggleRow('minimizeToTray', 'Keep running in the tray', 'Closing the window keeps you visible to nearby devices') : ''}
        <div class="setting"><div class="txt"><b>${S.me.platform === 'android' ? 'Stop BubbleDrop' : 'Quit BubbleDrop'}</b><small>You won't be visible until you open it again</small></div><button class="btn sm danger" data-act="quit">${I('power')}${S.me.platform === 'android' ? 'Stop' : 'Quit'}</button></div>
      </section>
      <section class="card glow">
        <div class="signature"><img src="/static/mascot.jpg" alt="BubbleDrop mascot"><div><div class="sig">Bubble<span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">Drop</span></div>
        <div class="muted">v${esc(S.me.version)} · pop it, drop it 💗</div><p class="faint" style="font-size:13px;margin:8px 0 0">Fast local sharing between Windows and Android. Works over Wi-Fi or hotspot with no internet and no mobile data.</p>
        <div style="margin-top:10px;font-size:14px">Designed by <span class="sig-name">kitty_no_sushie</span> 🍣🐱</div></div></div>
      </section>
    </div>`;
  },
  after() {
    const inp = $('#set-name');
    const save = () => { if (inp.value.trim() && inp.value.trim() !== S.settings.name) act('settings', { name: inp.value.trim() }, 'Name saved'); };
    inp.addEventListener('change', save);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  },
  update() {
    const s = S.settings;
    const av = $('#set-av');
    av.textContent = s.avatar;
    av.style.setProperty('--c', s.color);
    $$('.emoji-grid button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.avatar));
    $$('.swatches button').forEach((b) => b.classList.toggle('on', b.dataset.v === s.color));
    $$('[data-act="theme"]').forEach((b) => b.classList.toggle('on', b.dataset.v === s.theme));
  },
};

const PAGES = { nearby, transfers, history, connect, settings };

// ---------- modals ----------
const modals = [];
function openModal(html, opts = {}) {
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="sheet ${opts.cls || ''}">${opts.noClose ? '' : `<button class="icon-btn sm x" data-act="modal-close" aria-label="Close">${I('x')}</button>`}${html}</div>`;
  m.addEventListener('mousedown', (e) => { if (e.target === m && !opts.noClose) closeModal(m); });
  m._opts = opts;
  $('#modal-root').appendChild(m);
  modals.push(m);
  return m;
}
function closeModal(m = modals[modals.length - 1]) {
  if (!m) return;
  const i = modals.indexOf(m);
  if (i >= 0) modals.splice(i, 1);
  if (m._opts.onClose) m._opts.onClose();
  m.classList.add('closing');
  setTimeout(() => m.remove(), 180);
}
function closeAllModals(keepOffers) {
  for (const m of [...modals]) if (!(keepOffers && m._opts.offer)) closeModal(m);
}

function handleOffers() {
  const pend = S.incoming;
  const cur = modals.find((m) => m._opts.offer);
  if (cur && !pend.some((p) => p.rid === cur._opts.offer)) closeModal(cur);
  if (!pend.length || modals.some((m) => m._opts.offer)) return;
  const p = pend[0];
  const left = Math.max(1, 90 - (Date.now() - (p.ts || Date.now())) / 1000);
  const files = p.items.slice(0, 8).map((it) => { const [k, c] = fileKind(it.name); return `<div class="file"><span class="fi" style="--fc:${c}">${I(k)}</span><span class="fn" title="${esc(it.rel)}">${esc(it.rel || it.name)}</span><span class="fs">${fmtSize(it.size)}</span></div>`; }).join('');
  const m = openModal(`
    <div class="offer-top"><div class="av lg" style="--c:${esc(p.from.color)}">${esc(p.from.avatar)}</div>
      <h2 style="margin:6px 0 0">${esc(p.from.name)}</h2>
      <div class="muted">wants to send you <b style="color:var(--text)">${p.count === 1 ? esc(p.items[0].name) : p.count + ' files'}</b> · ${fmtSize(p.total)}</div></div>
    <div class="offer-files">${files}${p.count > 8 ? `<div class="faint" style="text-align:center;font-size:13px">and ${p.count - 8} more…</div>` : ''}</div>
    <label class="check"><input type="checkbox" id="offer-trust"> Always accept from ${esc(p.from.name)} 💗</label>
    <div class="timer"><i style="animation-duration:${left}s"></i></div>
    <div class="sheet-actions"><button class="btn" data-act="offer" data-ok="0">Decline</button><button class="btn primary" data-act="offer" data-ok="1">${I('down')}Accept</button></div>`, { offer: p.rid, noClose: true });
  m._rid = p.rid;
  if (window.bd && window.bd.attention) window.bd.attention();
}

function showText(from, text) {
  openModal(`<div class="offer-top"><div class="av lg" style="--c:${esc(from.color)}">${esc(from.avatar)}</div><h2 style="margin:6px 0 0">${esc(from.name)}</h2><div class="muted">sent you a message</div></div>
    <div class="msg">${esc(text)}</div>
    <div class="sheet-actions"><button class="btn" data-act="copy" data-text="${esc(text)}">${I('copy')}Copy</button>${isUrl(text) ? `<button class="btn" data-act="open-url" data-url="${esc(text.trim())}">${I('open')}Open link</button>` : ''}<button class="btn primary" data-act="modal-close">Lovely 💗</button></div>`);
}

function openComposer(deviceId, initial = '') {
  if (!S.devices.length) return toast('No devices nearby yet', 'error');
  let target = deviceId || (S.devices.length === 1 ? S.devices[0].id : null);
  const m = openModal(`<h2>Send a message</h2><p class="muted" style="margin-top:0">Notes, links, addresses, passwords for the Wi-Fi… anything.</p>
    <textarea class="input" id="cmp-text" placeholder="Type or paste here…"></textarea>
    <div class="row" style="margin:10px 0 14px"><button class="btn sm ghost" id="cmp-paste">${I('paste')}Paste</button></div>
    <div class="muted" style="font-size:13px;margin-bottom:8px">Send to</div>
    <div class="dev-pick" id="cmp-devs"></div>
    <div class="sheet-actions"><button class="btn primary" id="cmp-send">${I('send')}Send</button></div>`);
  const draw = () => {
    $('#cmp-devs', m).innerHTML = S.devices.map((d) => `<button data-id="${esc(d.id)}" class="${d.id === target ? 'on' : ''}"><span class="av sm" style="--c:${esc(d.color)}">${esc(d.avatar)}</span>${esc(d.name)}</button>`).join('');
    $('#cmp-send', m).disabled = !target;
  };
  draw();
  $('#cmp-devs', m).addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { target = b.dataset.id; draw(); } });
  $('#cmp-paste', m).addEventListener('click', async () => {
    try { $('#cmp-text', m).value += await navigator.clipboard.readText(); } catch { toast('Long-press the box to paste', 'info'); }
  });
  $('#cmp-send', m).addEventListener('click', () => {
    const text = $('#cmp-text', m).value;
    if (!text.trim()) return toast('Type something first', 'error');
    act('send-text', { deviceId: target, text }).then(() => { closeModal(m); toast('Message sent 💌', 'success'); }).catch(() => {});
  });
  $('#cmp-text', m).value = initial;
  setTimeout(() => $('#cmp-text', m).focus(), 80);
}

function openDevice(id) {
  const d = S.devices.find((x) => x.id === id);
  if (!d) return;
  const c = S.caps;
  const pickThenSend = (kind) => async () => {
    closeModal(m);
    const r = await act('pick', { kind });
    if (r.added) act('send', { deviceId: id }).then(() => toast(`Sending to ${d.name}…`)).catch(() => {});
  };
  const m = openModal(`<div class="offer-top"><div class="av lg" style="--c:${esc(d.color)}">${esc(d.avatar)}</div><h2 style="margin:6px 0 0">${esc(d.name)}</h2>
    <div class="muted">${esc(d.platform)} · ${esc(d.ip)}</div></div>
    <div class="tiles" style="margin-top:10px">
      <button class="tile" id="dv-files"><span class="ti">${I('file')}</span>Files</button>
      ${c.pickMedia ? `<button class="tile" id="dv-media"><span class="ti" style="--tc:linear-gradient(135deg,#6fd3ff,#8b9cff)">${I('image')}</span>Photos</button>` : ''}
      ${c.pickFolder ? `<button class="tile" id="dv-folder"><span class="ti" style="--tc:linear-gradient(135deg,#ffb86b,#ff7eb3)">${I('folder')}</span>Folder</button>` : ''}
      ${c.apps ? `<button class="tile" id="dv-apps"><span class="ti" style="--tc:linear-gradient(135deg,#7ef0c1,#4fc3f7)">${I('apps')}</span>Apps</button>` : ''}
      <button class="tile" id="dv-text"><span class="ti" style="--tc:linear-gradient(135deg,#b28dff,#ff6fae)">${I('chat')}</span>Text</button>
    </div>
    <label class="check"><input type="checkbox" id="dv-trust" ${d.trusted ? 'checked' : ''}> Trust ${esc(d.name)} (auto-accept their files) 💗</label>`);
  $('#dv-files', m).onclick = pickThenSend('files');
  if ($('#dv-media', m)) $('#dv-media', m).onclick = pickThenSend('media');
  if ($('#dv-folder', m)) $('#dv-folder', m).onclick = pickThenSend('folder');
  if ($('#dv-apps', m)) $('#dv-apps', m).onclick = () => { closeModal(m); openApps(id); };
  $('#dv-text', m).onclick = () => { closeModal(m); openComposer(id); };
  $('#dv-trust', m).onchange = (e) => act(e.target.checked ? 'trust' : 'untrust', { id: d.id, name: d.name });
}

async function openApps(sendTo) {
  const m = openModal(`<h2>Share apps</h2><input class="input" id="app-q" placeholder="Search apps…" style="margin:8px 0 12px"><div class="apps" id="app-grid"><div class="muted">Loading your apps…</div></div>
    <div class="sheet-actions"><button class="btn primary" id="app-add" disabled>Add</button></div>`, { cls: 'wide' });
  let apps = [];
  const chosen = new Set();
  try { apps = (await api('apps')).apps; } catch (e) { $('#app-grid', m).innerHTML = `<div class="muted">${esc(e.message)}</div>`; return; }
  const draw = () => {
    const q = $('#app-q', m).value.toLowerCase();
    $('#app-grid', m).innerHTML = apps.filter((a) => !q || a.label.toLowerCase().includes(q)).map((a) => `<button class="app-it ${chosen.has(a.pkg) ? 'on' : ''}" data-pkg="${esc(a.pkg)}"><img loading="lazy" src="/local/appicon?pkg=${encodeURIComponent(a.pkg)}&t=${encodeURIComponent(TOKEN)}" alt=""><span>${esc(a.label)}</span><small>${fmtSize(a.size)}</small></button>`).join('');
    const b = $('#app-add', m);
    b.disabled = !chosen.size;
    b.textContent = chosen.size ? `${sendTo ? 'Send' : 'Add'} ${chosen.size} app${chosen.size > 1 ? 's' : ''}` : 'Pick some apps';
  };
  draw();
  $('#app-q', m).addEventListener('input', draw);
  $('#app-grid', m).addEventListener('click', (e) => { const b = e.target.closest('.app-it'); if (!b) return; chosen.has(b.dataset.pkg) ? chosen.delete(b.dataset.pkg) : chosen.add(b.dataset.pkg); draw(); });
  $('#app-add', m).addEventListener('click', async () => {
    await act('pick-apps', { pkgs: [...chosen] });
    closeModal(m);
    if (sendTo) act('send', { deviceId: sendTo }).catch(() => {});
  });
}

function onboarding() {
  try { if (localStorage.getItem('bd-onboarded')) return; } catch { return; }
  const s = S.settings;
  const m = openModal(`<div class="offer-top"><img src="/static/mascot.jpg" alt="" style="width:130px;height:130px;border-radius:50%;object-fit:cover;box-shadow:0 12px 40px #ff6fae66">
      <h2 style="margin:10px 0 0">Hi, welcome to BubbleDrop! 💗</h2><div class="muted">Send anything between your PC and phone. No cables, no internet.</div></div>
    <label class="field"><span>What should nearby devices call you?</span><input class="input" id="ob-name" maxlength="40" value="${esc(s.name)}"></label>
    <div class="emoji-grid" id="ob-av">${AVATARS.slice(0, 12).map((a) => `<button data-v="${a}" class="${a === s.avatar ? 'on' : ''}">${a}</button>`).join('')}</div>
    <div class="sheet-actions"><span class="faint grow" style="font-size:12px">a <span class="sig-name">kitty_no_sushie</span> creation</span><button class="btn primary" id="ob-go">Let's go ✨</button></div>`, { noClose: true });
  let av = s.avatar;
  $('#ob-av', m).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; av = b.dataset.v; $$('#ob-av button', m).forEach((x) => x.classList.toggle('on', x === b)); });
  $('#ob-go', m).addEventListener('click', () => {
    try { localStorage.setItem('bd-onboarded', '1'); } catch { /* ignore */ }
    act('settings', { name: $('#ob-name', m).value.trim() || s.name, avatar: av });
    closeModal(m);
    burst(innerWidth / 2, innerHeight / 2, 18);
  });
}

// ---------- toasts + fx ----------
function toast(msg, kind = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.innerHTML = `<span>${kind === 'success' ? '✨' : kind === 'error' ? '😵' : '🫧'}</span><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(t);
  while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, kind === 'error' ? 4200 : 2800);
}

function burst(x, y, n = 12) {
  const cols = ['#ff6fae', '#b28dff', '#6fd3ff', '#7ef0c1', '#ffcf6b'];
  for (let i = 0; i < n; i++) {
    const b = document.createElement('i');
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const d = 60 + Math.random() * 90;
    const s = 10 + Math.random() * 18;
    b.className = 'pop';
    b.style.cssText = `left:${x}px;top:${y}px;width:${s}px;height:${s}px;--c:${cols[i % cols.length]};--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d}px`;
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 950);
  }
}

function celebrate() {
  for (const t of S.transfers) {
    const prev = ui.prevStatus.get(t.sid);
    if (prev && prev !== t.status && t.status === 'done' && t.count) {
      const el = document.querySelector(`.dev[data-id="${CSS.escape(t.peer.id)}"] .bub`);
      const r = el ? el.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
      burst(r.left + r.width / 2, r.top + r.height / 2, 16);
    }
    ui.prevStatus.set(t.sid, t.status);
  }
}

function makeBubbles() {
  const box = $('#bubbles');
  for (let i = 0; i < 16; i++) {
    const s = document.createElement('span');
    const size = 10 + Math.random() * 46;
    s.style.cssText = `left:${Math.random() * 100}%;width:${size}px;height:${size}px;--dx:${(Math.random() * 80 - 40).toFixed(0)}px;animation-duration:${14 + Math.random() * 18}s;animation-delay:${-Math.random() * 30}s`;
    box.appendChild(s);
  }
}

// ---------- events ----------
const ACTIONS = {
  go: (d) => go(d.page),
  scan: () => act('scan').then(() => toast('Scanning your network…')).catch(() => {}),
  pick: (d) => {
    if (d.kind === 'text') return openComposer();
    if (d.kind === 'apps') return openApps();
    act('pick', { kind: d.kind }).then((r) => { if (r.added) toast(`Added ${r.added} item${r.added > 1 ? 's' : ''} 🫧`, 'success'); }).catch(() => {});
  },
  unselect: (d) => act('unselect', { id: d.id }),
  'clear-sel': () => act('clear-selection'),
  dev: (d, el) => {
    if (S.selection.count) {
      const dev = S.devices.find((x) => x.id === d.id);
      act('send', { deviceId: d.id }).then(() => {
        toast(`Sending to ${dev ? dev.name : 'device'}…`);
        const r = el.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + 35, 10);
      }).catch(() => {});
    } else openDevice(d.id);
  },
  cancel: (d) => act('cancel', { sid: d.sid }),
  retry: (d) => act('retry', { sid: d.sid }),
  dismiss: (d) => act('dismiss', { sid: d.sid }),
  'clear-finished': () => act('clear-finished'),
  'hist-filter': (d) => { ui.histFilter = d.f; history.update(); },
  'hist-open': (d) => act('open', { id: d.id, idx: +d.idx }),
  'hist-reveal': (d) => act('open', { id: d.id, idx: +d.idx, reveal: true }),
  'hist-remove': (d) => act('history-remove', { id: d.id }),
  'hist-more': (d) => { ui.expanded.has(d.id) ? ui.expanded.delete(d.id) : ui.expanded.add(d.id); history.update(); },
  'history-clear': () => { if (confirm('Clear all history? Your files stay where they are.')) act('history-clear'); },
  'open-folder': () => act('open-folder'),
  copy: (d) => copyText(d.text),
  'open-url': (d) => { if (window.bd && window.bd.openExternal) window.bd.openExternal(d.url); else act('open-url', { url: d.url }).catch(() => window.open(d.url, '_blank')); },
  webshare: (_d, el) => act('webshare', { enabled: el.checked }).then(() => el.checked && toast('Web Share is on. Share the link and PIN', 'success')),
  'scan-qr': async () => {
    const r = await act('scan-qr');
    if (!r.text) return;
    if (/^WIFI:/i.test(r.text)) return toast('That is a Wi-Fi code. Join it from your phone settings or camera app.', 'info');
    act('connect', { address: r.text }).then(() => go('nearby')).catch(() => {});
  },
  hotspot: (d) => act('hotspot', { on: d.on === '1' }).catch(() => {}),
  toggle: (d, el) => act('settings', { [d.key]: el.checked }),
  theme: (d) => act('settings', { theme: d.v }),
  avatar: (d) => act('settings', { avatar: d.v }),
  color: (d) => act('settings', { color: d.v }),
  untrust: (d) => act('untrust', { id: d.id }).then(() => { ui.mounted = null; update(); }),
  'choose-save-dir': () => act('choose-save-dir').then(() => { ui.mounted = null; update(); }),
  quit: () => { if (confirm('Stop BubbleDrop? Nearby devices will not see you until you open it again.')) api('quit').catch(() => {}); },
  'modal-close': () => closeModal(),
  offer: (d) => {
    const m = modals.find((x) => x._opts.offer);
    if (!m) return;
    const trust = $('#offer-trust', m).checked;
    api('respond', { rid: m._rid, accept: d.ok === '1', trust }).catch(() => {});
    closeModal(m);
    if (d.ok === '1') { toast('Catching the bubble…'); go('transfers'); }
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.tagName === 'INPUT' && el.dataset.act && ACTIONS[el.dataset.act]) ACTIONS[el.dataset.act](el.dataset, el);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modals.length && !modals[modals.length - 1]._opts.noClose) closeModal(); });

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { await api('copy', { text }).catch(() => {}); }
  toast('Copied to clipboard', 'success');
}

// Android back button: returns true if handled.
window.__bdBack = () => {
  const top = modals[modals.length - 1];
  if (top && !top._opts.noClose) { closeModal(top); return true; }
  if (ui.page !== 'nearby') { go('nearby'); return true; }
  return false;
};
// Android: called after a share-sheet intent adds files.
window.__bdShared = () => { go('nearby'); toast('Ready! Tap a device to send 💨', 'success'); };
// Android: text shared from another app opens the composer.
window.__bdSharedText = (text) => {
  const t = setInterval(() => {
    if (!S) return;
    clearInterval(t);
    go('nearby');
    if (S.devices.length) openComposer(null, text);
    else { copyText(text); toast('No device nearby yet. Text copied, paste it later', 'info'); }
  }, 100);
};

// ---------- drag & drop (desktop) ----------
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
document.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !window.bd) return; dragDepth++; $('#drop-overlay').classList.add('on'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').classList.remove('on'); } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.remove('on');
  if (!window.bd || !window.bd.pathsFor) return;
  const paths = window.bd.pathsFor([...e.dataTransfer.files]).filter(Boolean);
  if (!paths.length) return;
  act('add-paths', { paths }).then((r) => { toast(`Added ${r.added} item${r.added === 1 ? '' : 's'} 🫧`, 'success'); burst(e.clientX, e.clientY, 14); if (ui.page !== 'nearby') go('nearby'); }).catch(() => {});
});

// ---------- boot ----------
if (window.bd && window.bd.electron) document.body.classList.add('is-electron');
$('.mhead [data-page="connect"]').innerHTML = I('qr');
makeBubbles();
connectEvents();
const firstPaint = setInterval(() => { if (S) { clearInterval(firstPaint); onboarding(); } }, 100);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S && applyTheme());
