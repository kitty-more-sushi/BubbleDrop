'use strict';
// Headless end-to-end test: two engines on localhost send files, folders and text to each other.
// Run: node test/transfer.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Engine } = require('../core/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-test-'));
const webDir = path.join(__dirname, '..', '..', 'web');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function waitFor(fn, ms = 20000, what = 'condition') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(50); }
  throw new Error('timeout waiting for ' + what);
}

function mkEngine(name, port) {
  const e = new Engine({
    dataDir: path.join(tmp, name, 'data'), webDir, port, discovery: false,
    hooks: { defaultSaveDir: () => path.join(tmp, name, 'inbox') },
  });
  return e;
}

(async () => {
  const A = mkEngine('A', 47950);
  const B = mkEngine('B', 47960);
  await A.start();
  await B.start();
  console.log('ports', A.port, B.port);

  // sample files: a folder with nested files + a big file
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'Trip', 'day1'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Trip', 'day1', 'a.txt'), 'hello bubble');
  fs.writeFileSync(path.join(src, 'Trip', 'empty.bin'), Buffer.alloc(0));
  fs.writeFileSync(path.join(src, 'Trip', 'pic.jpg'), crypto.randomBytes(300000));
  const big = path.join(src, 'big.bin');
  fs.writeFileSync(big, crypto.randomBytes(80 * 1024 * 1024));

  // connect A -> B by address
  const dev = await A.localAction('connect', { address: `127.0.0.1:${B.port}` });
  assert.strictEqual(dev.device.id, B.settings.id);

  // 1) offer that B declines
  await A.addPaths([path.join(src, 'Trip')]);
  assert.strictEqual(A.selection.length, 3);
  const sid1 = await A.send(B.settings.id);
  await waitFor(() => B.pending.size === 1, 5000, 'pending offer');
  const [p] = B.pending.values();
  assert.strictEqual(p.items.length, 3);
  await B.localAction('respond', { rid: p.rid, accept: false });
  await waitFor(() => A.transfers.get(sid1).status === 'declined', 5000, 'declined');
  console.log('✓ decline');

  // 2) accept + trust, folder structure kept
  const sid2 = await A.localAction('retry', { sid: sid1 }).then((r) => r.sid);
  await waitFor(() => B.pending.size === 1, 5000, 'pending offer 2');
  await B.localAction('respond', { rid: [...B.pending.values()][0].rid, accept: true, trust: true });
  await waitFor(() => !A.transfers.get(sid2).active, 20000, 'folder send');
  assert.strictEqual(A.transfers.get(sid2).status, 'done', A.transfers.get(sid2).error);
  const inbox = path.join(tmp, 'B', 'inbox');
  assert.strictEqual(fs.readFileSync(path.join(inbox, 'Trip', 'day1', 'a.txt'), 'utf8'), 'hello bubble');
  assert.strictEqual(fs.statSync(path.join(inbox, 'Trip', 'empty.bin')).size, 0);
  assert.strictEqual(sha(path.join(inbox, 'Trip', 'pic.jpg')), sha(path.join(src, 'Trip', 'pic.jpg')));
  assert.ok(B.settings.trusted[A.settings.id], 'A should be trusted now');
  console.log('✓ folder transfer + trust');

  // 3) trusted device auto-accepts; big file; speed
  await A.addPaths([big]);
  const t0 = Date.now();
  const sid3 = await A.send(B.settings.id);
  await waitFor(() => !A.transfers.get(sid3).active, 60000, 'big send');
  assert.strictEqual(A.transfers.get(sid3).status, 'done', A.transfers.get(sid3).error);
  assert.strictEqual(sha(path.join(inbox, 'big.bin')), sha(big));
  console.log(`✓ 80 MB auto-accepted in ${Date.now() - t0} ms`);

  // 4) same name again -> "big (1).bin"
  await A.addPaths([big]);
  const sid4 = await A.send(B.settings.id);
  await waitFor(() => !A.transfers.get(sid4).active, 60000, 'dup send');
  assert.ok(fs.existsSync(path.join(inbox, 'big (1).bin')));
  console.log('✓ name collision handled');

  // 5) cancel mid-way by receiver
  await A.addPaths([big]);
  const sid5 = await A.send(B.settings.id);
  const inT = await waitFor(() => [...B.transfers.values()].find((t) => t.active && t.bytes > 0), 10000, 'incoming active');
  await B.localAction('cancel', { sid: inT.sid });
  await waitFor(() => !A.transfers.get(sid5).active, 10000, 'sender sees cancel');
  assert.strictEqual(A.transfers.get(sid5).status, 'cancelled');
  await sleep(300);
  assert.ok(!fs.readdirSync(inbox).some((f) => f.endsWith('.bdpart')), 'partial file removed');
  console.log('✓ receiver cancel');

  // 6) text message
  let got = null;
  B.once('text', (_peer, text) => { got = text; });
  await A.localAction('send-text', { deviceId: B.settings.id, text: 'pop! 🍬 https://example.com' });
  await waitFor(() => got, 5000, 'text');
  assert.strictEqual(got, 'pop! 🍬 https://example.com');
  console.log('✓ text message');

  // 7) history written on both sides
  assert.ok(B.history.filter((h) => h.dir === 'in').length >= 4);
  assert.ok(A.history.filter((h) => h.dir === 'out').length >= 4);
  console.log('✓ history');

  // 8) local API is locked to loopback + token
  const http = require('http');
  const status = (p, headers = {}) => new Promise((r) => http.get({ host: '127.0.0.1', port: A.port, path: p, headers }, (res) => { res.resume(); r(res.statusCode); }));
  assert.strictEqual(await status('/local/state'), 401);
  assert.strictEqual(await status('/local/state', { 'x-bd-token': A.token }), 200);
  assert.strictEqual(await status('/local/state', { 'x-bd-token': A.token, host: 'evil.com' }), 403);
  console.log('✓ local API protected');

  await A.stop();
  await B.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ALL PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
