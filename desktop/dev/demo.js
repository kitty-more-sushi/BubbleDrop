'use strict';
// UI playground: one "real" engine plus a few fake nearby devices on localhost.
// Run: node dev/demo.js   → prints the URL to open in a browser.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../core/engine');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-demo-'));
const webDir = path.join(__dirname, '..', '..', 'web');
const sample = path.join(tmp, 'samples');
fs.mkdirSync(path.join(sample, 'Holiday pics'), { recursive: true });
for (const n of ['beach.jpg', 'sunset.jpg', 'party.mp4']) fs.writeFileSync(path.join(sample, 'Holiday pics', n), Buffer.alloc(1024 * 1024 * 3));
fs.writeFileSync(path.join(sample, 'notes.pdf'), Buffer.alloc(240000));

async function peer(name, avatar, color, port, platform) {
  const e = new Engine({ dataDir: path.join(tmp, name), webDir, port, discovery: false, platform, hooks: { defaultSaveDir: () => path.join(tmp, name, 'in') } });
  await e.start();
  Object.assign(e.settings, { name, avatar, color, acceptAll: true });
  return e;
}

(async () => {
  const main = new Engine({
    dataDir: path.join(tmp, 'main'), webDir, port: 47870, discovery: false,
    hooks: {
      defaultSaveDir: () => path.join(tmp, 'main', 'in'),
      caps: { dragDrop: false, joinWifi: true, chooseSaveDir: true, tray: true },
      pick: async (kind) => (kind === 'folder' ? [path.join(sample, 'Holiday pics')] : [path.join(sample, 'notes.pdf'), path.join(sample, 'Holiday pics', 'beach.jpg')]),
      action: async (op) => (op === 'join-wifi' ? { message: 'Demo: pretend we joined' } : undefined),
    },
  });
  await main.start();
  Object.assign(main.settings, { name: "Kitty's PC", avatar: '🍓', color: '#ff6fae' });
  const peers = [
    await peer('Pixel 9', '🐰', '#b28dff', 47871, 'android'),
    await peer('Galaxy A55', '🦄', '#6fd3ff', 47872, 'android'),
    await peer('Study Laptop', '🐼', '#7ef0c1', 47873, 'windows'),
  ];
  for (const p of peers) await main.connect(`127.0.0.1:${p.port}`);
  for (const p of peers) await p.connect(`127.0.0.1:${main.port}`);
  console.log(`UI: http://127.0.0.1:${main.port}/ui/`);

  // after a bit, a peer offers something so the accept dialog can be seen
  setTimeout(async () => {
    const p = peers[0];
    await p.addPaths([path.join(sample, 'Holiday pics')]);
    p.send(main.settings.id).catch(() => {});
  }, Number(process.env.OFFER_DELAY || 15000));
})();
