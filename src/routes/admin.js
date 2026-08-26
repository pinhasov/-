'use strict';
/** ה-API של מערכת הניהול – ללולה ולאבי בלבד (סעיף 13). */

const db = require('../db');
const T = require('../time');
const av = require('../availability');
const bk = require('../bookings');
const auth = require('../auth');
const rl = require('../ratelimit');
const { toCSV } = require('../csv');
const { sendJSON, fail, readJSON, send } = require('../http');

const SETTABLE_SETTINGS = new Set([
  'business_name', 'page_title', 'intro_text', 'address', 'phone', 'whatsapp', 'logo_url',
  'slot_step_min', 'min_lead_hours', 'max_advance_days', 'cancel_cutoff_hours', 'auto_approve',
  'payments_enabled', 'waitlist_enabled', 'show_prices', 'max_services_per_booking',
  'cancellation_policy', 'terms_text', 'privacy_text',
  'public_base_url',
]);

function requireAdmin(req, res) {
  const admin = auth.currentAdmin(req);
  if (!admin) { fail(res, 401, 'נדרשת התחברות למערכת הניהול'); return null; }
  return admin;
}

/** הגנה נוספת מפני בקשות חוצות אתרים: כל פעולה משנה מחייבת כותרת ייעודית */
function checkOrigin(req, res) {
  if (req.headers['x-requested-with'] !== 'lola-admin') {
    fail(res, 403, 'בקשה לא מורשית');
    return false;
  }
  return true;
}

function adminView(a) {
  return {
    id: a.id,
    customerId: a.customer_id,
    customerName: a.customer_name || '(חסימה)',
    customerPhone: a.customer_phone || '',
    customerEmail: a.customer_email || '',
    serviceId: a.service_id,
    serviceIds: (a.services || []).map((s) => s.service_id).filter(Boolean),
    services: (a.services || []).map((s) => ({ name: s.service_name, durationMin: s.duration_min })),
    service: a.service_name,
    date: a.date,
    dateIL: T.formatIL(a.date),
    dayName: T.dayName(a.date),
    startTime: a.start_time,
    endTime: a.end_time,
    durationMin: T.toMinutes(a.end_time) - T.toMinutes(a.start_time),
    bufferMin: a.buffer_min,
    status: a.status,
    statusLabel: bk.STATUS_LABELS[a.status] || a.status,
    price: a.price,
    depositAmount: a.deposit_amount,
    note: a.customer_note || '',
    internalNote: a.internal_note || '',
    firstVisit: !!a.first_visit,
    sensitivities: a.sensitivities || '',
    createdAt: a.created_at,
    createdBy: a.created_by,
    cancelledAt: a.cancelled_at,
    cancelledBy: a.cancelled_by,
    manageToken: a.manage_token,
  };
}

function listAppointments({ from, to, status, q }) {
  const where = [];
  const args = [];
  if (from) { where.push('a.date >= ?'); args.push(from); }
  if (to) { where.push('a.date <= ?'); args.push(to); }
  if (status && status !== 'all') {
    if (status === 'active') where.push("a.status IN ('pending','confirmed')");
    else if (status === 'cancelled') where.push("a.status IN ('cancelled_customer','cancelled_admin')");
    else { where.push('a.status = ?'); args.push(status); }
  }
  if (q) {
    where.push('(c.full_name LIKE ? OR c.phone LIKE ? OR a.service_name LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like);
  }
  const sql = `SELECT a.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
                 FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY a.date, a.start_time`;
  const rows = db.get().prepare(sql).all(...args);
  return attachServices(rows);
}

/** מצרף לכל תור את רשימת הטיפולים שנבחרו – בשאילתה אחת */
function attachServices(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const links = db.get().prepare(
    `SELECT appointment_id, service_id, service_name, duration_min
       FROM appointment_services
      WHERE appointment_id IN (${ids.map(() => '?').join(',')})
      ORDER BY sort_order, id`
  ).all(...ids);
  const byAppt = new Map();
  for (const l of links) {
    if (!byAppt.has(l.appointment_id)) byAppt.set(l.appointment_id, []);
    byAppt.get(l.appointment_id).push(l);
  }
  for (const row of rows) {
    row.services = byAppt.get(row.id) || [{
      service_id: row.service_id,
      service_name: row.service_name,
      duration_min: T.toMinutes(row.end_time) - T.toMinutes(row.start_time),
    }];
  }
  return rows;
}

function register(router) {
  // ---------- התחברות ----------
  router.post('/api/admin/login', async (req, res) => {
    if (!rl.allow(req, 'login', { limit: 10, windowMs: 15 * 60000 })) {
      return fail(res, 429, 'בוצעו יותר מדי ניסיונות התחברות. יש להמתין מספר דקות.');
    }
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const admin = auth.login(body.username, body.password);
    if (!admin) return fail(res, 401, 'שם המשתמש או הסיסמה שגויים');
    auth.purgeExpired();
    const { token, expires } = auth.createSession(admin.id);
    db.audit(admin, 'login', 'admin', admin.id, null);
    const secure = String(req.headers['x-forwarded-proto'] || '').includes('https');
    sendJSON(res, 200, { ok: true, admin: { id: admin.id, name: admin.name, username: admin.username, role: admin.role } },
      { 'Set-Cookie': auth.sessionCookie(token, expires, secure) });
  });

  router.post('/api/admin/logout', (req, res) => {
    const admin = auth.currentAdmin(req);
    if (admin) auth.destroySession(admin.token);
    sendJSON(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  });

  router.get('/api/admin/me', (req, res) => {
    const admin = auth.currentAdmin(req);
    if (!admin) return fail(res, 401, 'לא מחובר');
    sendJSON(res, 200, { ok: true, admin: { id: admin.id, name: admin.name, username: admin.username, role: admin.role } });
  });

  router.post('/api/admin/password', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const row = db.get().prepare('SELECT * FROM admins WHERE id = ?').get(admin.id);
    if (!auth.verifyPassword(body.currentPassword, row.password_hash)) {
      return fail(res, 403, 'הסיסמה הנוכחית שגויה');
    }
    if (String(body.newPassword || '').length < 8) return fail(res, 400, 'הסיסמה החדשה חייבת להכיל לפחות 8 תווים');
    db.get().prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(auth.hashPassword(body.newPassword), admin.id);
    db.audit(admin, 'change_password', 'admin', admin.id, null);
    sendJSON(res, 200, { ok: true, message: 'הסיסמה עודכנה' });
  });

  // ---------- תורים ----------
  router.get('/api/admin/appointments', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const rows = listAppointments({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      status: url.searchParams.get('status'),
      q: url.searchParams.get('q'),
    });
    sendJSON(res, 200, { ok: true, appointments: rows.map(adminView) });
  });

  /** תצוגת יום: התורים של היום + שעות הפעילות והחסימות */
  router.get('/api/admin/day', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const date = url.searchParams.get('date') || T.todayISO();
    if (!T.isValidISO(date)) return fail(res, 400, 'תאריך לא תקין');
    const ctx = av.loadContext(date, date);
    const { windows, closedReason } = av.openWindows(date, ctx);
    sendJSON(res, 200, {
      ok: true,
      date, dateIL: T.formatIL(date), dayName: T.dayName(date),
      open: windows.length > 0,
      closedReason,
      windows: windows.map((w) => ({ start: T.toHHMM(w.start), end: T.toHHMM(w.end) })),
      blocked: av.blockedRanges(date, ctx).map((b) => ({ start: T.toHHMM(b.start), end: T.toHHMM(b.end) })),
      appointments: listAppointments({ from: date, to: date }).map(adminView),
    });
  });

  /** תצוגת חודש למנהלים – ספירת תורים לכל יום */
  router.get('/api/admin/month', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const today = T.todayISO();
    const year = Number(url.searchParams.get('year')) || Number(today.slice(0, 4));
    const month = Number(url.searchParams.get('month')) || Number(today.slice(5, 7));
    if (year < 2000 || year > 2100 || month < 1 || month > 12) return fail(res, 400, 'תאריך לא תקין');
    const first = T.isoOf(year, month, 1);
    const last = T.isoOf(year, month, T.daysInMonth(year, month));
    const ctx = av.loadContext(first, last);
    const rows = listAppointments({ from: first, to: last, status: 'active' });
    const counts = new Map();
    for (const r of rows) counts.set(r.date, (counts.get(r.date) || 0) + 1);
    const days = [];
    for (let d = 1; d <= T.daysInMonth(year, month); d++) {
      const date = T.isoOf(year, month, d);
      const { windows, closedReason } = av.openWindows(date, ctx);
      days.push({ date, count: counts.get(date) || 0, open: windows.length > 0, closedReason });
    }
    sendJSON(res, 200, {
      ok: true, year, month, monthName: T.monthName(month),
      firstWeekday: T.weekdayOf(first), daysInMonth: T.daysInMonth(year, month), days, today,
    });
  });

  /** הוספת תור ידנית (כולל חסימה אישית ללא פרטי לקוחה) */
  router.post('/api/admin/appointments', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    try {
      const appt = bk.createAppointment({
        serviceId: body.serviceId,
        serviceIds: body.serviceIds,
        date: body.date,
        time: body.time,
        fullName: body.fullName,
        phone: body.phone,
        email: body.email,
        note: body.note,
        internalNote: body.internalNote,
        firstVisit: !!body.firstVisit,
        sensitivities: body.sensitivities,
        createdBy: `admin:${admin.name}`,
        admin,
        adminOverride: true,
        status: body.status && bk.STATUSES.includes(body.status) ? body.status : 'confirmed',
      });
      sendJSON(res, 201, { ok: true, appointment: adminView(appt) });
    } catch (e) {
      return fail(res, e.status || 500, e.status ? e.message : 'שגיאה בשמירת התור');
    }
  });

  /** עריכת תור: סטטוס, מחיר והערות */
  router.patch('/api/admin/appointments/:id', async (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const appt = bk.getAppointment(params.id);
    if (!appt) return fail(res, 404, 'התור לא נמצא');
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }

    const sets = [];
    const args = [];
    if (body.status !== undefined) {
      if (!bk.STATUSES.includes(body.status)) return fail(res, 400, 'סטטוס לא תקין');
      sets.push('status = ?'); args.push(body.status);
      if (bk.CANCELLED.includes(body.status)) {
        sets.push("cancelled_at = datetime('now')", 'cancelled_by = ?');
        args.push(admin.name);
      }
    }
    if (body.price !== undefined) { sets.push('price = ?'); args.push(body.price === null || body.price === '' ? null : Number(body.price)); }
    if (body.internalNote !== undefined) { sets.push('internal_note = ?'); args.push(bk.cleanNote(body.internalNote) || null); }
    if (body.note !== undefined) { sets.push('customer_note = ?'); args.push(bk.cleanNote(body.note) || null); }
    if (!sets.length) return fail(res, 400, 'לא נשלחו שדות לעדכון');
    sets.push("updated_at = datetime('now')");
    db.get().prepare(`UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`).run(...args, appt.id);
    db.audit(admin, 'update_appointment', 'appointment', appt.id, body);
    sendJSON(res, 200, { ok: true, appointment: adminView(bk.getAppointment(appt.id)) });
  });

  /** העברת תור למועד אחר */
  router.post('/api/admin/appointments/:id/reschedule', async (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    try {
      const updated = bk.rescheduleAppointment(params.id, { date: body.date, time: body.time, byAdmin: true, admin });
      sendJSON(res, 200, { ok: true, appointment: adminView(updated) });
    } catch (e) {
      return fail(res, e.status || 500, e.message);
    }
  });

  router.post('/api/admin/appointments/:id/cancel', async (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body = {};
    try { body = await readJSON(req); } catch { /* אופציונלי */ }
    try {
      const updated = bk.cancelAppointment(params.id, { byAdmin: true, admin, reason: body.reason || '' });
      sendJSON(res, 200, { ok: true, appointment: adminView(updated) });
    } catch (e) {
      return fail(res, e.status || 500, e.message);
    }
  });

  router.delete('/api/admin/appointments/:id', (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const appt = bk.getAppointment(params.id);
    if (!appt) return fail(res, 404, 'התור לא נמצא');
    db.get().prepare('DELETE FROM appointments WHERE id = ?').run(appt.id);
    db.audit(admin, 'delete_appointment', 'appointment', appt.id, {
      date: appt.date, time: appt.start_time, customer: appt.customer_name, service: appt.service_name,
    });
    sendJSON(res, 200, { ok: true });
  });

  // ---------- טיפולים ----------
  router.get('/api/admin/services', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    sendJSON(res, 200, { ok: true, services: db.get().prepare('SELECT * FROM services ORDER BY sort_order, id').all() });
  });

  function serviceFields(body, existing = {}) {
    const name = bk.cleanText(body.name ?? existing.name, 60);
    const duration = Number(body.duration_min ?? existing.duration_min);
    if (!name) throw new bk.BookingError('יש להזין שם טיפול');
    if (!Number.isFinite(duration) || duration < 5 || duration > 600) {
      throw new bk.BookingError('משך הטיפול חייב להיות בין 5 ל-600 דקות');
    }
    const depositType = ['none', 'fixed', 'percent', 'full'].includes(body.deposit_type ?? existing.deposit_type)
      ? (body.deposit_type ?? existing.deposit_type) : 'none';
    const priceRaw = body.price ?? existing.price;
    return {
      name,
      description: bk.cleanNote(body.description ?? existing.description ?? '', 400),
      duration_min: Math.round(duration),
      price: priceRaw === '' || priceRaw === null || priceRaw === undefined ? null : Number(priceRaw),
      buffer_min: Math.max(0, Math.min(120, Number(body.buffer_min ?? existing.buffer_min ?? 0) || 0)),
      image_url: bk.cleanText(body.image_url ?? existing.image_url ?? '', 300),
      active: (body.active ?? existing.active ?? 1) ? 1 : 0,
      bookable_online: (body.bookable_online ?? existing.bookable_online ?? 1) ? 1 : 0,
      requires_approval: (body.requires_approval ?? existing.requires_approval ?? 0) ? 1 : 0,
      deposit_type: depositType,
      deposit_value: Math.max(0, Number(body.deposit_value ?? existing.deposit_value ?? 0) || 0),
      sort_order: Number(body.sort_order ?? existing.sort_order ?? 0) || 0,
    };
  }

  router.post('/api/admin/services', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    try {
      const f = serviceFields(body);
      const info = db.get().prepare(
        `INSERT INTO services (name, description, duration_min, price, buffer_min, image_url, active,
                               bookable_online, requires_approval, deposit_type, deposit_value, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(f.name, f.description, f.duration_min, f.price, f.buffer_min, f.image_url, f.active,
        f.bookable_online, f.requires_approval, f.deposit_type, f.deposit_value, f.sort_order);
      db.audit(admin, 'create_service', 'service', Number(info.lastInsertRowid), f);
      sendJSON(res, 201, { ok: true, service: db.get().prepare('SELECT * FROM services WHERE id = ?').get(Number(info.lastInsertRowid)) });
    } catch (e) {
      return fail(res, e.status || 500, e.message);
    }
  });

  router.patch('/api/admin/services/:id', async (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const existing = db.get().prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id));
    if (!existing) return fail(res, 404, 'הטיפול לא נמצא');
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    try {
      const f = serviceFields(body, existing);
      db.get().prepare(
        `UPDATE services SET name=?, description=?, duration_min=?, price=?, buffer_min=?, image_url=?,
                active=?, bookable_online=?, requires_approval=?, deposit_type=?, deposit_value=?, sort_order=?
          WHERE id = ?`
      ).run(f.name, f.description, f.duration_min, f.price, f.buffer_min, f.image_url, f.active,
        f.bookable_online, f.requires_approval, f.deposit_type, f.deposit_value, f.sort_order, existing.id);
      db.audit(admin, 'update_service', 'service', existing.id, f);
      sendJSON(res, 200, { ok: true, service: db.get().prepare('SELECT * FROM services WHERE id = ?').get(existing.id) });
    } catch (e) {
      return fail(res, e.status || 500, e.message);
    }
  });

  router.delete('/api/admin/services/:id', (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const existing = db.get().prepare('SELECT * FROM services WHERE id = ?').get(Number(params.id));
    if (!existing) return fail(res, 404, 'הטיפול לא נמצא');
    const { c } = db.get().prepare('SELECT COUNT(*) AS c FROM appointments WHERE service_id = ?').get(existing.id);
    if (c > 0) {
      // שמירה על היסטוריית התורים – הטיפול מוסתר במקום להימחק
      db.get().prepare('UPDATE services SET active = 0, bookable_online = 0 WHERE id = ?').run(existing.id);
      db.audit(admin, 'hide_service', 'service', existing.id, null);
      return sendJSON(res, 200, { ok: true, hidden: true, message: 'לטיפול קיימים תורים בהיסטוריה ולכן הוא הוסתר במקום להימחק' });
    }
    db.get().prepare('DELETE FROM services WHERE id = ?').run(existing.id);
    db.audit(admin, 'delete_service', 'service', existing.id, null);
    sendJSON(res, 200, { ok: true });
  });

  // ---------- שעות פעילות ----------
  router.get('/api/admin/working-hours', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const rows = db.get().prepare('SELECT * FROM working_hours ORDER BY weekday, start_time').all();
    const byDay = T.DAY_NAMES.map((name, weekday) => ({
      weekday, name,
      ranges: rows.filter((r) => r.weekday === weekday).map((r) => ({ start: r.start_time, end: r.end_time })),
    }));
    sendJSON(res, 200, { ok: true, days: byDay });
  });

  router.put('/api/admin/working-hours', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const days = Array.isArray(body.days) ? body.days : null;
    if (!days) return fail(res, 400, 'נתונים לא תקינים');

    for (const day of days) {
      if (!Number.isInteger(day.weekday) || day.weekday < 0 || day.weekday > 6) return fail(res, 400, 'יום לא תקין');
      for (const r of (day.ranges || [])) {
        if (!T.isValidHHMM(r.start) || !T.isValidHHMM(r.end)) return fail(res, 400, 'שעה לא תקינה');
        if (T.toMinutes(r.end) <= T.toMinutes(r.start)) return fail(res, 400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה');
      }
    }
    bk.withTransaction((d) => {
      d.prepare('DELETE FROM working_hours').run();
      const ins = d.prepare('INSERT INTO working_hours (weekday, start_time, end_time) VALUES (?,?,?)');
      for (const day of days) for (const r of (day.ranges || [])) ins.run(day.weekday, r.start, r.end);
    });
    db.audit(admin, 'update_working_hours', 'working_hours', null, days);
    sendJSON(res, 200, { ok: true, message: 'שעות הפעילות עודכנו' });
  });

  // ---------- חריגים וחסימות ----------
  router.get('/api/admin/exceptions', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const from = url.searchParams.get('from') || T.addDays(T.todayISO(), -30);
    const to = url.searchParams.get('to') || T.addDays(T.todayISO(), 365);
    const rows = db.get().prepare(
      `SELECT * FROM exceptions
        WHERE recurring = 1 OR (COALESCE(end_date, date) >= ? AND date <= ?)
        ORDER BY date, start_time`
    ).all(from, to);
    sendJSON(res, 200, { ok: true, exceptions: rows });
  });

  router.post('/api/admin/exceptions', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const type = ['block', 'open', 'vacation'].includes(body.type) ? body.type : null;
    if (!type) return fail(res, 400, 'סוג רשומה לא תקין');
    if (!T.isValidISO(body.date)) return fail(res, 400, 'תאריך לא תקין');
    if (body.endDate && !T.isValidISO(body.endDate)) return fail(res, 400, 'תאריך סיום לא תקין');
    if (body.endDate && body.endDate < body.date) return fail(res, 400, 'תאריך הסיום מוקדם מתאריך ההתחלה');

    const allDay = !body.startTime && !body.endTime;
    if (!allDay) {
      if (!T.isValidHHMM(body.startTime) || !T.isValidHHMM(body.endTime)) return fail(res, 400, 'שעות לא תקינות');
      if (T.toMinutes(body.endTime) <= T.toMinutes(body.startTime)) return fail(res, 400, 'שעת הסיום חייבת להיות אחרי שעת ההתחלה');
    }
    if (type === 'vacation' && !allDay) return fail(res, 400, 'חופשה מוגדרת לימים שלמים');

    const info = db.get().prepare(
      `INSERT INTO exceptions (date, end_date, start_time, end_time, type, reason, recurring)
       VALUES (?,?,?,?,?,?,?)`
    ).run(body.date, body.endDate || null, allDay ? null : body.startTime, allDay ? null : body.endTime,
      type, bk.cleanText(body.reason, 120) || null, body.recurring ? 1 : 0);
    db.audit(admin, 'create_exception', 'exception', Number(info.lastInsertRowid), body);
    sendJSON(res, 201, { ok: true, exception: db.get().prepare('SELECT * FROM exceptions WHERE id = ?').get(Number(info.lastInsertRowid)) });
  });

  router.delete('/api/admin/exceptions/:id', (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const row = db.get().prepare('SELECT * FROM exceptions WHERE id = ?').get(Number(params.id));
    if (!row) return fail(res, 404, 'הרשומה לא נמצאה');
    db.get().prepare('DELETE FROM exceptions WHERE id = ?').run(row.id);
    db.audit(admin, 'delete_exception', 'exception', row.id, row);
    sendJSON(res, 200, { ok: true });
  });

  // ---------- לקוחות ----------
  router.get('/api/admin/customers', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const q = url.searchParams.get('q');
    const sql = `SELECT c.*,
                        (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id) AS visits,
                        (SELECT MAX(a.date) FROM appointments a WHERE a.customer_id = c.id
                          AND a.status IN ('confirmed','completed')) AS last_visit
                   FROM customers c
                  ${q ? 'WHERE c.full_name LIKE ? OR c.phone LIKE ?' : ''}
                  ORDER BY c.full_name`;
    const list = q
      ? db.get().prepare(sql).all(`%${q}%`, `%${q}%`)
      : db.get().prepare(sql).all();
    sendJSON(res, 200, { ok: true, customers: list });
  });

  router.get('/api/admin/customers/:id', (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const customer = db.get().prepare('SELECT * FROM customers WHERE id = ?').get(Number(params.id));
    if (!customer) return fail(res, 404, 'הלקוחה לא נמצאה');
    const appts = attachServices(db.get().prepare(
      `SELECT a.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
         FROM appointments a JOIN customers c ON c.id = a.customer_id
        WHERE a.customer_id = ? ORDER BY a.date DESC, a.start_time DESC`
    ).all(customer.id));
    sendJSON(res, 200, { ok: true, customer, appointments: appts.map(adminView) });
  });

  router.patch('/api/admin/customers/:id', async (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const customer = db.get().prepare('SELECT * FROM customers WHERE id = ?').get(Number(params.id));
    if (!customer) return fail(res, 404, 'הלקוחה לא נמצאה');
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const name = bk.cleanText(body.full_name ?? customer.full_name, 80);
    const phone = body.phone ? bk.normalizePhone(body.phone) : customer.phone;
    if (!name) return fail(res, 400, 'יש להזין שם');
    if (!bk.validPhone(phone)) return fail(res, 400, 'מספר טלפון לא תקין');
    try {
      db.get().prepare('UPDATE customers SET full_name = ?, phone = ?, email = ?, notes = ? WHERE id = ?')
        .run(name, phone, bk.cleanText(body.email ?? customer.email ?? '', 120) || null,
          bk.cleanNote(body.notes ?? customer.notes ?? '') || null, customer.id);
    } catch {
      return fail(res, 409, 'מספר הטלפון כבר קיים אצל לקוחה אחרת');
    }
    db.audit(admin, 'update_customer', 'customer', customer.id, null);
    sendJSON(res, 200, { ok: true, customer: db.get().prepare('SELECT * FROM customers WHERE id = ?').get(customer.id) });
  });

  /** מחיקת פרטי לקוחה (סעיף 20) – התורים נשמרים ללא זיהוי */
  router.delete('/api/admin/customers/:id', (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    const customer = db.get().prepare('SELECT * FROM customers WHERE id = ?').get(Number(params.id));
    if (!customer) return fail(res, 404, 'הלקוחה לא נמצאה');
    bk.withTransaction((d) => {
      d.prepare("UPDATE appointments SET customer_id = NULL, customer_note = NULL WHERE customer_id = ?").run(customer.id);
      d.prepare('DELETE FROM customers WHERE id = ?').run(customer.id);
    });
    db.audit(admin, 'delete_customer', 'customer', customer.id, { name: customer.full_name });
    sendJSON(res, 200, { ok: true, message: 'פרטי הלקוחה נמחקו' });
  });

  // ---------- רשימת המתנה ----------
  router.get('/api/admin/waitlist', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const status = url.searchParams.get('status');
    const rows = status && status !== 'all'
      ? db.get().prepare('SELECT * FROM waitlist WHERE status = ? ORDER BY desired_date, created_at').all(status)
      : db.get().prepare('SELECT * FROM waitlist ORDER BY desired_date, created_at').all();
    sendJSON(res, 200, { ok: true, waitlist: rows });
  });

  router.patch('/api/admin/waitlist/:id', async (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    if (!['waiting', 'contacted', 'booked', 'closed'].includes(body.status)) return fail(res, 400, 'סטטוס לא תקין');
    const info = db.get().prepare('UPDATE waitlist SET status = ? WHERE id = ?').run(body.status, Number(params.id));
    if (!info.changes) return fail(res, 404, 'הרשומה לא נמצאה');
    sendJSON(res, 200, { ok: true });
  });

  router.delete('/api/admin/waitlist/:id', (req, res, params) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    db.get().prepare('DELETE FROM waitlist WHERE id = ?').run(Number(params.id));
    sendJSON(res, 200, { ok: true });
  });

  // ---------- הגדרות ----------
  router.get('/api/admin/settings', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    sendJSON(res, 200, { ok: true, settings: db.settings() });
  });

  router.put('/api/admin/settings', async (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (!checkOrigin(req, res)) return;
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const updated = [];
    for (const [k, v] of Object.entries(body.settings || {})) {
      if (!SETTABLE_SETTINGS.has(k)) continue;
      db.setSetting(k, v);
      updated.push(k);
    }
    db.audit(admin, 'update_settings', 'settings', null, updated);
    sendJSON(res, 200, { ok: true, settings: db.settings(), updated });
  });

  // ---------- מנהלים ----------
  router.get('/api/admin/admins', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    sendJSON(res, 200, {
      ok: true,
      admins: db.get().prepare('SELECT id, name, username, phone, email, role, active, created_at FROM admins ORDER BY id').all(),
    });
  });

  // ---------- תיעוד פעולות ----------
  router.get('/api/admin/audit', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    sendJSON(res, 200, {
      ok: true,
      log: db.get().prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all(),
    });
  });

  // ---------- יצוא ----------
  router.get('/api/admin/export/appointments.csv', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const url = new URL(req.url, 'http://x');
    const rows = listAppointments({
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      status: url.searchParams.get('status'),
    }).map(adminView);
    const csv = toCSV([
      { label: 'תאריך', value: (r) => r.dateIL },
      { label: 'יום', value: (r) => r.dayName },
      { label: 'שעה', value: (r) => r.startTime },
      { label: 'שעת סיום', value: (r) => r.endTime },
      { label: 'משך (דקות)', value: (r) => r.durationMin },
      { label: 'טיפול', value: (r) => r.service },
      { label: 'לקוחה', value: (r) => r.customerName },
      { label: 'טלפון', value: (r) => r.customerPhone },
      { label: 'מחיר', value: (r) => (r.price ?? '') },
      { label: 'סטטוס', value: (r) => r.statusLabel },
      { label: 'הערת לקוחה', value: (r) => r.note },
      { label: 'הערה פנימית', value: (r) => r.internalNote },
      { label: 'נוצר בתאריך', value: (r) => r.createdAt },
      { label: 'נוצר על ידי', value: (r) => r.createdBy },
    ], rows);
    db.audit(admin, 'export_appointments', 'appointment', null, { count: rows.length });
    send(res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lola-appointments-${T.todayISO()}.csv"`,
      'Cache-Control': 'no-store',
    });
  });

  router.get('/api/admin/export/customers.csv', (req, res) => {
    const admin = requireAdmin(req, res); if (!admin) return;
    const rows = db.get().prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM appointments a WHERE a.customer_id = c.id) AS visits
         FROM customers c ORDER BY c.full_name`
    ).all();
    const csv = toCSV([
      { label: 'שם מלא', key: 'full_name' },
      { label: 'טלפון', key: 'phone' },
      { label: 'דואר אלקטרוני', key: 'email' },
      { label: 'מספר תורים', key: 'visits' },
      { label: 'הערות', key: 'notes' },
      { label: 'תאריך יצירה', key: 'created_at' },
    ], rows);
    db.audit(admin, 'export_customers', 'customer', null, { count: rows.length });
    send(res, 200, csv, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lola-customers-${T.todayISO()}.csv"`,
      'Cache-Control': 'no-store',
    });
  });
}

module.exports = { register, adminView, listAppointments, requireAdmin };
