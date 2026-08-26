'use strict';
/** בדיקות מנוע הזמינות (סעיפים 5–8 באפיון) */

const test = require('node:test');
const assert = require('node:assert');
const { useTempDb, resetSchedule, addService, futureDate } = require('./helpers');

useTempDb('availability');
const db = require('../src/db');
const T = require('../src/time');
const av = require('../src/availability');
const bk = require('../src/bookings');

db.open();

function setup(opts) {
  resetSchedule(db, opts);
  db.setSetting('slot_step_min', '15');
  db.setSetting('min_lead_hours', '0');
  db.setSetting('max_advance_days', '90');
  db.setSetting('auto_approve', '1');
}

test('שעות מוצגות לפי שעות הפעילות ומשך הטיפול', () => {
  setup({ open: '09:00', close: '12:00' });
  const service = addService(db, { name: 'קצר', duration: 60 });
  const date = futureDate(T);
  const day = av.daySlots(date, service);
  assert.equal(day.open, true);
  assert.equal(day.slots[0].time, '09:00');
  // הטיפול חייב להסתיים עד 12:00 ולכן השעה האחרונה היא 11:00
  assert.equal(day.slots[day.slots.length - 1].time, '11:00');
  assert.ok(day.slots.every((s) => s.status === 'free'));
});

test('טיפול ארוך אינו מוצג כשאין די זמן עד סגירה', () => {
  setup({ open: '09:00', close: '11:00' });
  const long = addService(db, { name: 'ארוך', duration: 90 });
  const date = futureDate(T);
  const day = av.daySlots(date, long);
  assert.equal(day.slots[day.slots.length - 1].time, '09:30');
});

test('טיפול של 90 דקות אינו מוצג כשקיימות רק 60 דקות עד התור הבא', () => {
  setup({ open: '09:00', close: '17:00' });
  const short = addService(db, { name: 'רגיל', duration: 60 });
  const long = addService(db, { name: 'מורחב', duration: 90 });
  const date = futureDate(T);

  bk.createAppointment({
    serviceId: short.id, date, time: '11:00', fullName: 'לקוחה א', phone: '0501111111', createdBy: 'test',
  });

  const day = av.daySlots(date, long);
  const byTime = Object.fromEntries(day.slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['09:45'], 'taken', 'טיפול שיסתיים אחרי 11:00 אינו זמין');
  assert.equal(byTime['10:30'], 'taken');
  assert.equal(byTime['09:30'], 'free', 'טיפול שמסתיים בדיוק ב-11:00 זמין');
  assert.equal(byTime['12:00'], 'free', 'לאחר סיום התור הקיים השעה פנויה');
});

test('זמן מעבר בין טיפולים נשמר', () => {
  setup({ open: '09:00', close: '17:00' });
  const service = addService(db, { name: 'עם מעבר', duration: 60, buffer: 15 });
  const date = futureDate(T);
  bk.createAppointment({
    serviceId: service.id, date, time: '10:00', fullName: 'לקוחה ב', phone: '0502222222', createdBy: 'test',
  });
  const byTime = Object.fromEntries(av.daySlots(date, service).slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['11:00'], 'taken', 'אין להתחיל מיד בסיום – נדרש זמן מעבר');
  assert.equal(byTime['11:15'], 'free');
  assert.equal(byTime['08:45'], undefined);
  assert.equal(byTime['09:00'], 'taken', 'טיפול שיגלוש לתוך התור הקיים אינו זמין');
});

test('לא ניתן לקבוע שני תורים חופפים', () => {
  setup();
  const service = addService(db, { name: 'חופף', duration: 60 });
  const date = futureDate(T);
  bk.createAppointment({ serviceId: service.id, date, time: '10:00', fullName: 'לקוחה א', phone: '0503333333' });
  assert.throws(
    () => bk.createAppointment({ serviceId: service.id, date, time: '10:30', fullName: 'לקוחה ב', phone: '0504444444' }),
    /נתפסה|אינה זמינה/,
  );
  assert.throws(
    () => bk.createAppointment({ serviceId: service.id, date, time: '09:30', fullName: 'לקוחה ג', phone: '0505555555' }),
    /נתפסה|אינה זמינה/,
  );
});

test('חסימת יום שלם מונעת קביעת תורים', () => {
  setup();
  const service = addService(db, { name: 'חסום', duration: 60 });
  const date = futureDate(T);
  db.get().prepare("INSERT INTO exceptions (date, type, reason) VALUES (?, 'block', ?)").run(date, 'אירוע');
  const day = av.daySlots(date, service);
  assert.equal(day.freeCount, 0);
  assert.ok(day.slots.every((s) => s.status === 'blocked'));
  assert.throws(() => bk.createAppointment({ serviceId: service.id, date, time: '10:00', fullName: 'לקוחה ד', phone: '0506666666' }), /חסומה|אינה זמינה/);
});

test('חסימת שעות בודדות משאירה את שאר היום פנוי', () => {
  setup({ open: '09:00', close: '17:00' });
  const service = addService(db, { name: 'הפסקה', duration: 60 });
  const date = futureDate(T);
  db.get().prepare("INSERT INTO exceptions (date, start_time, end_time, type, reason) VALUES (?,?,?, 'block', ?)")
    .run(date, '12:00', '13:00', 'הפסקת צהריים');
  const byTime = Object.fromEntries(av.daySlots(date, service).slots.map((s) => [s.time, s.status]));
  assert.equal(byTime['12:00'], 'blocked');
  assert.equal(byTime['11:30'], 'blocked');
  assert.equal(byTime['11:00'], 'free');
  assert.equal(byTime['13:00'], 'free');
});

test('חופשה סוגרת טווח תאריכים', () => {
  setup();
  const service = addService(db, { name: 'חופשה', duration: 60 });
  const start = futureDate(T);
  const end = T.addDays(start, 3);
  db.get().prepare("INSERT INTO exceptions (date, end_date, type, reason) VALUES (?,?, 'vacation', ?)")
    .run(start, end, 'חופשה משפחתית');
  for (const d of [start, T.addDays(start, 2), end]) {
    const day = av.daySlots(d, service);
    assert.equal(day.open, false, `${d} אמור להיות סגור`);
  }
  assert.equal(av.daySlots(T.addDays(end, 1), service).open, true);
});

test('פתיחת שעות חריגה ביום שבדרך כלל סגור', () => {
  setup({ days: [0, 1, 2, 3, 4] });   // שבת וששי סגורים
  const service = addService(db, { name: 'חריג', duration: 60 });
  let date = T.addDays(T.todayISO(), 8);
  while (T.weekdayOf(date) !== 6) date = T.addDays(date, 1);
  assert.equal(av.daySlots(date, service).open, false);
  db.get().prepare("INSERT INTO exceptions (date, start_time, end_time, type) VALUES (?,?,?, 'open')")
    .run(date, '10:00', '14:00');
  const day = av.daySlots(date, service);
  assert.equal(day.open, true);
  assert.equal(day.slots[0].time, '10:00');
  assert.equal(day.slots[day.slots.length - 1].time, '13:00');
});

test('ימים בעבר ותאריכים רחוקים מדי אינם זמינים', () => {
  setup();
  const service = addService(db, { name: 'טווח', duration: 60 });
  const yesterday = T.addDays(T.todayISO(), -1);
  assert.equal(av.dayStatus(yesterday, service).status, 'past');
  db.setSetting('max_advance_days', '30');
  assert.equal(av.dayStatus(T.addDays(T.todayISO(), 45), service).status, 'locked');
  db.setSetting('max_advance_days', '90');
});

test('זמן מינימלי להזמנה מראש נאכף', () => {
  setup({ open: '00:00', close: '23:45' });
  db.setSetting('min_lead_hours', '48');
  const service = addService(db, { name: 'מראש', duration: 30 });
  const soon = T.addDays(T.todayISO(), 1);
  const day = av.daySlots(soon, service);
  assert.ok(day.slots.every((s) => s.status === 'past'), 'כל השעות מחר חסומות בגלל דרישת 48 שעות מראש');
  const check = av.checkSlot(soon, '10:00', service);
  assert.equal(check.ok, false);
  db.setSetting('min_lead_hours', '0');
});

test('לוח החודש מסמן ימים פנויים, מלאים וסגורים', () => {
  setup({ open: '09:00', close: '10:00', days: [0, 1, 2, 3, 4] });
  const service = addService(db, { name: 'חודשי', duration: 60 });
  const date = futureDate(T, { weekday: 1, minDays: 8 });
  bk.createAppointment({ serviceId: service.id, date, time: '09:00', fullName: 'לקוחה ה', phone: '0507777777' });

  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const view = av.monthView(y, m, service);
  assert.equal(view.days.length, T.daysInMonth(y, m));
  const full = view.days.find((d) => d.date === date);
  assert.equal(full.status, 'full');
  const saturday = view.days.find((d) => T.weekdayOf(d.date) === 6 && T.diffDays(T.todayISO(), d.date) > 0);
  if (saturday) assert.equal(saturday.status, 'closed');
});

test('ביטול תור מחזיר את השעה לזמינות', () => {
  setup();
  const service = addService(db, { name: 'ביטול', duration: 60 });
  const date = futureDate(T);
  const appt = bk.createAppointment({ serviceId: service.id, date, time: '10:00', fullName: 'לקוחה ו', phone: '0508888888' });
  assert.equal(av.checkSlot(date, '10:00', service).ok, false);
  bk.cancelAppointment(appt.id, { byAdmin: true, admin: { id: 1, name: 'לולה' } });
  assert.equal(av.checkSlot(date, '10:00', service).ok, true);
});

test('הפסקה באמצע היום מוגדרת בעזרת שני טווחי פעילות', () => {
  resetSchedule(db, { days: [] });
  const d = db.get();
  const date = futureDate(T, { weekday: 3 });
  const wd = T.weekdayOf(date);
  d.prepare('INSERT INTO working_hours (weekday, start_time, end_time) VALUES (?,?,?)').run(wd, '09:00', '12:00');
  d.prepare('INSERT INTO working_hours (weekday, start_time, end_time) VALUES (?,?,?)').run(wd, '16:00', '19:00');
  const service = addService(db, { name: 'מפוצל', duration: 60 });
  const times = av.daySlots(date, service).slots.map((s) => s.time);
  assert.ok(times.includes('11:00'));
  assert.ok(!times.includes('12:00'));
  assert.ok(!times.includes('14:00'));
  assert.ok(times.includes('16:00'));
  assert.ok(times.includes('18:00'));
});
