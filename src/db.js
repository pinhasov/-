'use strict';
/** שכבת מסד הנתונים – SQLite מובנה של Node (ללא תלויות חיצוניות). */

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'lola.db');

let db = null;
let existedAtBoot = null;   // האם קובץ מסד הנתונים היה קיים לפני עליית השרת

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- משתמשים מנהלים
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  username      TEXT    NOT NULL UNIQUE,
  phone         TEXT,
  email         TEXT,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'admin',   -- admin | owner
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- לקוחות
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name  TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,
  email      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- טיפולים
CREATE TABLE IF NOT EXISTS services (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  description       TEXT    DEFAULT '',
  duration_min      INTEGER NOT NULL,
  price             REAL,
  buffer_min        INTEGER NOT NULL DEFAULT 0,   -- זמן מעבר אחרי הטיפול
  image_url         TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  bookable_online   INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  deposit_type      TEXT    NOT NULL DEFAULT 'none', -- none | fixed | percent | full
  deposit_value     REAL    NOT NULL DEFAULT 0,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- תורים
CREATE TABLE IF NOT EXISTS appointments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  service_id     INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name   TEXT    NOT NULL,
  date           TEXT    NOT NULL,          -- YYYY-MM-DD
  start_time     TEXT    NOT NULL,          -- HH:MM
  end_time       TEXT    NOT NULL,          -- HH:MM (ללא זמן מעבר)
  buffer_min     INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'confirmed',
  price          REAL,
  deposit_amount REAL    NOT NULL DEFAULT 0,
  customer_note  TEXT,
  internal_note  TEXT,
  first_visit    INTEGER NOT NULL DEFAULT 0,
  sensitivities  TEXT,
  manage_token   TEXT    NOT NULL UNIQUE,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  created_by     TEXT    NOT NULL DEFAULT 'customer',  -- customer | admin:<name>
  updated_at     TEXT,
  cancelled_at   TEXT,
  cancelled_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_appt_date   ON appointments(date, start_time);
CREATE INDEX IF NOT EXISTS idx_appt_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appt_cust   ON appointments(customer_id);

-- הטיפולים שנבחרו לתור (ניתן לבחור כמה טיפולים בתור אחד)
CREATE TABLE IF NOT EXISTS appointment_services (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id     INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name   TEXT    NOT NULL,
  duration_min   INTEGER NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_appt_svc ON appointment_services(appointment_id);

-- שעות פעילות קבועות (ניתן להגדיר כמה טווחים ליום – הפסקה = פער בין טווחים)
CREATE TABLE IF NOT EXISTS working_hours (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday    INTEGER NOT NULL,   -- 0=ראשון ... 6=שבת
  start_time TEXT    NOT NULL,
  end_time   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wh_weekday ON working_hours(weekday);

-- חריגים: חסימות, חופשות ופתיחת שעות נוספות
CREATE TABLE IF NOT EXISTS exceptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,               -- YYYY-MM-DD
  end_date   TEXT,                           -- לטווח תאריכים (חופשה)
  start_time TEXT,                           -- NULL = כל היום
  end_time   TEXT,
  type       TEXT    NOT NULL,               -- block | open | vacation
  reason     TEXT,
  recurring  INTEGER NOT NULL DEFAULT 0,     -- 1 = חוזר כל שבוע באותו יום
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exc_date ON exceptions(date);

-- רשימת המתנה
CREATE TABLE IF NOT EXISTS waitlist (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name    TEXT NOT NULL,
  phone        TEXT NOT NULL,
  service_id   INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT,
  desired_date TEXT NOT NULL,
  time_from    TEXT,
  time_to      TEXT,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'waiting', -- waiting | contacted | booked | closed
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- הגדרות כלליות
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- תיעוד פעולות ניהול
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER,
  admin_name TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const DEFAULT_SETTINGS = {
  business_name: 'לולה פדיקור',
  page_title: 'קביעת תור אצל לולה',
  intro_text: 'ברוכה הבאה למערכת קביעת התורים של לולה. בחרי את הטיפול הרצוי, את היום המתאים לך ואת אחת השעות הפנויות.',
  address: '',
  phone: '',
  whatsapp: '',
  logo_url: '',
  slot_step_min: '15',           // צפיפות רשת השעות המוצגת
  min_lead_hours: '2',           // זמן מינימלי להזמנה מראש
  max_advance_days: '90',        // עד כמה קדימה היומן פתוח
  cancel_cutoff_hours: '24',     // עד מתי מותר לבטל/לשנות
  auto_approve: '1',             // 1 = תור מאושר אוטומטית
  show_prices: '0',              // הצגת מחירים ללקוחה – כבוי (אין מחירון)
  max_services_per_booking: '4', // כמה טיפולים ניתן לבחור בתור אחד
  payments_enabled: '0',         // מקדמות/תשלום – כבוי בשלב ראשון
  waitlist_enabled: '1',
  cancellation_policy: 'ניתן לבטל או לשנות את התור עד 24 שעות לפני מועד הטיפול. לביטול בהתראה קצרה יותר יש ליצור קשר טלפוני עם לולה.',
  terms_text: 'הפרטים שנמסרים משמשים אך ורק לצורך ניהול התור ויצירת קשר. אין העברת פרטים לצד שלישי.',
  privacy_text: 'המערכת שומרת שם, טלפון והערות הנוגעות לטיפול בלבד. ניתן לבקש מחיקת פרטים בכל עת.',
};

function open(dbPath = DB_PATH) {
  if (db) return db;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (existedAtBoot === null) existedAtBoot = fs.existsSync(dbPath);
  db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  ensureDefaults();
  return db;
}

function get() {
  if (!db) open();
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

/** האם מסד הנתונים כבר היה קיים בעליית השרת (בדיקת שמירת נתונים) */
function wasExisting() {
  return existedAtBoot === true;
}

function ensureDefaults() {
  const stmt = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) stmt.run(k, v);

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM working_hours').get();
  if (c === 0) {
    const ins = db.prepare('INSERT INTO working_hours (weekday, start_time, end_time) VALUES (?, ?, ?)');
    // ברירת מחדל: ראשון–חמישי 09:00–18:00, שישי 09:00–13:00, שבת סגור
    for (const wd of [0, 1, 2, 3, 4]) ins.run(wd, '09:00', '18:00');
    ins.run(5, '09:00', '13:00');
  }
}

function settings() {
  const rows = get().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

function setting(key, fallback = null) {
  const row = get().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function settingInt(key, fallback = 0) {
  const v = setting(key);
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function settingBool(key, fallback = false) {
  const v = setting(key);
  if (v === null || v === undefined) return fallback;
  return v === '1' || v === 'true';
}

function setSetting(key, value) {
  get().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value === null || value === undefined ? '' : String(value));
}

function audit(admin, action, entity, entityId, details) {
  try {
    get().prepare('INSERT INTO audit_log (admin_id, admin_name, action, entity, entity_id, details) VALUES (?,?,?,?,?,?)')
      .run(admin?.id ?? null, admin?.name ?? 'מערכת', action, entity ?? null,
        entityId === undefined || entityId === null ? null : String(entityId),
        details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null);
  } catch { /* תיעוד לא אמור להפיל פעולה */ }
}

module.exports = {
  DB_PATH, DATA_DIR, DEFAULT_SETTINGS,
  open, get, close, wasExisting, settings, setting, settingInt, settingBool, setSetting, audit,
};
