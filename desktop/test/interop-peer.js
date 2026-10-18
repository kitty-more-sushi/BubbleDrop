'use strict';
// Starts a Windows (Node) engine that auto-accepts, for the Android engine's interop test.
// Run: node test/interop-peer.js   then: android> gradlew testDebugUnitTest
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Engine } = require('../core/engine');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-interop-'));
  const inbox = path.join(dir, 'inbox');
  const sample = path.join(dir, 'from-windows.bin');
  fs.writeFileSync(sample, crypto.randomBytes(4 * 1024 * 1024));
  const e = new Engine({ dataDir: path.join(dir, 'data'), webDir: path.join(__dirname, '..', '..', 'web'), port: 47970, discovery: false, hooks: { defaultSaveDir: () => inbox } });
  await e.start();
  e.settings.acceptAll = true;
  const cfg = path.join(os.tmpdir(), 'bd-interop.json');
  fs.writeFileSync(cfg, JSON.stringify({ port: e.port, token: e.token, inbox, sample }));
  console.log('interop peer ready on', e.port, '→', cfg);
  const bye = async () => { fs.rmSync(cfg, { force: true }); await e.stop(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  setTimeout(bye, 10 * 60 * 1000);
})();
