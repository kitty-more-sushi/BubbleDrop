'use strict';
// Takes the README screenshots with fake demo devices.
// Run: node_modules/electron/dist/electron.exe dev/screenshots.js
process.env.OFFER_DELAY = '9000';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', '..', 'docs', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  require('./demo');
  fs.mkdirSync(out, { recursive: true });
  await sleep(2000);
  const win = new BrowserWindow({ width: 1200, height: 780, useContentSize: true, show: false, minWidth: 300, backgroundColor: '#120a1a', webPreferences: { backgroundThrottling: false } });
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name), img.toPNG());
    console.log('saved', name);
  };
  await win.loadURL('http://127.0.0.1:47870/ui/');
  await win.webContents.executeJavaScript("localStorage.setItem('bd-onboarded','1'); location.reload(); 1");
  await sleep(3000);
  await shot('desktop-nearby.png');
  win.setContentSize(400, 860);
  await sleep(2000);
  await shot('phone-nearby.png');
  win.setContentSize(1200, 780);
  await sleep(6000); // demo peer sends an offer at ~9s
  await shot('desktop-incoming.png');
  app.exit(0);
});
