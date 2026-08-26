'use strict';
/** תשתית בדיקות: מסד נתונים זמני, נתוני דמה ושרת מקומי. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function useTempDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lola-${name}-`));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.DATA_DIR = dir;
  return dir;
}

/** מגדיר שעות פעילות אחידות ומנקה נתונים קודמים */
function resetSchedule(db, { open = '09:00', close = '17:00', days = [0, 1, 2, 3, 4, 5, 6] } = {}) {
  const d = db.get();
  d.exec('DELETE FROM appointments; DELETE FROM exceptions; DELETE FROM customers; DELETE FROM working_hours; DELETE FROM waitlist;');
  const ins = d.prepare('INSERT INTO working_hours (weekday, start_time, end_time) VALUES (?,?,?)');
  for (const wd of days) ins.run(wd, open, close);
}

function addService(db, { name = 'טיפול', duration = 60, buffer = 0, price = 100, ...rest } = {}) {
  const info = db.get().prepare(
    `INSERT INTO services (name, description, duration_min, price, buffer_min, active, bookable_online, requires_approval)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(name, '', duration, price, buffer, rest.active ?? 1, rest.bookableOnline ?? 1, rest.requiresApproval ?? 0);
  return db.get().prepare('SELECT * FROM services WHERE id = ?').get(Number(info.lastInsertRowid));
}

/** תאריך עתידי ביום מסוים בשבוע (ברירת מחדל: יום ראשון בעוד שבוע לפחות) */
function futureDate(T, { weekday = 1, minDays = 8 } = {}) {
  let date = T.addDays(T.todayISO(), minDays);
  while (T.weekdayOf(date) !== weekday) date = T.addDays(date, 1);
  return date;
}

/** מריץ את השרת על פורט חופשי ומחזיר כתובת בסיס */
async function startServer() {
  const { createApp } = require('../src/server');
  const server = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    async req(method, path, { body, cookie, admin = false, raw = false } = {}) {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      if (admin) headers['X-Requested-With'] = 'lola-admin';
      const res = await fetch(base + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      if (raw) return { status: res.status, text, headers: res.headers };
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      return { status: res.status, data, headers: res.headers };
    },
  };
}

module.exports = { useTempDb, resetSchedule, addService, futureDate, startServer };
