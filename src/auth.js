'use strict';
/** אימות מנהלים: סיסמאות מוצפנות (scrypt) + הפעלות (sessions) בעוגייה מאובטחת. */

const crypto = require('node:crypto');
const db = require('./db');

const SESSION_COOKIE = 'lola_admin';
const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function createSession(adminId) {
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  db.get().prepare('INSERT INTO sessions (token, admin_id, expires_at) VALUES (?,?,?)').run(token, adminId, expires);
  return { token, expires };
}

function destroySession(token) {
  if (!token) return;
  db.get().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function purgeExpired() {
  db.get().prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** מחזיר את המנהל המחובר לפי העוגייה, או null */
function currentAdmin(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const row = db.get().prepare(
    `SELECT a.id, a.name, a.username, a.role, a.active, s.token
       FROM sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).get(token);
  if (!row || !row.active) return null;
  return row;
}

function login(username, password) {
  const admin = db.get().prepare('SELECT * FROM admins WHERE username = ? AND active = 1').get(String(username || '').trim().toLowerCase());
  if (!admin) return null;
  if (!verifyPassword(password, admin.password_hash)) return null;
  return admin;
}

function sessionCookie(token, expires, secure) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function createAdmin({ name, username, password, phone, email, role = 'admin' }) {
  const stmt = db.get().prepare(
    'INSERT INTO admins (name, username, phone, email, password_hash, role) VALUES (?,?,?,?,?,?)'
  );
  const info = stmt.run(name, String(username).trim().toLowerCase(), phone || null, email || null, hashPassword(password), role);
  return Number(info.lastInsertRowid);
}

module.exports = {
  SESSION_COOKIE, hashPassword, verifyPassword, randomToken, createSession, destroySession,
  purgeExpired, parseCookies, currentAdmin, login, sessionCookie, clearCookie, createAdmin,
};
