// Builds store-package/ — exactly what gets zipped and uploaded.
//
// Three things differ from the repo root:
//
//   1. the "key" field is stripped (the Web Store assigns the ID itself and
//      rejects a manifest that pins one).
//
//   2. oauth2.client_id is swapped from the DEV client to the STORE client.
//      chrome.identity.getAuthToken() only works when the OAuth client's
//      Application ID equals the extension ID actually running, and those
//      differ between a local unpacked build and the published item:
//
//        local unpacked   id mdebegcfdodoieddmiicapmikeppckml  (pinned by "key")
//                         -> client ...-0kg8lk2p03j7mgl8v7ld4i45544r0ovt
//        store item       id mdkbepmkmcnmcjdamfgpbpflmbahnbjd
//                         -> client ...-5vuq71m7k6a3oeir63rbclvnk1c3ku40
//
//      Keeping the dev client in the root manifest means local sign-in just
//      works; swapping here means the wrong one can't ship by accident.
//
//   3. only the files listed below ship — notably NOT web/, which has its own
//      manifest.json and caused a "two manifest.json files" upload error.

const fs = require('fs');
const path = require('path');

const DEV_CLIENT_ID   = '360976988892-0kg8lk2p03j7mgl8v7ld4i45544r0ovt.apps.googleusercontent.com';
const STORE_CLIENT_ID = '360976988892-5vuq71m7k6a3oeir63rbclvnk1c3ku40.apps.googleusercontent.com';

const FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'firebase-config.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'theme-init.js',
  'widget.css',
  'chart.min.js',
  'xlsx-writer.js',
  'fonts/inter-variable.woff2',
  'icons/google.svg',
  'icons/icon-16.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'icons/ticket_tracker_circle_badge_logo_darker.png',
];

const OUT = 'store-package';
fs.rmSync(OUT, { recursive: true, force: true });

for (const f of FILES) {
  const dest = path.join(OUT, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (f === 'manifest.json') {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete m.key;
    if (m.oauth2.client_id !== DEV_CLIENT_ID) {
      throw new Error('root manifest should hold the DEV client id, found: ' + m.oauth2.client_id);
    }
    m.oauth2.client_id = STORE_CLIENT_ID;
    fs.writeFileSync(dest, JSON.stringify(m, null, 2) + '\n');
  } else {
    fs.copyFileSync(f, dest);
  }
}

// Fail loudly rather than shipping something subtly wrong.
const shipped = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));
if ('key' in shipped) throw new Error('"key" survived into the package');
if (shipped.oauth2.client_id !== STORE_CLIENT_ID) throw new Error('wrong client_id in the package');
if (shipped.description.length > 132) throw new Error('description over the 132-char store limit');

console.log('built ' + OUT + '/ with ' + FILES.length + ' files');
console.log('  version   : ' + shipped.version);
console.log('  key       : stripped');
console.log('  client_id : ' + shipped.oauth2.client_id);
console.log('  (store item mdkbepmkmcnmcjdamfgpbpflmbahnbjd)');
