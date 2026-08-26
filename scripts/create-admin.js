'use strict';
/**
 * יצירת משתמש ניהול נוסף או איפוס סיסמה.
 * דוגמה: node scripts/create-admin.js --name "לולה" --username lola --password "Sod12345"
 *        node scripts/create-admin.js --username avi --reset-password "Sod12345"
 */

const db = require('../src/db');
const auth = require('../src/auth');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    out[key] = val;
  }
  return out;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  db.open();
  const username = String(args.username || '').trim().toLowerCase();
  if (!username) {
    console.error('חסר --username');
    process.exit(1);
  }
  const existing = db.get().prepare('SELECT * FROM admins WHERE username = ?').get(username);

  if (args['reset-password']) {
    if (!existing) { console.error('המשתמש לא נמצא'); process.exit(1); }
    if (String(args['reset-password']).length < 8) { console.error('הסיסמה חייבת להכיל לפחות 8 תווים'); process.exit(1); }
    db.get().prepare('UPDATE admins SET password_hash = ? WHERE id = ?')
      .run(auth.hashPassword(args['reset-password']), existing.id);
    console.log(`הסיסמה של "${username}" עודכנה.`);
    db.close();
    return;
  }

  if (existing) { console.error('שם המשתמש כבר קיים'); process.exit(1); }
  if (!args.password || String(args.password).length < 8) {
    console.error('חסרה --password באורך 8 תווים לפחות');
    process.exit(1);
  }
  const id = auth.createAdmin({
    name: args.name || username,
    username,
    password: args.password,
    phone: args.phone,
    email: args.email,
    role: args.role === 'owner' ? 'owner' : 'admin',
  });
  console.log(`נוצר משתמש ניהול #${id}: ${username}`);
  db.close();
}

if (require.main === module) run();
