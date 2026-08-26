'use strict';
/**
 * הקמת נתוני התחלה: טיפולים ראשוניים ושני משתמשי ניהול (לולה ואבי).
 * הרצה: npm run seed
 * ניתן לקבוע סיסמאות מראש: LOLA_PASSWORD=... AVI_PASSWORD=... npm run seed
 */

const crypto = require('node:crypto');
const db = require('../src/db');
const auth = require('../src/auth');

const SERVICES = [
  { name: 'פדיקור', description: 'טיפול פדיקור מלא כולל עיצוב וטיפוח', duration_min: 60, price: 180, buffer_min: 10, sort_order: 1 },
  { name: 'מניקור', description: 'טיפול ידיים, עיצוב וטיפוח ציפורניים', duration_min: 45, price: 140, buffer_min: 10, sort_order: 2 },
  { name: 'בניית ציפורניים', description: 'בנייה בג\'ל או אקריל, כולל עיצוב', duration_min: 90, price: 260, buffer_min: 15, sort_order: 3 },
  { name: 'לק ג\'ל', description: 'לק ג\'ל עמיד כולל הסרה', duration_min: 40, price: 120, buffer_min: 10, sort_order: 4 },
  { name: 'טיפול פנים', description: 'ניקוי עמוק והזנה לפי סוג העור', duration_min: 60, price: 220, buffer_min: 15, sort_order: 5 },
  { name: 'עיצוב גבות', description: 'עיצוב גבות מדויק', duration_min: 20, price: 60, buffer_min: 5, sort_order: 6 },
  { name: 'שעווה', description: 'הסרת שיער בשעווה', duration_min: 30, price: 90, buffer_min: 10, sort_order: 7 },
];

function randomPassword() {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (const b of crypto.randomBytes(14)) out += alphabet[b % alphabet.length];
  return out;
}

function run({ keepOpen = false } = {}) {
  db.open();
  const d = db.get();

  const { c: serviceCount } = d.prepare('SELECT COUNT(*) AS c FROM services').get();
  if (serviceCount === 0) {
    const ins = d.prepare(
      `INSERT INTO services (name, description, duration_min, price, buffer_min, sort_order)
       VALUES (?,?,?,?,?,?)`
    );
    for (const s of SERVICES) ins.run(s.name, s.description, s.duration_min, s.price, s.buffer_min, s.sort_order);
    console.log(`נוספו ${SERVICES.length} טיפולים.`);
  } else {
    console.log('קיימים טיפולים במערכת – לא בוצע שינוי.');
  }

  const created = [];
  for (const person of [
    { name: 'לולה', username: 'lola', role: 'owner', envKey: 'LOLA_PASSWORD' },
    { name: 'אבי', username: 'avi', role: 'admin', envKey: 'AVI_PASSWORD' },
  ]) {
    const exists = d.prepare('SELECT id FROM admins WHERE username = ?').get(person.username);
    if (exists) { console.log(`משתמש הניהול "${person.username}" כבר קיים.`); continue; }
    const password = process.env[person.envKey] || randomPassword();
    auth.createAdmin({ name: person.name, username: person.username, password, role: person.role });
    created.push({ ...person, password, generated: !process.env[person.envKey] });
  }

  if (created.length) {
    console.log('\n=== פרטי גישה למערכת הניהול ===');
    for (const c of created) {
      // סיסמה שהוגדרה מראש במשתני הסביבה אינה מודפסת ללוג
      const shown = c.generated ? `סיסמה: ${c.password}  (נוצרה אקראית)` : 'סיסמה: לפי משתנה הסביבה שהוגדר';
      console.log(`  ${c.name}: שם משתמש "${c.username}" | ${shown}`);
    }
    console.log('יש לשמור את הפרטים במקום בטוח ולהחליף סיסמה לאחר ההתחברות הראשונה.\n');
  }
  if (!keepOpen) db.close();
}

if (require.main === module) run();
module.exports = { run, SERVICES };
