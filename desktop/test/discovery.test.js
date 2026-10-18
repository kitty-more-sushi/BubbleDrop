'use strict';
// Two engines with UDP discovery on: they must find each other without being told an address.
// Run: node test/discovery.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../core/engine');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-disc-'));
  const mk = (n, port) => new Engine({ dataDir: path.join(tmp, n), webDir: path.join(__dirname, '..', '..', 'web'), port, hooks: { defaultSaveDir: () => path.join(tmp, n, 'in') } });
  const A = mk('A', 47940);
  const B = mk('B', 47945);
  await A.start();
  await B.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    if (A.devices.has(B.settings.id) && B.devices.has(A.settings.id)) {
      console.log(`✓ discovered each other in ${Date.now() - t0} ms via`, A.devices.get(B.settings.id).ip);
      await A.stop(); await B.stop();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log('✗ not discovered. A sees', [...A.devices.keys()], 'B sees', [...B.devices.keys()]);
  process.exit(1);
})();
