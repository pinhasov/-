'use strict';
/**
 * מערכת "לולה פדיקור - קביעת תורים"
 * שרת HTTP ללא תלויות חיצוניות: מגיש את ממשק הלקוחה, ממשק הניהול וה-API.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const db = require('./db');
const auth = require('./auth');
const { createRouter, serveStatic, send, sendJSON, fail } = require('./http');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function buildRouter() {
  const router = createRouter();
  publicRoutes.register(router);
  adminRoutes.register(router);
  router.get('/api/health', (req, res) => sendJSON(res, 200, { ok: true, service: 'lola-booking' }));
  return router;
}

function sendHtml(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  const body = fs.readFileSync(full);
  send(res, 200, body, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
}

function createApp() {
  db.open();
  const router = buildRouter();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://x').pathname;

      // בקשות API
      const match = router.match(req.method, pathname);
      if (match) {
        await match.handler(req, res, match.params);
        return;
      }
      if (pathname.startsWith('/api/')) return fail(res, 404, 'הנתיב לא נמצא');

      // דפי המערכת
      if (pathname === '/' || pathname === '/index.html') return sendHtml(res, 'index.html');
      if (pathname === '/book') return sendHtml(res, 'index.html');
      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') return sendHtml(res, 'admin.html');
      if (pathname.startsWith('/t/')) return sendHtml(res, 'manage.html');   // קישור אישי לניהול תור
      if (pathname === '/manage' || pathname === '/manage.html') return sendHtml(res, 'manage.html');

      // קבצים סטטיים
      if (serveStatic(req, res, PUBLIC_DIR, pathname)) return;

      send(res, 404, '<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;direction:rtl;text-align:center;padding:40px">'
        + '<h1>הדף לא נמצא</h1><p><a href="/">חזרה לקביעת תור</a></p></body>',
      { 'Content-Type': 'text/html; charset=utf-8' });
    } catch (err) {
      console.error('[שגיאה]', req.method, pathname, err);
      if (!res.writableEnded) fail(res, err.status || 500, err.status ? err.message : 'אירעה שגיאה במערכת');
    } finally {
      if (process.env.LOG_REQUESTS === '1') {
        console.log(`${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
      }
    }
  });
}

/**
 * אתחול ראשוני אוטומטי בעלייה הראשונה (סביבות ענן שאין בהן גישת שורת פקודה).
 * פועל רק כאשר AUTO_SEED=1 וכאשר עדיין אין משתמשי ניהול במערכת.
 */
function autoSeed() {
  if (process.env.AUTO_SEED !== '1') return;
  const { c } = db.get().prepare('SELECT COUNT(*) AS c FROM admins').get();
  if (c > 0) return;
  if (!process.env.LOLA_PASSWORD || !process.env.AVI_PASSWORD) {
    console.log('⚠  AUTO_SEED פעיל אך חסרות הסיסמאות LOLA_PASSWORD / AVI_PASSWORD – האתחול דולג.');
    return;
  }
  require('../scripts/seed').run({ keepOpen: true });
  console.log('בוצע אתחול ראשוני: טיפולים ומשתמשי ניהול נוצרו.');
}

/**
 * בדיקת אחסון בעליית השרת – מוודאת שמסד הנתונים יושב על אחסון קבוע
 * ושהנתונים אינם נמחקים בכל פריסה מחדש.
 */
function logStorageStatus() {
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH || process.env.PERSISTENT_MOUNT_PATH || '';
  console.log(`מסד הנתונים: ${db.DB_PATH}`);
  console.log(`הנתונים נשמרו מהפעלה קודמת: ${db.wasExisting() ? 'כן' : 'לא (מסד נתונים חדש)'}`);
  if (mount) {
    const onVolume = path.resolve(db.DB_PATH).startsWith(path.resolve(mount));
    console.log(`דיסק קבוע מחובר בנתיב: ${mount}`);
    if (!onVolume) {
      console.log(`⚠  אזהרה: מסד הנתונים אינו נמצא על הדיסק הקבוע. יש להגדיר DB_PATH לנתיב שמתחת ל-${mount}, אחרת התורים יימחקו בכל פריסה.`);
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.log('⚠  אזהרה: לא זוהה דיסק קבוע. בסביבת ענן ללא דיסק קבוע התורים נמחקים בכל פריסה מחדש.');
  }
}

function start() {
  const server = createApp();
  logStorageStatus();
  try { autoSeed(); } catch (err) { console.error('שגיאה באתחול הראשוני:', err.message); }
  server.listen(PORT, HOST, () => {
    const { c } = db.get().prepare('SELECT COUNT(*) AS c FROM admins').get();
    console.log(`מערכת התורים של לולה פועלת: http://localhost:${PORT}`);
    console.log(`ממשק ניהול: http://localhost:${PORT}/admin`);
    if (c === 0) {
      console.log('⚠  לא הוגדרו משתמשי ניהול. יש להריץ: npm run seed  (או npm run create-admin)');
    }
    auth.purgeExpired();
  });
  const shutdown = () => {
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (require.main === module) start();

module.exports = { createApp, start, PUBLIC_DIR };
