'use strict';
/** ה-API הציבורי – ממשק הלקוחה (סעיפים 4–12). */

const db = require('../db');
const T = require('../time');
const av = require('../availability');
const bk = require('../bookings');
const ics = require('../ics');
const rl = require('../ratelimit');
const { sendJSON, fail, readJSON, send } = require('../http');

function baseUrl(req) {
  const configured = db.setting('public_base_url', '');
  if (configured) return configured.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function manageUrl(req, token) {
  return `${baseUrl(req)}/t/${token}`;
}

function businessInfo() {
  const s = db.settings();
  return {
    businessName: s.business_name,
    phone: s.phone,
    address: s.address,
    policy: s.cancellation_policy,
  };
}

/** מזהי הטיפולים שנבחרו – תומך גם בטיפול אחד וגם בכמה טיפולים */
function servicesFromQuery(url) {
  const ids = [];
  for (const key of ['service_ids', 'service_id']) {
    for (const value of url.searchParams.getAll(key)) ids.push(...String(value).split(','));
  }
  return bk.resolveServices(ids, { onlyBookable: true });
}

function serviceCard(s) {
  const showPrices = db.settingBool('show_prices', false);
  return {
    id: s.id,
    name: s.name,
    description: s.description || '',
    durationMin: s.duration_min,
    price: showPrices ? s.price : null,
    imageUrl: s.image_url || '',
    requiresApproval: !!s.requires_approval,
    depositRequired: db.settingBool('payments_enabled', false) && s.deposit_type !== 'none',
    depositAmount: bk.computeDeposit(s),
  };
}

function register(router) {
  /** הגדרות התצוגה והטקסטים */
  router.get('/api/config', (req, res) => {
    const s = db.settings();
    sendJSON(res, 200, {
      ok: true,
      businessName: s.business_name,
      pageTitle: s.page_title,
      introText: s.intro_text,
      address: s.address,
      phone: s.phone,
      whatsapp: s.whatsapp,
      logoUrl: s.logo_url,
      cancellationPolicy: s.cancellation_policy,
      termsText: s.terms_text,
      privacyText: s.privacy_text,
      cancelCutoffHours: Number(s.cancel_cutoff_hours || 24),
      minLeadHours: Number(s.min_lead_hours || 0),
      maxAdvanceDays: Number(s.max_advance_days || 90),
      waitlistEnabled: s.waitlist_enabled === '1',
      paymentsEnabled: s.payments_enabled === '1',
      showPrices: s.show_prices === '1',
      maxServicesPerBooking: Number(s.max_services_per_booking || 4),
      today: T.todayISO(),
      dayNames: T.DAY_NAMES,
      monthNames: T.MONTH_NAMES,
    });
  });

  /** רשימת הטיפולים הפעילים */
  router.get('/api/services', (req, res) => {
    const rows = db.get().prepare(
      'SELECT * FROM services WHERE active = 1 AND bookable_online = 1 ORDER BY sort_order, id'
    ).all();
    sendJSON(res, 200, { ok: true, services: rows.map(serviceCard) });
  });

  /** לוח שנה חודשי מלא עם סטטוס לכל יום */
  router.get('/api/calendar', (req, res) => {
    const url = new URL(req.url, 'http://x');
    let service;
    try { service = servicesFromQuery(url).combined; }
    catch (e) { return fail(res, e.status || 400, e.message); }

    const today = T.todayISO();
    const year = Number(url.searchParams.get('year')) || Number(today.slice(0, 4));
    const month = Number(url.searchParams.get('month')) || Number(today.slice(5, 7));
    if (year < 2000 || year > 2100 || month < 1 || month > 12) return fail(res, 400, 'תאריך לא תקין');

    const view = av.monthView(year, month, service);
    sendJSON(res, 200, { ok: true, ...view, today, serviceName: service.name, durationMin: service.duration_min });
  });

  /** כל שעות היום עם הסטטוס שלהן */
  router.get('/api/slots', (req, res) => {
    const url = new URL(req.url, 'http://x');
    const date = url.searchParams.get('date');
    if (!T.isValidISO(date)) return fail(res, 400, 'תאריך לא תקין');
    let service;
    try { service = servicesFromQuery(url).combined; }
    catch (e) { return fail(res, e.status || 400, e.message); }

    const day = av.daySlots(date, service);
    sendJSON(res, 200, {
      ok: true,
      date, dateIL: T.formatIL(date), dayName: T.dayName(date),
      open: day.open,
      closedReason: day.closedReason,
      freeCount: day.freeCount,
      durationMin: service.duration_min,
      serviceName: service.name,
      slots: day.slots,
    });
  });

  /** קביעת תור */
  router.post('/api/book', async (req, res) => {
    if (!rl.allow(req, 'book', { limit: 10, windowMs: 10 * 60000 })) {
      return fail(res, 429, 'בוצעו יותר מדי ניסיונות. יש לנסות שוב בעוד מספר דקות.');
    }
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    if (!body.acceptTerms) return fail(res, 400, 'יש לאשר את תנאי השימוש ומדיניות הביטולים');

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
        firstVisit: !!body.firstVisit,
        sensitivities: body.sensitivities,
        createdBy: 'customer',
      });
      sendJSON(res, 201, {
        ok: true,
        appointment: bk.publicView(appt, { manageUrl: manageUrl(req, appt.manage_token) }),
        calendar: {
          ics: `/api/appointment/${appt.manage_token}/ics`,
          google: ics.googleUrl(appt, { ...businessInfo(), manageUrl: manageUrl(req, appt.manage_token) }),
          outlook: ics.outlookUrl(appt, { ...businessInfo(), manageUrl: manageUrl(req, appt.manage_token) }),
        },
      });
    } catch (e) {
      return fail(res, e.status || 500, e.status ? e.message : 'אירעה שגיאה בשמירת התור. יש לנסות שוב.');
    }
  });

  /** צפייה בתור באמצעות הקישור האישי */
  router.get('/api/appointment/:token', (req, res, params) => {
    const appt = bk.getByToken(params.token);
    if (!appt) return fail(res, 404, 'התור לא נמצא. ייתכן שהקישור אינו תקין.');
    const can = bk.customerCanModify(appt);
    sendJSON(res, 200, {
      ok: true,
      appointment: bk.publicView(appt, { manageUrl: manageUrl(req, appt.manage_token) }),
      canModify: can.allowed,
      modifyReason: can.reason || '',
      cancellationPolicy: db.setting('cancellation_policy', ''),
      calendar: {
        ics: `/api/appointment/${appt.manage_token}/ics`,
        google: ics.googleUrl(appt, { ...businessInfo(), manageUrl: manageUrl(req, appt.manage_token) }),
        outlook: ics.outlookUrl(appt, { ...businessInfo(), manageUrl: manageUrl(req, appt.manage_token) }),
      },
    });
  });

  /** קובץ יומן ICS */
  router.get('/api/appointment/:token/ics', (req, res, params) => {
    const appt = bk.getByToken(params.token);
    if (!appt) return fail(res, 404, 'התור לא נמצא');
    const body = ics.buildICS(appt, { ...businessInfo(), manageUrl: manageUrl(req, appt.manage_token) });
    send(res, 200, body, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="lola-appointment-${appt.id}.ics"`,
      'Cache-Control': 'no-store',
    });
  });

  /** ביטול תור על ידי הלקוחה */
  router.post('/api/appointment/:token/cancel', async (req, res, params) => {
    if (!rl.allow(req, 'cancel', { limit: 20, windowMs: 10 * 60000 })) {
      return fail(res, 429, 'בוצעו יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר.');
    }
    const appt = bk.getByToken(params.token);
    if (!appt) return fail(res, 404, 'התור לא נמצא');
    try {
      const updated = bk.cancelAppointment(appt.id, { byAdmin: false });
      sendJSON(res, 200, { ok: true, appointment: bk.publicView(updated) });
    } catch (e) {
      return fail(res, e.status || 500, e.message);
    }
  });

  /** בקשת שינוי מועד על ידי הלקוחה */
  router.post('/api/appointment/:token/reschedule', async (req, res, params) => {
    if (!rl.allow(req, 'reschedule', { limit: 20, windowMs: 10 * 60000 })) {
      return fail(res, 429, 'בוצעו יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר.');
    }
    const appt = bk.getByToken(params.token);
    if (!appt) return fail(res, 404, 'התור לא נמצא');
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    try {
      const updated = bk.rescheduleAppointment(appt.id, { date: body.date, time: body.time, byAdmin: false });
      sendJSON(res, 200, {
        ok: true,
        appointment: bk.publicView(updated, { manageUrl: manageUrl(req, updated.manage_token) }),
      });
    } catch (e) {
      return fail(res, e.status || 500, e.message);
    }
  });

  /** רשימת המתנה (סעיף 14) */
  router.post('/api/waitlist', async (req, res) => {
    if (!db.settingBool('waitlist_enabled', true)) return fail(res, 400, 'רשימת ההמתנה אינה פעילה');
    if (!rl.allow(req, 'waitlist', { limit: 10, windowMs: 10 * 60000 })) {
      return fail(res, 429, 'בוצעו יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר.');
    }
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }

    const name = bk.cleanText(body.fullName, 80);
    const phone = bk.normalizePhone(body.phone);
    if (name.length < 2) return fail(res, 400, 'יש להזין שם מלא');
    if (!bk.validPhone(phone)) return fail(res, 400, 'מספר הטלפון אינו תקין');
    if (!T.isValidISO(body.date)) return fail(res, 400, 'יש לבחור תאריך');

    let service = null;
    try {
      service = bk.resolveServices(
        body.serviceIds && body.serviceIds.length ? body.serviceIds : body.serviceId,
        { onlyBookable: true },
      ).combined;
    } catch (e) { return fail(res, e.status || 400, e.message); }

    db.get().prepare(
      `INSERT INTO waitlist (full_name, phone, service_id, service_name, desired_date, time_from, time_to, note)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(name, phone, service.id, service.name, body.date,
      T.isValidHHMM(body.timeFrom) ? body.timeFrom : null,
      T.isValidHHMM(body.timeTo) ? body.timeTo : null,
      bk.cleanNote(body.note, 300) || null);

    sendJSON(res, 201, { ok: true, message: 'נרשמת לרשימת ההמתנה. לולה תיצור איתך קשר אם יתפנה מקום.' });
  });

  /** "התורים שלי" – לפי קישורים אישיים ששמורים במכשיר של הלקוחה בלבד */
  router.post('/api/my-appointments', async (req, res) => {
    if (!rl.allow(req, 'mine', { limit: 60, windowMs: 10 * 60000 })) {
      return fail(res, 429, 'בוצעו יותר מדי בקשות. יש לנסות שוב מאוחר יותר.');
    }
    let body;
    try { body = await readJSON(req); } catch (e) { return fail(res, 400, e.message); }
    const tokens = Array.isArray(body.tokens) ? body.tokens.slice(0, 30) : [];
    const out = [];
    for (const token of tokens) {
      const appt = bk.getByToken(token);
      if (appt) out.push(bk.publicView(appt, { manageUrl: manageUrl(req, appt.manage_token) }));
    }
    out.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    sendJSON(res, 200, { ok: true, appointments: out });
  });
}

module.exports = { register, baseUrl, manageUrl, businessInfo, serviceCard };
