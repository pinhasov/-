'use strict';
/**
 * בדיקות הקבלה המחייבות מסעיף 23 באפיון.
 * הבדיקות רצות מול השרת האמיתי (HTTP) ומול מסד נתונים זמני.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { useTempDb, resetSchedule, addService, futureDate, startServer } = require('./helpers');

useTempDb('acceptance');
const db = require('../src/db');
const T = require('../src/time');
const auth = require('../src/auth');

db.open();
resetSchedule(db, { open: '09:00', close: '17:00' });
db.setSetting('slot_step_min', '15');
db.setSetting('min_lead_hours', '0');
db.setSetting('max_advance_days', '120');

const short = addService(db, { name: 'לק ג\'ל', duration: 40, price: 120 });
const long = addService(db, { name: 'בניית ציפורניים', duration: 90, price: 260 });
auth.createAdmin({ name: 'לולה', username: 'lola', password: 'SodBadok12', role: 'owner' });
auth.createAdmin({ name: 'אבי', username: 'avi', password: 'SodBadok12' });

let srv;
let adminCookie;
const DATE = futureDate(T, { weekday: 1, minDays: 10 });     // יום שני עתידי
const DATE2 = futureDate(T, { weekday: 2, minDays: 10 });    // יום שלישי עתידי

test.before(async () => {
  srv = await startServer();
  const res = await srv.req('POST', '/api/admin/login', { body: { username: 'lola', password: 'SodBadok12' } });
  assert.equal(res.status, 200);
  adminCookie = res.headers.get('set-cookie').split(';')[0];
});

test.after(async () => { await srv.close(); });

// ---------- לוח שנה מלא ----------
test('1-3. לוח השנה מציג חודש מלא וניתן לעבור בין חודשים', async () => {
  const y = Number(DATE.slice(0, 4));
  const m = Number(DATE.slice(5, 7));
  const res = await srv.req('GET', `/api/calendar?service_id=${long.id}&year=${y}&month=${m}`);
  assert.equal(res.status, 200);
  assert.equal(res.data.days.length, T.daysInMonth(y, m), 'כל ימי החודש מוצגים ולא רק שלושה או ארבעה');
  assert.ok(res.data.days.length >= 28);
  assert.equal(typeof res.data.firstWeekday, 'number', 'ידוע באיזה יום בשבוע מתחיל החודש (תצוגה מימין לשמאל מיום ראשון)');

  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const res2 = await srv.req('GET', `/api/calendar?service_id=${long.id}&year=${next.y}&month=${next.m}`);
  assert.equal(res2.status, 200);
  assert.equal(res2.data.month, next.m, 'ניתן לעבור לחודש הבא');
  assert.ok(res2.data.days.length >= 28);
});

test('4. בחירת תאריך מציגה מיד את שעות אותו היום', async () => {
  const res = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${DATE}`);
  assert.equal(res.status, 200);
  assert.ok(res.data.slots.length > 0, 'השעות מגיעות בקריאה אחת, ללא לחיצה נוספת');
  assert.equal(res.data.slots[0].time, '09:00');
  assert.equal(res.data.dateIL, T.formatIL(DATE), 'תאריך בפורמט ישראלי');
});

test('5. ניתן להבחין בין שעה פנויה, תפוסה וחסומה', async () => {
  await srv.req('POST', '/api/admin/exceptions', {
    admin: true, cookie: adminCookie,
    body: { date: DATE, type: 'block', startTime: '15:00', endTime: '16:00', reason: 'הפסקה' },
  });
  const book = await srv.req('POST', '/api/book', {
    body: {
      serviceId: short.id, date: DATE, time: '10:00',
      fullName: 'דנה כהן', phone: '0501234567', acceptTerms: true,
    },
  });
  assert.equal(book.status, 201);

  const res = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${DATE}`);
  const byTime = Object.fromEntries(res.data.slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['09:00'], 'free');
  assert.equal(byTime['10:00'], 'taken');
  assert.equal(byTime['15:00'], 'blocked');
  assert.ok(!JSON.stringify(res.data).includes('דנה'), 'שם הלקוחה שתפסה את השעה אינו נחשף');
});

test('6. לא ניתן לקבוע תור בשעה תפוסה', async () => {
  const res = await srv.req('POST', '/api/book', {
    body: {
      serviceId: short.id, date: DATE, time: '10:00',
      fullName: 'רותי לוי', phone: '0521234567', acceptTerms: true,
    },
  });
  assert.equal(res.status, 409);
  assert.match(res.data.error, /נתפסה|אינה זמינה/);
});

test('7. טיפול של 90 דקות מוצג רק בשעות עם זמינות מלאה', async () => {
  const res = await srv.req('GET', `/api/slots?service_id=${long.id}&date=${DATE}`);
  const byTime = Object.fromEntries(res.data.slots.map((s) => [s.time, s.status]));
  // קיים תור 10:00-10:40, ולכן טיפול של 90 דקות אינו יכול להתחיל ב-09:00 (יסתיים ב-10:30)
  assert.equal(byTime['09:00'], 'taken');
  assert.equal(byTime['10:45'], 'free');
  // חסימה 15:00-16:00 חוסמת גם התחלה ב-14:00 (יסתיים ב-15:30)
  assert.equal(byTime['14:00'], 'blocked');
  assert.equal(res.data.durationMin, 90);
});

test('8. לא ניתן לקבוע שני תורים חופפים', async () => {
  const overlap = await srv.req('POST', '/api/book', {
    body: {
      serviceId: long.id, date: DATE, time: '09:30',
      fullName: 'מיכל אבן', phone: '0533334444', acceptTerms: true,
    },
  });
  assert.equal(overlap.status, 409);

  const rows = db.get().prepare('SELECT start_time, end_time FROM appointments WHERE date = ? ORDER BY start_time').all(DATE);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].start_time >= rows[i - 1].end_time, 'אין חפיפה בין תורים');
  }
});

test('9. תור שנקבע על ידי לקוחה מופיע מיד במערכת הניהול', async () => {
  const res = await srv.req('GET', `/api/admin/appointments?from=${DATE}&to=${DATE}`, { cookie: adminCookie });
  assert.equal(res.status, 200);
  const appt = res.data.appointments.find((a) => a.startTime === '10:00');
  assert.ok(appt, 'התור של הלקוחה מופיע ביומן הניהול');
  assert.equal(appt.customerName, 'דנה כהן');
  assert.equal(appt.customerPhone, '0501234567');
});

test('10. תור שהוזן על ידי לולה או אבי חוסם מיד את השעה ללקוחות', async () => {
  const created = await srv.req('POST', '/api/admin/appointments', {
    admin: true, cookie: adminCookie,
    body: {
      serviceId: short.id, date: DATE2, time: '11:00',
      fullName: 'לקוחה טלפונית', phone: '0544445555', internalNote: 'נקבע בטלפון',
    },
  });
  assert.equal(created.status, 201);

  const slots = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${DATE2}`);
  const byTime = Object.fromEntries(slots.data.slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['11:00'], 'taken');

  const attempt = await srv.req('POST', '/api/book', {
    body: {
      serviceId: short.id, date: DATE2, time: '11:00',
      fullName: 'שרה כהן', phone: '0555556666', acceptTerms: true,
    },
  });
  assert.equal(attempt.status, 409);
});

test('11. ביטול תור מחזיר את השעה לזמינות', async () => {
  const book = await srv.req('POST', '/api/book', {
    body: {
      serviceId: short.id, date: DATE2, time: '13:00',
      fullName: 'נועה ברק', phone: '0566667777', acceptTerms: true,
    },
  });
  assert.equal(book.status, 201);
  const token = book.data.appointment.manageToken;

  let slots = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${DATE2}`);
  assert.equal(slots.data.slots.find((s) => s.time === '13:00').status, 'taken');

  const cancel = await srv.req('POST', `/api/appointment/${token}/cancel`, { body: {} });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.appointment.status, 'cancelled_customer');

  slots = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${DATE2}`);
  assert.equal(slots.data.slots.find((s) => s.time === '13:00').status, 'free');
});

test('12. חסימת יום במערכת הניהול מונעת קביעת תורים באותו יום', async () => {
  const date = futureDate(T, { weekday: 3, minDays: 20 });
  const res = await srv.req('POST', '/api/admin/exceptions', {
    admin: true, cookie: adminCookie,
    body: { date, type: 'block', reason: 'יום חופש' },
  });
  assert.equal(res.status, 201);

  const slots = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${date}`);
  assert.equal(slots.data.freeCount, 0);
  assert.ok(slots.data.slots.every((s) => s.status === 'blocked'));

  const attempt = await srv.req('POST', '/api/book', {
    body: { serviceId: short.id, date, time: '10:00', fullName: 'יעל דור', phone: '0577778888', acceptTerms: true },
  });
  assert.equal(attempt.status, 409);

  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const cal = await srv.req('GET', `/api/calendar?service_id=${short.id}&year=${y}&month=${m}`);
  assert.equal(cal.data.days.find((d) => d.date === date).status, 'full');
});

test('13. הלקוחה אינה יכולה להיכנס למערכת הניהול', async () => {
  const endpoints = [
    ['GET', '/api/admin/appointments'],
    ['GET', '/api/admin/customers'],
    ['GET', '/api/admin/settings'],
    ['GET', '/api/admin/export/appointments.csv'],
    ['GET', '/api/admin/audit'],
  ];
  for (const [method, url] of endpoints) {
    const res = await srv.req(method, url);
    assert.equal(res.status, 401, `${url} חסום ללא התחברות`);
  }
  const create = await srv.req('POST', '/api/admin/appointments', {
    body: { serviceId: short.id, date: DATE2, time: '15:00', fullName: 'פורצת', phone: '0500000000' },
  });
  assert.equal(create.status, 401);

  const badLogin = await srv.req('POST', '/api/admin/login', { body: { username: 'lola', password: 'שגוי' } });
  assert.equal(badLogin.status, 401);
});

test('14. הלקוחה אינה רואה פרטים של לקוחות אחרות', async () => {
  const slots = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${DATE}`);
  const body = JSON.stringify(slots.data);
  assert.ok(!body.includes('דנה'), 'אין שמות לקוחות ברשימת השעות');
  assert.ok(!body.includes('0501234567'), 'אין מספרי טלפון ברשימת השעות');

  const services = await srv.req('GET', '/api/services');
  assert.ok(!JSON.stringify(services.data).includes('0501234567'));

  const other = await srv.req('GET', '/api/appointment/token-that-does-not-exist');
  assert.equal(other.status, 404);

  const mine = await srv.req('POST', '/api/my-appointments', { body: { tokens: ['לא-קיים'] } });
  assert.deepEqual(mine.data.appointments, []);
});

test('15. קובץ היומן נוצר עם התאריך והשעות הנכונים', async () => {
  const book = await srv.req('POST', '/api/book', {
    body: {
      serviceId: long.id, date: DATE2, time: '15:00',
      fullName: 'אורית שלו', phone: '0588889999', acceptTerms: true,
    },
  });
  assert.equal(book.status, 201);
  const token = book.data.appointment.manageToken;

  const res = await srv.req('GET', `/api/appointment/${token}/ics`, { raw: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/calendar/);

  const ics = res.text;
  const start = T.localToDate(DATE2, '15:00');
  const end = T.localToDate(DATE2, '16:30');
  const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.ok(ics.includes(`DTSTART:${stamp(start)}`), 'שעת ההתחלה נכונה');
  assert.ok(ics.includes(`DTEND:${stamp(end)}`), 'שעת הסיום לפי משך הטיפול');
  assert.ok(ics.includes('BEGIN:VEVENT') && ics.includes('END:VCALENDAR'));
  assert.ok(ics.includes('VALARM'), 'נכללת תזכורת ביומן');

  const info = await srv.req('GET', `/api/appointment/${token}`);
  assert.ok(info.data.calendar.google.includes('calendar.google.com'));
  assert.ok(info.data.calendar.outlook.includes('outlook'));
});

test('16-17. הממשק בעברית, בכיוון ימין לשמאל ומותאם לנייד', async () => {
  for (const file of ['index.html', 'manage.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
    assert.match(html, /<html[^>]+lang="he"/, `${file}: שפה עברית`);
    assert.match(html, /<html[^>]+dir="rtl"/, `${file}: כיוון מימין לשמאל`);
    assert.match(html, /name="viewport"[^>]+width=device-width/, `${file}: התאמה למסכי נייד`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.dir, 'rtl');
  assert.equal(manifest.lang, 'he');
  assert.ok(manifest.icons.length >= 2, 'קיימים אייקונים להתקנה כאפליקציה');

  const home = await srv.req('GET', '/', { raw: true });
  assert.equal(home.status, 200);
  assert.ok(home.text.includes('קביעת תור אצל לולה'));
});

test('שינוי מועד על ידי הלקוחה בקישור האישי', async () => {
  const date = futureDate(T, { weekday: 4, minDays: 15 });
  const book = await srv.req('POST', '/api/book', {
    body: { serviceId: short.id, date, time: '09:00', fullName: 'הילה נוי', phone: '0599990000', acceptTerms: true },
  });
  const token = book.data.appointment.manageToken;
  const move = await srv.req('POST', `/api/appointment/${token}/reschedule`, { body: { date, time: '12:00' } });
  assert.equal(move.status, 200);
  assert.equal(move.data.appointment.startTime, '12:00');

  const slots = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${date}`);
  const byTime = Object.fromEntries(slots.data.slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['09:00'], 'free', 'המועד הישן חזר להיות פנוי');
  assert.equal(byTime['12:00'], 'taken');
});

test('מדיניות ביטולים חוסמת ביטול בהתראה קצרה', async () => {
  const date = T.todayISO();
  db.setSetting('cancel_cutoff_hours', '24');
  const info = db.get().prepare(
    `INSERT INTO appointments (customer_id, service_id, service_name, date, start_time, end_time, status, manage_token)
     VALUES (NULL, ?, ?, ?, '23:00', '23:40', 'confirmed', 'token-late')`
  ).run(short.id, short.name, date);
  assert.ok(info.changes === 1);
  const res = await srv.req('POST', '/api/appointment/token-late/cancel', { body: {} });
  assert.equal(res.status, 403);
  assert.match(res.data.error, /24 שעות/);
});

test('רשימת המתנה נשמרת ומוצגת למנהלים בלבד', async () => {
  const res = await srv.req('POST', '/api/waitlist', {
    body: { fullName: 'ליאת גל', phone: '0512345678', serviceId: short.id, date: DATE, timeFrom: '09:00', timeTo: '12:00' },
  });
  assert.equal(res.status, 201);
  assert.equal((await srv.req('GET', '/api/admin/waitlist')).status, 401);
  const list = await srv.req('GET', '/api/admin/waitlist', { cookie: adminCookie });
  assert.equal(list.status, 200);
  assert.equal(list.data.waitlist[0].full_name, 'ליאת גל');
});

test('יצוא התורים לקובץ CSV עובד ומכיל כותרות בעברית', async () => {
  const raw = await fetch(`${srv.base}/api/admin/export/appointments.csv`, { headers: { Cookie: adminCookie } });
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-type'), /text\/csv/);
  const bytes = Buffer.from(await raw.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'סימן BOM כדי שהקובץ ייפתח כראוי ב-Excel');
  const text = bytes.toString('utf8');
  assert.ok(text.includes('לקוחה') && text.includes('טיפול'));
});

test('פעולות ניהול מתועדות', async () => {
  const res = await srv.req('GET', '/api/admin/audit', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const actions = res.data.log.map((r) => r.action);
  assert.ok(actions.includes('create_exception'));
  assert.ok(actions.includes('create_appointment'));
});

test('בקשת שינוי ללא כותרת אבטחה נדחית', async () => {
  const res = await srv.req('POST', '/api/admin/exceptions', {
    cookie: adminCookie,
    body: { date: DATE2, type: 'block' },
  });
  assert.equal(res.status, 403);
});

// ---------- בחירת כמה טיפולים בתור אחד ----------
test('ניתן לבחור כמה טיפולים בתור אחד והמערכת מחשבת את המשך הכולל', async () => {
  const date = futureDate(T, { weekday: 0, minDays: 25 });
  const slots = await srv.req('GET', `/api/slots?service_ids=${short.id},${long.id}&date=${date}`);
  assert.equal(slots.status, 200);
  assert.equal(slots.data.durationMin, 130, 'משך התור הוא סכום שני הטיפולים');
  assert.equal(slots.data.serviceName, `${short.name} + ${long.name}`);
  // שעות הפעילות 09:00-17:00 – טיפול של 130 דקות יכול להתחיל לכל היותר ב-14:50
  const free = slots.data.slots.filter((s) => s.status === 'free');
  assert.equal(free[free.length - 1].time, '14:45');

  const book = await srv.req('POST', '/api/book', {
    body: {
      serviceIds: [short.id, long.id], date, time: '10:00',
      fullName: 'רונית אלון', phone: '0541230000', acceptTerms: true,
    },
  });
  assert.equal(book.status, 201);
  const appt = book.data.appointment;
  assert.equal(appt.startTime, '10:00');
  assert.equal(appt.endTime, '12:10', 'שעת הסיום לפי סכום הטיפולים');
  assert.equal(appt.services.length, 2);
  assert.deepEqual(appt.services.map((s) => s.name), [short.name, long.name]);

  // כל הטווח נחסם ללקוחות אחרות
  const after = await srv.req('GET', `/api/slots?service_id=${short.id}&date=${date}`);
  const byTime = Object.fromEntries(after.data.slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['10:00'], 'taken');
  assert.equal(byTime['11:30'], 'taken');
  assert.equal(byTime['12:00'], 'taken');
  assert.equal(byTime['12:15'], 'free');
});

test('בחירת אותו טיפול פעמיים או מזהה שגוי נדחית בעברית', async () => {
  const date = futureDate(T, { weekday: 0, minDays: 25 });
  const bad = await srv.req('GET', `/api/slots?service_ids=99999&date=${date}`);
  assert.equal(bad.status, 404);
  assert.match(bad.data.error, /לא נמצא/);

  const empty = await srv.req('GET', `/api/slots?service_ids=&date=${date}`);
  assert.equal(empty.status, 400);
  assert.match(empty.data.error, /לפחות טיפול אחד/);

  // כפילות מנוטרלת ואינה מכפילה את משך הטיפול
  const dup = await srv.req('GET', `/api/slots?service_ids=${short.id},${short.id}&date=${date}`);
  assert.equal(dup.data.durationMin, short.duration_min);
});

test('כמות הטיפולים בתור אחד מוגבלת לפי ההגדרה', async () => {
  db.setSetting('max_services_per_booking', '2');
  const date = futureDate(T, { weekday: 0, minDays: 25 });
  const extra = db.get().prepare(
    "INSERT INTO services (name, duration_min, buffer_min) VALUES ('עיצוב גבות', 20, 0)"
  ).run();
  const res = await srv.req('GET', `/api/slots?service_ids=${short.id},${long.id},${Number(extra.lastInsertRowid)}&date=${date}`);
  assert.equal(res.status, 400);
  assert.match(res.data.error, /עד 2 טיפולים/);
  db.setSetting('max_services_per_booking', '4');
});

test('מחירים אינם מוצגים ללקוחה כשההגדרה כבויה', async () => {
  db.setSetting('show_prices', '0');
  const config = await srv.req('GET', '/api/config');
  assert.equal(config.data.showPrices, false);

  const services = await srv.req('GET', '/api/services');
  assert.ok(services.data.services.every((s) => s.price === null), 'אין מחיר בכרטיסי הטיפולים');
  assert.ok(!JSON.stringify(services.data).includes('260'), 'סכום המחיר אינו נשלח ללקוחה');

  const book = await srv.req('POST', '/api/book', {
    body: {
      serviceId: short.id, date: futureDate(T, { weekday: 5, minDays: 25 }), time: '10:00',
      fullName: 'שני מור', phone: '0543219876', acceptTerms: true,
    },
  });
  assert.equal(book.status, 201);
  assert.equal(book.data.appointment.price, null, 'אין מחיר באישור התור');

  const info = await srv.req('GET', `/api/appointment/${book.data.appointment.manageToken}`);
  assert.equal(info.data.appointment.price, null);

  // המחיר עדיין זמין למנהלים לצורך דוחות פנימיים
  const admin = await srv.req('GET', `/api/admin/appointments?q=שני מור`, { cookie: adminCookie });
  assert.equal(admin.data.appointments[0].price, short.price);
});

test('ניתן להחזיר הצגת מחירים מההגדרות בלי שינוי קוד', async () => {
  db.setSetting('show_prices', '1');
  const services = await srv.req('GET', '/api/services');
  assert.ok(services.data.services.some((s) => s.price !== null));
  db.setSetting('show_prices', '0');
});
