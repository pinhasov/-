'use strict';
/**
 * גיבוי מסד הנתונים (סעיף 20 – גיבוי תקופתי).
 * הרצה: node scripts/backup.js [תיקיית יעד]
 * מומלץ להריץ אוטומטית פעם ביום, לדוגמה ב-cron:
 *   0 2 * * *  cd /opt/lola && node scripts/backup.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lola.db');
const OUT_DIR = process.argv[2] || process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP = Number(process.env.BACKUP_KEEP || 30);

function run() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`מסד הנתונים לא נמצא: ${DB_PATH}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(OUT_DIR, `lola-${stamp}.db`);

  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  console.log(`נוצר גיבוי: ${target}`);

  // שמירת מספר מוגבל של גיבויים
  const files = fs.readdirSync(OUT_DIR).filter((f) => /^lola-.*\.db$/.test(f)).sort();
  while (files.length > KEEP) {
    const old = files.shift();
    fs.unlinkSync(path.join(OUT_DIR, old));
    console.log(`נמחק גיבוי ישן: ${old}`);
  }
}

if (require.main === module) run();
module.exports = { run };
