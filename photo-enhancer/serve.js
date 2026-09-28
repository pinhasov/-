'use strict';
// שרת מקומי קטן להפעלת "משדרג תמונות" – בלי תלויות חיצוניות.
// הפעלה: node serve.js   (או לחיצה כפולה על start-windows.bat / start-mac.command)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.bin': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(ROOT, path.normalize(rel));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403).end(); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('לא נמצא'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': file.includes(`${path.sep}models${path.sep}`) || file.includes(`${path.sep}vendor${path.sep}`) ? 'max-age=604800' : 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
});

// בענן (Railway) מאזינים לכל הכתובות; במחשב – רק למחשב עצמו
const IN_CLOUD = !!process.env.RAILWAY_ENVIRONMENT;
const HOST = process.env.HOST || (IN_CLOUD ? '0.0.0.0' : '127.0.0.1');

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`משדרג תמונות פועל בכתובת: ${url}`);
  if (IN_CLOUD || process.env.NO_OPEN) return;
  console.log('להפסקה: סגור את החלון הזה (או Ctrl+C).');
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`הפורט ${PORT} תפוס – ייתכן שהאפליקציה כבר פתוחה. נסה לפתוח http://localhost:${PORT}`);
  else console.error(err);
  process.exitCode = 1;
});
