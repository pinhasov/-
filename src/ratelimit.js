'use strict';
/** הגבלת קצב פשוטה בזיכרון – הגנה בסיסית מפני שימוש לרעה בטפסים הציבוריים. */

const buckets = new Map();

function clientKey(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket?.remoteAddress || 'unknown';
}

/** @returns {boolean} true אם הבקשה מותרת */
function allow(req, name, { limit = 20, windowMs = 60000 } = {}) {
  const key = `${name}:${clientKey(req)}`;
  const now = Date.now();
  const entry = buckets.get(key);
  if (!entry || now > entry.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  entry.count++;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
  }
  return entry.count <= limit;
}

function reset() { buckets.clear(); }

module.exports = { allow, reset, clientKey };
