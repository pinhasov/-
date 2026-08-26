'use strict';
/** לוגיקת קביעת תור, שינוי וביטול – משותפת לממשק הלקוחה ולמערכת הניהול. */

const db = require('./db');
const auth = require('./auth');
const T = require('./time');
const av = require('./availability');

const STATUSES = ['pending', 'confirmed', 'completed', 'cancelled_customer', 'cancelled_admin', 'no_show'];
const STATUS_LABELS = {
  pending: 'ממתין לאישור',
  confirmed: 'מאושר',
  completed: 'הושלם',
  cancelled_customer: 'בוטל על ידי הלקוחה',
  cancelled_admin: 'בוטל על ידי מנהל',
  no_show: 'הלקוחה לא הגיעה',
};
const CANCELLED = ['cancelled_customer', 'cancelled_admin'];

class BookingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** נרמול מספר טלפון ישראלי לפורמט 05XXXXXXXX */
function normalizePhone(input) {
  let s = String(input || '').replace(/[^\d+]/g, '');
  if (s.startsWith('+972')) s = '0' + s.slice(4);
  else if (s.startsWith('972')) s = '0' + s.slice(3);
  s = s.replace(/\D/g, '');
  return s;
}

function validPhone(phone) {
  return /^0(5\d|[23489]|7\d)\d{7}$/.test(phone);
}

function cleanText(v, max = 500) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanNote(v, max = 1000) {
  return String(v ?? '').replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function getService(id, { onlyBookable = false } = {}) {
  const s = db.get().prepare('SELECT * FROM services WHERE id = ?').get(Number(id));
  if (!s) throw new BookingError('הטיפול המבוקש לא נמצא', 404);
  if (onlyBookable && (!s.active || !s.bookable_online)) {
    throw new BookingError('הטיפול אינו זמין להזמנה מקוונת', 400);
  }
  return s;
}

/** צירוף כמה טיפולים לטיפול אחד "מאוחד" לצורך חישוב הזמינות */
function combineServices(services) {
  return {
    id: services[0].id,
    name: services.map((s) => s.name).join(' + '),
    duration_min: services.reduce((sum, s) => sum + Number(s.duration_min || 0), 0),
    buffer_min: Math.max(0, ...services.map((s) => Number(s.buffer_min || 0))),
    price: services.every((s) => s.price === null || s.price === undefined)
      ? null
      : services.reduce((sum, s) => sum + Number(s.price || 0), 0),
    requires_approval: services.some((s) => s.requires_approval) ? 1 : 0,
    active: 1,
    bookable_online: 1,
    deposit_type: 'none',
    deposit_value: 0,
  };
}

/**
 * מקבל מזהה טיפול אחד או רשימת מזהים ומחזיר את הטיפולים והטיפול המאוחד.
 */
function resolveServices(ids, { onlyBookable = false } = {}) {
  const raw = Array.isArray(ids) ? ids : [ids];
  const unique = [];
  for (const value of raw) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!unique.includes(id)) unique.push(id);
  }
  if (!unique.length) throw new BookingError('יש לבחור לפחות טיפול אחד');
  const max = Math.max(1, db.settingInt('max_services_per_booking', 4));
  if (unique.length > max) throw new BookingError(`ניתן לבחור עד ${max} טיפולים בתור אחד`);
  const services = unique.map((id) => getService(id, { onlyBookable }));
  return { services, combined: combineServices(services) };
}

function computeDeposit(service) {
  if (!db.settingBool('payments_enabled', false)) return 0;
  const price = Number(service.price || 0);
  switch (service.deposit_type) {
    case 'fixed': return Math.max(0, Number(service.deposit_value || 0));
    case 'percent': return Math.round(price * Math.max(0, Number(service.deposit_value || 0)) / 100 * 100) / 100;
    case 'full': return price;
    default: return 0;
  }
}

function upsertCustomer({ fullName, phone, email }) {
  const d = db.get();
  const existing = d.prepare('SELECT * FROM customers WHERE phone = ?').get(phone);
  if (existing) {
    d.prepare('UPDATE customers SET full_name = ?, email = COALESCE(NULLIF(?, \'\'), email) WHERE id = ?')
      .run(fullName || existing.full_name, email || '', existing.id);
    return existing.id;
  }
  const info = d.prepare('INSERT INTO customers (full_name, phone, email) VALUES (?,?,?)')
    .run(fullName, phone, email || null);
  return Number(info.lastInsertRowid);
}

function withTransaction(fn) {
  const d = db.get();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(d);
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * קביעת תור חדש. הבדיקה הסופית של הזמינות מתבצעת בתוך טרנזקציה
 * כדי למנוע מצב שבו שתי לקוחות קובעות את אותה שעה במקביל (סעיף 8).
 */
function createAppointment(input) {
  const {
    serviceId, serviceIds, date, time, fullName, phone, email = '', note = '',
    firstVisit = false, sensitivities = '', createdBy = 'customer',
    admin = null, adminOverride = false, internalNote = '', status: forcedStatus = null,
    now = new Date(),
  } = input;

  const name = cleanText(fullName, 80);
  const tel = normalizePhone(phone);
  if (name.length < 2) throw new BookingError('יש להזין שם מלא');
  if (!validPhone(tel)) throw new BookingError('מספר הטלפון אינו תקין. לדוגמה: 0501234567');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(email).trim())) {
    throw new BookingError('כתובת הדואר האלקטרוני אינה תקינה');
  }

  const { services, combined } = resolveServices(
    serviceIds && serviceIds.length ? serviceIds : serviceId,
    { onlyBookable: !adminOverride },
  );
  const service = combined;

  return withTransaction((d) => {
    const check = av.checkSlot(date, time, service, { now, adminOverride });
    if (!check.ok) throw new BookingError(check.reason, 409);

    const customerId = upsertCustomer({ fullName: name, phone: tel, email: cleanText(email, 120) });
    const token = auth.randomToken(24);
    const autoApprove = db.settingBool('auto_approve', true);
    const status = forcedStatus
      || (adminOverride ? 'confirmed' : (service.requires_approval || !autoApprove ? 'pending' : 'confirmed'));

    const deposit = services.reduce((sum, s) => sum + computeDeposit(s), 0);
    const info = d.prepare(
      `INSERT INTO appointments
        (customer_id, service_id, service_name, date, start_time, end_time, buffer_min, status,
         price, deposit_amount, customer_note, internal_note, first_visit, sensitivities,
         manage_token, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      customerId, service.id, service.name, date, check.start, check.end, service.buffer_min || 0, status,
      service.price ?? null, deposit, cleanNote(note) || null, cleanNote(internalNote) || null,
      firstVisit ? 1 : 0, cleanNote(sensitivities, 300) || null, token, createdBy,
    );
    const id = Number(info.lastInsertRowid);

    const insService = d.prepare(
      `INSERT INTO appointment_services (appointment_id, service_id, service_name, duration_min, sort_order)
       VALUES (?,?,?,?,?)`
    );
    services.forEach((s, i) => insService.run(id, s.id, s.name, s.duration_min, i));

    if (admin) db.audit(admin, 'create_appointment', 'appointment', id, { date, time, service: service.name });
    return getAppointment(id, d);
  });
}

/** רשימת הטיפולים של תור (עם נפילה לאחור לתורים ישנים מטיפול יחיד) */
function appointmentServices(appt, d = db.get()) {
  if (!appt) return [];
  const rows = d.prepare(
    'SELECT service_id, service_name, duration_min FROM appointment_services WHERE appointment_id = ? ORDER BY sort_order, id'
  ).all(appt.id);
  if (rows.length) return rows;
  return [{
    service_id: appt.service_id,
    service_name: appt.service_name,
    duration_min: T.toMinutes(appt.end_time) - T.toMinutes(appt.start_time),
  }];
}

function withServices(appt, d = db.get()) {
  if (!appt) return appt;
  appt.services = appointmentServices(appt, d);
  return appt;
}

function getAppointment(id, d = db.get()) {
  return withServices(d.prepare(
    `SELECT a.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
       FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.id = ?`
  ).get(Number(id)), d);
}

function getByToken(token) {
  return withServices(db.get().prepare(
    `SELECT a.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
       FROM appointments a LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.manage_token = ?`
  ).get(String(token || '')));
}

/** האם מותר ללקוחה לשנות/לבטל בהתאם למדיניות (סעיף 12) */
function customerCanModify(appt, now = new Date()) {
  if (CANCELLED.includes(appt.status)) return { allowed: false, reason: 'התור כבר בוטל' };
  if (appt.status === 'completed') return { allowed: false, reason: 'הטיפול כבר הסתיים' };
  const cutoff = db.settingInt('cancel_cutoff_hours', 24);
  const start = T.localToDate(appt.date, appt.start_time).getTime();
  if (start - now.getTime() < cutoff * 3600000) {
    return { allowed: false, reason: `לא ניתן לשנות או לבטל תור בפחות מ-${cutoff} שעות לפני המועד. יש ליצור קשר טלפוני.` };
  }
  return { allowed: true };
}

function cancelAppointment(id, { byAdmin = false, admin = null, now = new Date(), reason = '' } = {}) {
  const appt = getAppointment(id);
  if (!appt) throw new BookingError('התור לא נמצא', 404);
  if (CANCELLED.includes(appt.status)) return appt;
  if (!byAdmin) {
    const check = customerCanModify(appt, now);
    if (!check.allowed) throw new BookingError(check.reason, 403);
  }
  db.get().prepare(
    `UPDATE appointments
        SET status = ?, cancelled_at = datetime('now'), cancelled_by = ?, updated_at = datetime('now'),
            internal_note = CASE WHEN ? = '' THEN internal_note
                                 ELSE COALESCE(internal_note || ' | ', '') || ? END
      WHERE id = ?`
  ).run(byAdmin ? 'cancelled_admin' : 'cancelled_customer',
    byAdmin ? (admin?.name || 'מנהל') : 'לקוחה', cleanNote(reason, 200), cleanNote(reason, 200), appt.id);
  if (byAdmin && admin) db.audit(admin, 'cancel_appointment', 'appointment', appt.id, { reason });
  return getAppointment(appt.id);
}

/** העברת תור למועד אחר */
function rescheduleAppointment(id, { date, time, byAdmin = false, admin = null, now = new Date() }) {
  const appt = getAppointment(id);
  if (!appt) throw new BookingError('התור לא נמצא', 404);
  if (!byAdmin) {
    const check = customerCanModify(appt, now);
    if (!check.allowed) throw new BookingError(check.reason, 403);
  }
  // משך התור נשמר כפי שנקבע, גם אם משך הטיפול שונה מאז במערכת הניהול
  const effective = {
    id: appt.service_id,
    name: appt.service_name,
    duration_min: T.toMinutes(appt.end_time) - T.toMinutes(appt.start_time),
    buffer_min: appt.buffer_min,
    price: appt.price,
    active: 1,
    bookable_online: 1,
  };

  return withTransaction((d) => {
    const check = av.checkSlot(date, time, effective, {
      now, adminOverride: byAdmin, ignoreAppointmentId: appt.id,
    });
    if (!check.ok) throw new BookingError(check.reason, 409);
    d.prepare(
      `UPDATE appointments SET date = ?, start_time = ?, end_time = ?, updated_at = datetime('now'),
              status = CASE WHEN status IN ('cancelled_customer','cancelled_admin') THEN 'confirmed' ELSE status END
        WHERE id = ?`
    ).run(date, check.start, check.end, appt.id);
    if (admin) db.audit(admin, 'reschedule_appointment', 'appointment', appt.id, { from: `${appt.date} ${appt.start_time}`, to: `${date} ${time}` });
    return getAppointment(appt.id, d);
  });
}

/** פרטי תור כפי שהם מוצגים ללקוחה (ללא מידע פנימי) */
function publicView(appt, { manageUrl = '' } = {}) {
  const showPrices = db.settingBool('show_prices', false);
  return {
    id: appt.id,
    serviceId: appt.service_id,
    serviceIds: (appt.services || []).map((s) => s.service_id).filter(Boolean),
    services: (appt.services || []).map((s) => ({ name: s.service_name, durationMin: s.duration_min })),
    service: appt.service_name,
    date: appt.date,
    dateIL: T.formatIL(appt.date),
    dayName: T.dayName(appt.date),
    startTime: appt.start_time,
    endTime: appt.end_time,
    durationMin: T.toMinutes(appt.end_time) - T.toMinutes(appt.start_time),
    price: showPrices ? appt.price : null,
    depositAmount: appt.deposit_amount,
    status: appt.status,
    statusLabel: STATUS_LABELS[appt.status] || appt.status,
    customerName: appt.customer_name,
    customerPhone: appt.customer_phone,
    note: appt.customer_note || '',
    manageToken: appt.manage_token,
    manageUrl,
  };
}

module.exports = {
  STATUSES, STATUS_LABELS, CANCELLED, BookingError,
  normalizePhone, validPhone, cleanText, cleanNote, getService, computeDeposit,
  resolveServices, combineServices, appointmentServices,
  createAppointment, getAppointment, getByToken, cancelAppointment, rescheduleAppointment,
  customerCanModify, publicView, withTransaction, upsertCustomer,
};
