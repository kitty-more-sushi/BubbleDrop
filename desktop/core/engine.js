'use strict';
// BubbleDrop engine: discovery, peer HTTP server, transfers, web share and the local UI API.
// Pure Node (no Electron imports) so it can run headless for tests. See ../../PROTOCOL.md.

const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const PROTO = 1;
const APP = 'BubbleDrop';
const VERSION = '1.0.0';
const DEFAULT_PORT = 47888;
const UDP_PORT = 47889;
const MCAST = '239.255.42.99';
const ANNOUNCE_MS = 2500;
const DEVICE_TTL = 9000;
const OFFER_WAIT = 90000;
const PARALLEL = 3;
const STALL_MS = 60000;
const HISTORY_MAX = 500;

const AVATARS = ['🍓', '🫧', '🦄', '🐱', '🍒', '🌸', '🐰', '🍭', '🎀', '🐼', '🦊', '🍑'];
const COLORS = ['#ff6fae', '#b28dff', '#6fd3ff', '#7ef0c1', '#ffb86b', '#ff8080'];

const newId = (n = 9) => crypto.randomBytes(n).toString('base64url');
const now = () => Date.now();
const pick = (arr) => arr[crypto.randomInt(arr.length)];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain', '.zip': 'application/zip',
  '.apk': 'application/vnd.android.package-archive',
};
const mimeOf = (name) => MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';

// ---------- names and paths ----------

function safeName(name) {
  let n = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (!n || n === '.' || n === '..') n = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = '_' + n;
  return n.slice(0, 180);
}

function safeRel(rel, name) {
  const parts = String(rel || name || '').split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..').map(safeName);
  return parts.length ? parts.slice(-12) : [safeName(name)];
}

// ---------- network helpers ----------

const ipToInt = (ip) => ip.split('.').reduce((a, o) => ((a << 8) >>> 0) + Number(o), 0) >>> 0;
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

function localIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const ip = ipToInt(a.address);
      const mask = ipToInt(a.netmask || '255.255.255.0');
      out.push({ name, address: a.address, netmask: a.netmask, prefix: mask.toString(2).replace(/0/g, '').length, broadcast: intToIp((ip | ~mask) >>> 0), network: (ip & mask) >>> 0 });
    }
  }
  // Real LANs first so the QR code / "my address" shows the useful one.
  const rank = (a) => (/^192\.168\./.test(a.address) ? 0 : /^10\./.test(a.address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3)
    + (/vethernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier/i.test(a.name) ? 10 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

function friendlyNetError(e) {
  const code = e && (e.code || '');
  if (code === 'ECONNREFUSED') return 'BubbleDrop is not open on that device';
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EADDRNOTAVAIL'].includes(code) || /timed out/i.test(e.message)) return 'Device not reachable. Are you on the same Wi-Fi or hotspot?';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'Connection lost';
  return e && e.message ? e.message : String(e);
}

function requestJson(method, host, port, p, body, { timeout = 8000, track } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host, port, method, path: p, agent: false,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
        const e = new Error((json && json.error) || `HTTP ${res.statusCode}`);
        e.status = res.statusCode;
        reject(e);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
    if (track) track(req);
    req.end(data || undefined);
  });
}

function readBody(req, limit = 4 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}

function sendJson(res, code, obj) {
  if (res.headersSent || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

function counter(onBytes) {
  return new Transform({ transform(chunk, _enc, cb) { onBytes(chunk.length); cb(null, chunk); } });
}

// ---------- engine ----------

class Engine extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir   where settings/history live
   * @param {string} o.webDir    the shared web UI folder
   * @param {string} [o.platform] 'windows' | 'linux' | 'mac'
   * @param {number} [o.port]
   * @param {boolean} [o.discovery] set false to disable UDP (tests)
   * @param {object} [o.hooks]   platform glue: pick, openPath, showInFolder, notify, copyText, action, caps, defaultSaveDir
   */
  constructor(o) {
    super();
    this.o = o;
    this.hooks = o.hooks || {};
    this.platform = o.platform || (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');
    this.token = newId(18);
    this.devices = new Map();
    this.selection = [];
    this.transfers = new Map(); // sid -> transfer (both directions)
    this.sessions = new Map(); // incoming sid -> receive session
    this.pending = new Map(); // rid -> pending incoming offer
    this.reserved = new Set();
    this.sse = new Set();
    this.web = { enabled: false, pin: '', cookies: new Set(), fails: new Map() };
    this.historyRev = 0;
    this._emitTimer = null;
  }

  // ----- lifecycle -----

  async start() {
    await fsp.mkdir(this.o.dataDir, { recursive: true });
    this.settingsFile = path.join(this.o.dataDir, 'settings.json');
    this.historyFile = path.join(this.o.dataDir, 'history.json');
    let s = {};
    try { s = JSON.parse(await fsp.readFile(this.settingsFile, 'utf8')); } catch { /* first run */ }
    this.settings = {
      id: s.id || crypto.randomUUID(),
      name: s.name || this.defaultName(),
      avatar: s.avatar || pick(AVATARS),
      color: s.color || pick(COLORS),
      theme: s.theme || 'dark',
      saveDir: s.saveDir || (this.hooks.defaultSaveDir ? this.hooks.defaultSaveDir() : path.join(os.homedir(), 'Downloads', APP)),
      autoAcceptTrusted: s.autoAcceptTrusted !== false,
      acceptAll: !!s.acceptAll,
      trusted: s.trusted || {},
      notifications: s.notifications !== false,
      minimizeToTray: s.minimizeToTray !== false,
      bubbles: s.bubbles !== false,
    };
    try { this.history = JSON.parse(await fsp.readFile(this.historyFile, 'utf8')); } catch { this.history = []; }
    if (!Array.isArray(this.history)) this.history = [];
    await this.saveSettings();
    await this.listen();
    if (this.o.discovery !== false) this.startDiscovery();
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  async stop() {
    clearInterval(this.ticker);
    clearInterval(this.announcer);
    if (this.udp) {
      try { this.announce('bye'); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 60));
      try { this.udp.close(); } catch { /* ignore */ }
    }
    for (const res of this.sse) res.end();
    for (const t of this.transfers.values()) if (t.abort) t.abort();
    await new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
    await this.flushHistory();
  }

  defaultName() {
    const user = (os.userInfo().username || '').replace(/[^\w .-]/g, '');
    const host = os.hostname().replace(/\.local$/, '');
    return user ? `${user[0].toUpperCase() + user.slice(1)}'s PC` : host;
  }

  async saveSettings() {
    await fsp.writeFile(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  saveHistorySoon() {
    this.historyRev++;
    clearTimeout(this._histTimer);
    this._histTimer = setTimeout(() => this.flushHistory(), 400);
    this.changed();
  }

  async flushHistory() {
    clearTimeout(this._histTimer);
    if (!this.historyFile) return;
    try { await fsp.writeFile(this.historyFile, JSON.stringify(this.history.slice(0, HISTORY_MAX))); } catch (e) { console.error('history save failed', e); }
  }

  info() {
    const s = this.settings;
    return { bd: PROTO, app: APP, version: VERSION, id: s.id, name: s.name, platform: this.platform, avatar: s.avatar, color: s.color, port: this.port };
  }

  // ----- state to UI -----

  snapshot() {
    const t = [...this.transfers.values()].sort((a, b) => b.created - a.created).slice(0, 40);
    return {
      me: { ...this.info(), ips: localIPv4s().map((a) => a.address) },
      caps: { dragDrop: false, pickFolder: true, pickMedia: false, apps: false, hotspot: false, joinWifi: false, scanQr: false, chooseSaveDir: false, tray: false, ...(this.hooks.caps || {}) },
      settings: { ...this.settings },
      devices: [...this.devices.values()].map((d) => ({ ...d, trusted: !!this.settings.trusted[d.id], busy: t.some((x) => x.peer.id === d.id && x.active) })).sort((a, b) => a.name.localeCompare(b.name)),
      selection: { items: this.selection.slice(0, 300).map(({ id, name, size, rel, kind, icon }) => ({ id, name, size, rel, kind, icon })), count: this.selection.length, total: this.selection.reduce((n, i) => n + i.size, 0) },
      transfers: t.map((x) => this.publicTransfer(x)),
      incoming: [...this.pending.values()].map(({ rid, from, items, total, text, ts }) => ({ rid, from, total, ts, count: items.length, items: items.slice(0, 60), text })),
      webshare: { enabled: this.web.enabled, pin: this.web.pin, urls: localIPv4s().map((a) => `http://${a.address}:${this.port}/`) },
      hotspot: this.hooks.hotspotState ? this.hooks.hotspotState() : null,
      historyRev: this.historyRev,
      scanning: !!this.scanning,
    };
  }

  publicTransfer(t) {
    return {
      sid: t.sid, dir: t.dir, peer: t.peer, status: t.status, active: t.active, error: t.error || '',
      total: t.total, bytes: t.bytes, count: t.items.length, done: t.items.filter((i) => i.state === 'done').length,
      current: t.current || '', speed: Math.round(t.speed || 0), text: t.text ? t.text.slice(0, 200) : '',
      names: t.items.slice(0, 4).map((i) => i.name), created: t.created, ended: t.ended || 0,
    };
  }

  changed() {
    if (this._emitTimer) return;
    this._emitTimer = setTimeout(() => {
      this._emitTimer = null;
      this.broadcast({ type: 'state', state: this.snapshot() });
    }, 120);
  }

  broadcast(ev) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.sse) res.write(line);
  }

  toast(msg, kind = 'info') {
    this.broadcast({ type: 'toast', msg, kind });
  }

  // ----- HTTP server -----

  async listen() {
    const base = this.o.port || DEFAULT_PORT;
    const ports = [base, ...Array.from({ length: 10 }, (_, i) => base + 2 + i)];
    for (const port of ports) {
      try {
        await new Promise((resolve, reject) => {
          const srv = http.createServer((req, res) => this.route(req, res));
          srv.keepAliveTimeout = 5000;
          srv.requestTimeout = 0; // big uploads
          srv.headersTimeout = 20000;
          srv.once('error', reject);
          srv.listen(port, '0.0.0.0', () => { srv.removeListener('error', reject); this.server = srv; resolve(); });
        });
        this.port = port;
        return;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error('No free port for BubbleDrop');
  }

  isLocal(req) {
    const ra = req.socket.remoteAddress || '';
    const host = String(req.headers.host || '').toLowerCase();
    return (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
  }

  async route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/v1/')) return await this.routePeer(req, res, p.slice(8), url.searchParams);
      if (p.startsWith('/local/')) {
        if (!this.isLocal(req)) return sendJson(res, 403, { error: 'forbidden' });
        const tok = req.headers['x-bd-token'] || url.searchParams.get('t');
        if (tok !== this.token) return sendJson(res, 401, { error: 'bad token' });
        return await this.routeLocal(req, res, p.slice(7), url.searchParams);
      }
      if (p === '/ui' || p === '/ui/' || p === '/ui/index.html') {
        if (!this.isLocal(req)) return sendJson(res, 403, { error: 'forbidden' });
        const html = (await fsp.readFile(path.join(this.o.webDir, 'index.html'), 'utf8')).replace('__BD_TOKEN__', this.token);
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (p.startsWith('/static/')) return await this.serveStatic(req, res, p.slice(8));
      if (p.startsWith('/web/')) return await this.routeWeb(req, res, p.slice(5), url.searchParams);
      if (p === '/' || p === '/index.html') return await this.serveStatic(req, res, 'share.html');
      if (p === '/favicon.ico') return await this.serveStatic(req, res, 'icon.png');
      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (!e.status) console.error(p, e);
      sendJson(res, e.status || 500, { error: e.message || 'error' });
    }
  }

  async serveStatic(req, res, rel) {
    const root = path.resolve(this.o.webDir);
    const file = path.resolve(root, decodeURIComponent(rel));
    if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
    let st;
    try { st = await fsp.stat(file); } catch { return sendJson(res, 404, { error: 'not found' }); }
    if (!st.isFile()) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': mimeOf(file), 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  // ----- peer API -----

  async routePeer(req, res, op, q) {
    if (op === 'info' && req.method === 'GET') return sendJson(res, 200, this.info());
    if (op === 'offer' && req.method === 'POST') return this.onOffer(req, res, await readJson(req));
    if (op === 'file' && req.method === 'PUT') return this.onFile(req, res, q);
    if (op === 'cancel' && req.method === 'POST') {
      const b = await readJson(req);
      const t = this.transfers.get(b.sid);
      if (!t || t.ctoken !== b.token) return sendJson(res, 403, { error: 'unknown transfer' });
      this.cancelTransfer(t, false, t.dir === 'in' ? 'Sender cancelled' : 'Receiver cancelled');
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'unknown call' });
  }

  peerFromOffer(req, from) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return {
      id: String(from.id || ip).slice(0, 64),
      name: String(from.name || 'Unknown').slice(0, 60),
      platform: String(from.platform || 'unknown').slice(0, 20),
      avatar: String(from.avatar || '📱').slice(0, 8),
      color: /^#[0-9a-f]{6}$/i.test(from.color) ? from.color : '#b28dff',
      ip, port: Number(from.port) || DEFAULT_PORT,
    };
  }

  async onOffer(req, res, b) {
    if (!b || !b.from) return sendJson(res, 400, { error: 'bad offer' });
    const peer = this.peerFromOffer(req, b.from);
    this.upsertDevice({ ...peer, source: 'offer' });
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100000).map((i) => ({
      fid: String(i.fid), name: safeName(i.name), rel: safeRel(i.rel, i.name).join('/'), size: Math.max(0, Number(i.size) || 0), mime: String(i.mime || ''),
    }));
    const text = typeof b.text === 'string' ? b.text.slice(0, 100000) : '';
    const total = items.reduce((n, i) => n + i.size, 0);

    if (!items.length) {
      if (!text) return sendJson(res, 400, { error: 'empty offer' });
      this.addHistory({ dir: 'in', peer, status: 'done', text, items: [], total: 0 });
      this.broadcast({ type: 'text', from: peer, text });
      this.notify('💬 Message from ' + peer.name, text.slice(0, 120));
      this.emit('text', peer, text);
      return sendJson(res, 200, { accept: true });
    }

    const auto = this.settings.acceptAll || (this.settings.autoAcceptTrusted && this.settings.trusted[peer.id]);
    let decision = { accept: true };
    if (!auto) {
      decision = await new Promise((resolve) => {
        const rid = newId();
        const p = { rid, from: peer, items, total, text, ts: now(), resolve: (d) => { clearTimeout(p.timer); this.pending.delete(rid); this.changed(); resolve(d); } };
        p.timer = setTimeout(() => p.resolve({ accept: false, reason: 'No answer' }), OFFER_WAIT);
        res.on('close', () => { if (!res.writableFinished && this.pending.has(rid)) p.resolve({ accept: false, reason: 'gone' }); });
        this.pending.set(rid, p);
        this.changed();
        this.broadcast({ type: 'offer', rid });
        const sz = fmtSize(total);
        this.notify(`${peer.avatar} ${peer.name} wants to send you ${items.length === 1 ? items[0].name : items.length + ' files'}`, `${sz} · open BubbleDrop to accept`, { rid });
        this.emit('offer', p);
      });
      if (decision.trust) { this.settings.trusted[peer.id] = peer.name; this.saveSettings(); }
    }
    if (!decision.accept) return sendJson(res, 200, { accept: false, reason: decision.reason || 'Declined' });

    const sid = newId();
    const token = newId(18);
    const dir = this.settings.saveDir;
    await fsp.mkdir(dir, { recursive: true });
    const t = {
      sid, dir: 'in', peer, ctoken: token, peerSid: String(b.sid || ''), peerToken: String(b.ctoken || ''),
      items: items.map((i) => ({ ...i, state: 'pending', loc: '' })), total, bytes: 0, status: 'transferring', active: true,
      created: now(), started: now(), lastActivity: now(), text, reqs: new Set(), saveDir: dir,
    };
    t.byFid = new Map(t.items.map((i) => [i.fid, i]));
    this.transfers.set(sid, t);
    this.changed();
    this.emit('busy', true);
    sendJson(res, 200, { accept: true, sid, token });
  }

  async reservePath(p) {
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const base = path.basename(p, ext);
    let cand = p;
    for (let i = 1; ; i++) {
      if (!this.reserved.has(cand.toLowerCase())) {
        try { await fsp.access(cand); } catch { break; }
      }
      cand = path.join(dir, `${base} (${i})${ext}`);
    }
    this.reserved.add(cand.toLowerCase());
    return cand;
  }

  async onFile(req, res, q) {
    const t = this.transfers.get(q.get('sid'));
    if (!t || t.dir !== 'in' || t.ctoken !== q.get('token')) return sendJson(res, 403, { error: 'bad session' });
    if (!t.active) return sendJson(res, 410, { error: 'cancelled' });
    const item = t.byFid.get(q.get('fid'));
    if (!item || item.state === 'done' || item.state === 'receiving') return sendJson(res, 409, { error: 'bad item' });
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len !== item.size) return sendJson(res, 400, { error: 'size mismatch' });

    const dest = await this.reservePath(path.join(t.saveDir, ...safeRel(item.rel, item.name)));
    const tmp = dest + '.bdpart';
    item.state = 'receiving';
    t.current = item.name;
    t.reqs.add(req);
    let got = 0;
    try {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(req, counter((n) => { got += n; t.bytes += n; t.lastActivity = now(); }), fs.createWriteStream(tmp, { highWaterMark: 4 << 20 }));
      if (got !== item.size) throw new Error('incomplete');
      await fsp.rename(tmp, dest);
      item.state = 'done';
      item.loc = dest;
      sendJson(res, 200, { ok: true });
    } catch (e) {
      item.state = 'failed';
      t.bytes -= got;
      fsp.unlink(tmp).catch(() => {});
      sendJson(res, t.active ? 500 : 410, { error: t.active ? 'write failed' : 'cancelled' });
    } finally {
      this.reserved.delete(dest.toLowerCase());
      t.reqs.delete(req);
      this.checkIncomingDone(t);
      this.changed();
    }
  }

  checkIncomingDone(t) {
    if (!t.active || t.items.some((i) => i.state === 'pending' || i.state === 'receiving')) return;
    const ok = t.items.filter((i) => i.state === 'done').length;
    this.finishTransfer(t, ok === t.items.length ? 'done' : ok ? 'partial' : 'failed', ok === t.items.length ? '' : `${t.items.length - ok} file(s) failed`);
  }

  finishTransfer(t, status, error = '') {
    if (!t.active) return;
    t.active = false;
    t.status = status;
    t.error = error;
    t.ended = now();
    t.speed = 0;
    t.current = '';
    if (t.abort) t.abort();
    const items = t.items.filter((i) => t.dir === 'out' || i.state === 'done').map((i) => ({ name: i.name, rel: i.rel, size: i.size, loc: i.loc || '' }));
    if (t.text || items.length || status !== 'cancelled') {
      this.addHistory({ dir: t.dir, peer: t.peer, status, items, total: items.reduce((n, i) => n + i.size, 0), text: t.text, error, saveDir: t.saveDir });
    }
    if (t.dir === 'in' && (status === 'done' || status === 'partial')) {
      const n = items.length;
      this.notify(`✨ Received ${n === 1 ? items[0].name : n + ' files'}`, `from ${t.peer.name} · ${fmtSize(items.reduce((a, i) => a + i.size, 0))}`, { reveal: items[0] && items[0].loc });
      this.toast(`Received ${n === 1 ? items[0].name : n + ' files'} from ${t.peer.name}`, 'success');
    } else if (t.dir === 'out' && status === 'done') {
      this.toast(`Sent to ${t.peer.name} 🎉`, 'success');
    }
    if (![...this.transfers.values()].some((x) => x.active)) this.emit('busy', false);
    this.changed();
  }

  cancelTransfer(t, tellPeer = true, why = 'Cancelled') {
    if (!t.active) return;
    const reqs = [...t.reqs];
    const kill = () => { for (const r of reqs) r.destroy(); };
    const dev = this.devices.get(t.peer.id) || t.peer;
    const body = t.dir === 'in' ? { sid: t.peerSid, token: t.peerToken } : t.remote ? { sid: t.remote.sid, token: t.remote.token } : null;
    t.cancelled = true;
    this.finishTransfer(t, 'cancelled', why);
    if (tellPeer && body && body.sid) {
      // Tell the other side first so it shows "cancelled", not "connection lost".
      requestJson('POST', dev.ip, dev.port, '/api/v1/cancel', body, { timeout: 1500 }).catch(() => {}).finally(kill);
    } else kill();
  }

  // ----- sending -----

  async send(deviceId, { items, text } = {}) {
    const dev = this.devices.get(deviceId);
    if (!dev) throw Object.assign(new Error('That device is gone. Try refreshing.'), { status: 404 });
    const list = (items || this.selection).map((i) => ({ ...i }));
    if (!list.length && !text) throw Object.assign(new Error('Pick something to send first'), { status: 400 });
    if (!items && !text) { this.selection = []; }
    const sid = newId();
    const t = {
      sid, dir: 'out', peer: { id: dev.id, name: dev.name, avatar: dev.avatar, color: dev.color, platform: dev.platform, ip: dev.ip, port: dev.port },
      ctoken: newId(18), items: list.map((i) => ({ ...i, fid: i.id, state: 'pending', loc: i.path || i.loc || '' })), text: text || '',
      total: list.reduce((n, i) => n + i.size, 0), bytes: 0, status: 'waiting', active: true, created: now(), reqs: new Set(),
    };
    this.transfers.set(sid, t);
    this.emit('busy', true);
    this.changed();
    this.runSend(t, dev).catch((e) => console.error('send', e));
    return t.sid;
  }

  async runSend(t, dev) {
    try {
      for (const i of t.items) {
        if (this.hooks.statItem) i.size = await this.hooks.statItem(i);
        else if (i.path) i.size = (await fsp.stat(i.path)).size;
      }
      t.total = t.items.reduce((n, i) => n + i.size, 0);
      const offer = {
        bd: PROTO, from: this.info(), sid: t.sid, ctoken: t.ctoken, text: t.text || undefined,
        items: t.items.map((i) => ({ fid: i.fid, name: i.name, rel: i.rel || i.name, size: i.size, mime: mimeOf(i.name) })),
      };
      const resp = await requestJson('POST', dev.ip, dev.port, '/api/v1/offer', offer, { timeout: OFFER_WAIT + 15000, track: (r) => t.reqs.add(r) });
      if (!t.active) return;
      if (!resp.accept) return this.finishTransfer(t, 'declined', resp.reason === 'gone' ? 'Cancelled' : resp.reason || 'Declined');
      if (!t.items.length) { t.items = []; return this.finishTransfer(t, 'done'); }
      t.remote = { sid: resp.sid, token: resp.token };
      t.status = 'transferring';
      t.started = now();
      this.changed();
      const queue = t.items.slice();
      const worker = async () => {
        while (t.active && queue.length) {
          const item = queue.shift();
          await this.uploadItem(t, dev, item);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker));
      if (t.active) this.finishTransfer(t, 'done');
    } catch (e) {
      if (!t.active) return;
      this.finishTransfer(t, e.status === 410 ? 'cancelled' : 'failed', e.status === 410 ? 'Receiver cancelled' : friendlyNetError(e));
    }
  }

  uploadItem(t, dev, item) {
    return new Promise((resolve, reject) => {
      const qs = new URLSearchParams({ sid: t.remote.sid, token: t.remote.token, fid: item.fid }).toString();
      const req = http.request({
        host: dev.ip, port: dev.port, method: 'PUT', path: '/api/v1/file?' + qs, agent: false,
        headers: { 'content-type': 'application/octet-stream', 'content-length': item.size },
      });
      t.reqs.add(req);
      item.state = 'sending';
      t.current = item.name;
      let sent = 0;
      const done = (err) => {
        t.reqs.delete(req);
        if (err) { t.bytes -= sent; item.state = 'failed'; reject(err); } else { item.state = 'done'; resolve(); }
        this.changed();
      };
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode === 200) return done();
          let msg = `HTTP ${res.statusCode}`;
          try { msg = JSON.parse(Buffer.concat(chunks).toString()).error || msg; } catch { /* ignore */ }
          done(Object.assign(new Error(msg), { status: res.statusCode }));
        });
      });
      req.on('error', (e) => done(e));
      req.setTimeout(STALL_MS, () => req.destroy(Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' })));
      const src = this.hooks.openRead ? this.hooks.openRead(item) : fs.createReadStream(item.path, { highWaterMark: 1 << 20 });
      src.on('error', (e) => req.destroy(e));
      src.pipe(counter((n) => { sent += n; t.bytes += n; })).pipe(req);
    });
  }

  // ----- selection -----

  async addPaths(paths) {
    const added = [];
    const walk = async (abs, rel) => {
      let st;
      try { st = await fsp.stat(abs); } catch { return; }
      if (st.isDirectory()) {
        let names = [];
        try { names = await fsp.readdir(abs); } catch { return; }
        for (const n of names) {
          if (added.length >= 20000) return;
          await walk(path.join(abs, n), rel + '/' + n);
        }
      } else if (st.isFile()) {
        added.push({ id: newId(), name: path.basename(abs), rel, size: st.size, path: abs, kind: 'file' });
      }
    };
    for (const p of paths) await walk(p, path.basename(p));
    const have = new Set(this.selection.map((i) => i.path));
    const fresh = added.filter((i) => !have.has(i.path));
    this.selection.push(...fresh);
    this.changed();
    return fresh.length;
  }

  // ----- web share (browser) -----

  webAuthed(req) {
    const m = /(?:^|;\s*)bdweb=([\w-]+)/.exec(req.headers.cookie || '');
    return !!(m && this.web.cookies.has(m[1]));
  }

  async routeWeb(req, res, op, q) {
    if (op === 'status') return sendJson(res, 200, { enabled: this.web.enabled, name: this.settings.name, avatar: this.settings.avatar, authed: this.webAuthed(req) });
    if (!this.web.enabled) return sendJson(res, 403, { error: 'Web share is off on this device' });
    if (op === 'auth' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const f = this.web.fails.get(ip) || { n: 0, until: 0 };
      if (f.until > now()) return sendJson(res, 429, { error: 'Too many tries. Wait a minute.' });
      const b = await readJson(req);
      if (String(b.pin) !== this.web.pin) {
        f.n++;
        if (f.n >= 5) { f.until = now() + 60000; f.n = 0; }
        this.web.fails.set(ip, f);
        return sendJson(res, 401, { error: 'Wrong PIN' });
      }
      const c = newId(18);
      this.web.cookies.add(c);
      res.setHeader('set-cookie', `bdweb=${c}; Path=/; HttpOnly; SameSite=Strict`);
      return sendJson(res, 200, { ok: true });
    }
    if (!this.webAuthed(req)) return sendJson(res, 401, { error: 'PIN required' });
    if (op === 'files') return sendJson(res, 200, { files: this.selection.map(({ id, name, size, rel }) => ({ id, name, size, rel })) });
    if (op === 'dl') {
      const item = this.selection.find((i) => i.id === q.get('id'));
      if (!item) return sendJson(res, 404, { error: 'gone' });
      res.writeHead(200, {
        'content-type': mimeOf(item.name), 'content-length': item.size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      });
      const src = this.hooks.openRead ? this.hooks.openRead(item) : fs.createReadStream(item.path);
      src.on('error', () => res.destroy());
      return src.pipe(res);
    }
    if (op === 'upload' && req.method === 'POST') {
      const name = safeName(q.get('name'));
      const rel = safeRel(q.get('rel') || name, name);
      const len = Number(req.headers['content-length']);
      const dest = await this.reservePath(path.join(this.settings.saveDir, ...rel));
      const tmp = dest + '.bdpart';
      let got = 0;
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await pipeline(req, counter((n) => { got += n; }), fs.createWriteStream(tmp));
        if (Number.isFinite(len) && got !== len) throw new Error('incomplete');
        await fsp.rename(tmp, dest);
      } catch (e) {
        fsp.unlink(tmp).catch(() => {});
        throw Object.assign(new Error('Upload failed'), { status: 500 });
      } finally {
        this.reserved.delete(dest.toLowerCase());
      }
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const batch = String(q.get('b') || newId());
      const peer = { id: 'web:' + ip, name: `Browser (${ip})`, platform: 'web', avatar: '🌐', color: '#6fd3ff' };
      const existing = this.history.find((h) => h.batch === batch);
      const it = { name: path.basename(dest), rel: rel.join('/'), size: got, loc: dest };
      if (existing) { existing.items.push(it); existing.total += got; this.saveHistorySoon(); } else this.addHistory({ dir: 'in', peer, status: 'done', items: [it], total: got, batch, saveDir: this.settings.saveDir });
      this.toast(`Received ${it.name} from a browser`, 'success');
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'unknown' });
  }

  // ----- history -----

  addHistory(h) {
    this.history.unshift({ id: newId(), ts: now(), ...h, peer: { name: h.peer.name, platform: h.peer.platform, avatar: h.peer.avatar, color: h.peer.color } });
    if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
    this.saveHistorySoon();
  }

  // ----- notifications -----

  notify(title, body, extra = {}) {
    if (this.settings.notifications && this.hooks.notify) {
      try { this.hooks.notify(title, body, extra); } catch (e) { console.error(e); }
    }
  }

  // ----- local UI API -----

  async routeLocal(req, res, op, q) {
    if (op === 'events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'state', state: this.snapshot() })}\n\n`);
      this.sse.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      res.on('close', () => { clearInterval(hb); this.sse.delete(res); });
      return;
    }
    if (op === 'state') return sendJson(res, 200, this.snapshot());
    if (op === 'history') return sendJson(res, 200, { rev: this.historyRev, items: this.history });
    if (op === 'qr') return sendJson(res, 200, { text: `bubbledrop://${(localIPv4s()[0] || {}).address || '127.0.0.1'}:${this.port}` });
    const b = req.method === 'POST' ? await readJson(req) : {};
    const out = await this.localAction(op, b);
    sendJson(res, 200, out === undefined ? { ok: true } : out);
  }

  async localAction(op, b) {
    const s = this.settings;
    switch (op) {
      case 'pick': {
        if (!this.hooks.pick) throw Object.assign(new Error('Not supported'), { status: 400 });
        const res = await this.hooks.pick(b.kind || 'files', this);
        if (Array.isArray(res)) {
          if (res.length && typeof res[0] === 'string') return { added: await this.addPaths(res) };
          this.selection.push(...res);
          this.changed();
          return { added: res.length };
        }
        return { added: 0 };
      }
      case 'add-paths': return { added: await this.addPaths((b.paths || []).map(String)) };
      case 'unselect': this.selection = this.selection.filter((i) => i.id !== b.id); this.changed(); return;
      case 'clear-selection': this.selection = []; this.changed(); return;
      case 'send': return { sid: await this.send(String(b.deviceId)) };
      case 'send-text': {
        const text = String(b.text || '').trim();
        if (!text) throw Object.assign(new Error('Type something first'), { status: 400 });
        return { sid: await this.send(String(b.deviceId), { items: [], text }) };
      }
      case 'respond': {
        const p = this.pending.get(b.rid);
        if (p) p.resolve({ accept: !!b.accept, trust: !!b.trust, reason: b.accept ? '' : 'Declined' });
        return;
      }
      case 'cancel': { const t = this.transfers.get(b.sid); if (t) this.cancelTransfer(t); return; }
      case 'retry': {
        const t = this.transfers.get(b.sid);
        if (!t || t.dir !== 'out' || t.active) return;
        if (!this.devices.get(t.peer.id)) throw Object.assign(new Error(`${t.peer.name} is not nearby right now`), { status: 404 });
        return { sid: await this.send(t.peer.id, t.text && !t.items.length ? { items: [], text: t.text } : { items: t.items.map((i) => ({ ...i, id: newId() })), text: t.text }) };
      }
      case 'dismiss': { const t = this.transfers.get(b.sid); if (t && !t.active) this.transfers.delete(b.sid); this.changed(); return; }
      case 'clear-finished': for (const [k, t] of this.transfers) if (!t.active) this.transfers.delete(k); this.changed(); return;
      case 'connect': return { device: await this.connect(String(b.address || '')) };
      case 'scan': this.scanNetwork().catch(() => {}); return;
      case 'refresh': this.announce('hi'); return;
      case 'settings': {
        const allowed = ['name', 'avatar', 'color', 'theme', 'autoAcceptTrusted', 'acceptAll', 'notifications', 'minimizeToTray', 'bubbles'];
        for (const k of allowed) if (k in b) s[k] = typeof s[k] === 'boolean' ? !!b[k] : String(b[k]).slice(0, 60);
        if (!s.name.trim()) s.name = this.defaultName();
        await this.saveSettings();
        this.emit('settings', s);
        this.announce('hi');
        this.changed();
        return;
      }
      case 'untrust': delete s.trusted[b.id]; await this.saveSettings(); this.changed(); return;
      case 'trust': if (b.id) { s.trusted[b.id] = String(b.name || b.id).slice(0, 60); await this.saveSettings(); this.changed(); } return;
      case 'webshare': {
        this.web.enabled = !!b.enabled;
        if (this.web.enabled) this.web.pin = String(crypto.randomInt(1000, 10000));
        else this.web.cookies.clear();
        this.changed();
        return;
      }
      case 'open': {
        const h = this.history.find((x) => x.id === b.id);
        if (!h) return;
        const it = h.items[b.idx || 0];
        if (b.reveal) {
          if (it && it.loc && this.hooks.showInFolder) this.hooks.showInFolder(it.loc);
          else if (this.hooks.openPath) this.hooks.openPath(h.saveDir || s.saveDir);
        } else if (it && it.loc && this.hooks.openPath) {
          const err = await this.hooks.openPath(it.loc);
          if (err) throw Object.assign(new Error(err), { status: 400 });
        }
        return;
      }
      case 'open-folder': if (this.hooks.openPath) { await fsp.mkdir(s.saveDir, { recursive: true }); this.hooks.openPath(s.saveDir); } return;
      case 'history-remove': this.history = this.history.filter((h) => h.id !== b.id); this.saveHistorySoon(); return;
      case 'history-clear': this.history = []; this.saveHistorySoon(); return;
      case 'copy': if (this.hooks.copyText) this.hooks.copyText(String(b.text || '')); return;
      default:
        if (this.hooks.action) {
          const r = await this.hooks.action(op, b, this);
          if (r !== undefined) { this.changed(); return r; }
        }
        throw Object.assign(new Error('Unknown action ' + op), { status: 404 });
    }
  }

  setSaveDir(dir) {
    this.settings.saveDir = dir;
    this.saveSettings();
    this.changed();
  }

  // ----- devices -----

  upsertDevice(d) {
    if (!d.id || d.id === this.settings.id) return;
    const old = this.devices.get(d.id);
    const dev = {
      id: d.id, name: String(d.name || 'Device').slice(0, 60), platform: String(d.platform || 'unknown').slice(0, 20),
      avatar: String(d.avatar || '📱').slice(0, 8), color: /^#[0-9a-f]{6}$/i.test(d.color) ? d.color : '#b28dff',
      ip: d.ip, port: Number(d.port) || DEFAULT_PORT, lastSeen: now(),
      source: old && old.source === 'manual' && d.source !== 'udp' ? 'manual' : d.source || 'udp', fails: 0,
    };
    this.devices.set(d.id, dev);
    if (!old || old.name !== dev.name || old.ip !== dev.ip || old.avatar !== dev.avatar) this.changed();
    return dev;
  }

  async connect(address) {
    const m = /^(?:bubbledrop|http):\/\/\[?([\w.:-]+?)\]?(?::(\d+))?(?:\/.*)?$/i.exec(address.trim()) || /^([\d.]+)(?::(\d+))?$/.exec(address.trim());
    if (!m) throw Object.assign(new Error('That does not look like an address. Try 192.168.1.20'), { status: 400 });
    const ip = m[1];
    const port = Number(m[2]) || DEFAULT_PORT;
    let inf;
    try { inf = await requestJson('GET', ip, port, '/api/v1/info', undefined, { timeout: 4000 }); } catch (e) {
      throw Object.assign(new Error(friendlyNetError(e)), { status: 502 });
    }
    if (!inf || inf.app !== APP) throw Object.assign(new Error('That is not a BubbleDrop device'), { status: 502 });
    if (inf.id === this.settings.id) throw Object.assign(new Error('That is this device 🙂'), { status: 400 });
    const dev = this.upsertDevice({ ...inf, ip, port, source: 'manual' });
    this.toast(`Connected to ${dev.name}`, 'success');
    return dev;
  }

  async scanNetwork() {
    if (this.scanning) return;
    this.scanning = true;
    this.changed();
    try {
      const targets = [];
      for (const a of localIPv4s().slice(0, 3)) {
        const prefix = Math.max(a.prefix, 24);
        const mask = prefix >= 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0;
        const net = (ipToInt(a.address) & mask) >>> 0;
        const count = 2 ** (32 - prefix);
        for (let i = 1; i < count - 1; i++) { const ip = intToIp((net + i) >>> 0); if (ip !== a.address) targets.push(ip); }
      }
      let found = 0;
      const queue = targets.slice();
      const worker = async () => {
        while (queue.length) {
          const ip = queue.shift();
          try {
            const inf = await requestJson('GET', ip, DEFAULT_PORT, '/api/v1/info', undefined, { timeout: 900 });
            if (inf && inf.app === APP && inf.id !== this.settings.id) { this.upsertDevice({ ...inf, ip, source: 'manual' }); found++; }
          } catch { /* nobody there */ }
        }
      };
      await Promise.all(Array.from({ length: 64 }, worker));
      this.toast(found ? `Found ${found} device${found > 1 ? 's' : ''}` : 'No devices found. Make sure BubbleDrop is open on the other device.', found ? 'success' : 'info');
    } finally {
      this.scanning = false;
      this.changed();
    }
  }

  tick() {
    const t0 = now();
    let anyActive = false;
    for (const d of [...this.devices.values()]) {
      const busy = [...this.transfers.values()].some((t) => t.active && t.peer.id === d.id);
      if (busy) { d.lastSeen = t0; continue; }
      if (d.source === 'manual') {
        if (t0 - d.lastSeen > 5000 && !d.pinging) {
          d.pinging = true;
          requestJson('GET', d.ip, d.port, '/api/v1/info', undefined, { timeout: 2500 })
            .then(() => { d.lastSeen = now(); d.fails = 0; })
            .catch(() => { if (++d.fails >= 3) { this.devices.delete(d.id); this.changed(); } })
            .finally(() => { d.pinging = false; });
        }
      } else if (t0 - d.lastSeen > DEVICE_TTL) {
        this.devices.delete(d.id);
        this.changed();
      }
    }
    for (const t of this.transfers.values()) {
      if (!t.active) continue;
      anyActive = true;
      const dt = (t0 - (t._lastT || t0)) / 1000;
      if (dt > 0) {
        const inst = (t.bytes - (t._lastB || 0)) / dt;
        t.speed = t.speed ? t.speed * 0.6 + inst * 0.4 : inst;
      }
      t._lastT = t0;
      t._lastB = t.bytes;
      if (t.dir === 'in' && t.reqs.size === 0 && t0 - t.lastActivity > STALL_MS) this.finishTransfer(t, t.items.some((i) => i.state === 'done') ? 'partial' : 'failed', 'Sender stopped responding');
    }
    if (anyActive) this.changed();
  }

  // ----- discovery -----

  startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.udp = sock;
    this.joined = new Set();
    sock.on('error', (e) => console.error('udp', e.message));
    sock.on('message', (buf, rinfo) => this.onDatagram(buf, rinfo));
    sock.bind(UDP_PORT, () => {
      try { sock.setBroadcast(true); sock.setMulticastTTL(2); sock.setMulticastLoopback(false); } catch { /* ignore */ }
      this.joinGroups();
      this.announce('hi');
    });
    this.announcer = setInterval(() => { this.joinGroups(); this.announce('hi'); }, ANNOUNCE_MS);
  }

  joinGroups() {
    for (const a of localIPv4s()) {
      if (this.joined.has(a.address)) continue;
      try { this.udp.addMembership(MCAST, a.address); } catch { /* interface may not support multicast */ }
      this.joined.add(a.address);
    }
  }

  packet(t) {
    return Buffer.from(JSON.stringify({ ...this.info(), t }));
  }

  announce(t = 'hi') {
    if (!this.udp) return;
    const msg = this.packet(t);
    const send = (addr) => this.udp.send(msg, UDP_PORT, addr, () => {});
    for (const a of localIPv4s()) {
      send(a.broadcast);
      try { this.udp.setMulticastInterface(a.address); send(MCAST); } catch { /* ignore */ }
    }
    send('255.255.255.255');
  }

  onDatagram(buf, rinfo) {
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!m || m.bd !== PROTO || !m.id || m.id === this.settings.id) return;
    if (m.t === 'bye') {
      if (this.devices.delete(m.id)) this.changed();
      return;
    }
    const isNew = !this.devices.has(m.id);
    this.upsertDevice({ ...m, ip: rinfo.address, source: 'udp' });
    if (m.t === 'hi' && isNew) this.udp.send(this.packet('re'), UDP_PORT, rinfo.address, () => {});
  }
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}

module.exports = { Engine, localIPv4s, safeName, safeRel, fmtSize, APP, VERSION, DEFAULT_PORT, UDP_PORT };
