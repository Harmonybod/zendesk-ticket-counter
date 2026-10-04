// Builds store-package/ — exactly what gets zipped and uploaded.
// Two things differ from the repo root:
//   1. the "key" field is stripped (the Web Store assigns the ID itself and
//      rejects a manifest that pins one)
//   2. only the files below ship — notably NOT web/, which has its own
//      manifest.json and caused a "two manifest.json files" upload error.
const fs = require('fs');
const path = require('path');

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
    fs.writeFileSync(dest, JSON.stringify(m, null, 2) + '\n');
  } else {
    fs.copyFileSync(f, dest);
  }
}
console.log('built ' + OUT + '/ with ' + FILES.length + ' files');
