'use strict';
/**
 * מנוע חישוב הזמינות (סעיפים 5–8 באפיון).
 * מחשב שעות פנויות לפי: שעות פעילות, משך הטיפול, זמן מעבר, תורים קיימים,
 * חסימות והפסקות, חופשות, הזמן הנוכחי, זמן מינימלי מראש וטווח היומן.
 */

const db = require('./db');
const T = require('./time');

const ACTIVE_STATUSES = ['pending', 'confirmed', 'completed', 'no_show'];

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** מיזוג טווחים חופפים/צמודים */
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

/** טוען את כל הנתונים הדרושים לחישוב טווח תאריכים – שאילתה אחת לכל סוג */
function loadContext(fromDate, toDate) {
  const d = db.get();
  const workingHours = d.prepare('SELECT weekday, start_time, end_time FROM working_hours ORDER BY weekday, start_time').all();
  const exceptions = d.prepare(
    `SELECT id, date, end_date, start_time, end_time, type, reason, recurring
       FROM exceptions
      WHERE recurring = 1
         OR (COALESCE(end_date, date) >= ? AND date <= ?)`
  ).all(fromDate, toDate);
  const appointments = d.prepare(
    `SELECT id, date, start_time, end_time, buffer_min, status
       FROM appointments
      WHERE date BETWEEN ? AND ?
        AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`
  ).all(fromDate, toDate, ...ACTIVE_STATUSES);

  const byWeekday = new Map();
  for (const w of workingHours) {
    if (!byWeekday.has(w.weekday)) byWeekday.set(w.weekday, []);
    byWeekday.get(w.weekday).push({ start: T.toMinutes(w.start_time), end: T.toMinutes(w.end_time) });
  }
  const apptByDate = new Map();
  for (const a of appointments) {
    if (!apptByDate.has(a.date)) apptByDate.set(a.date, []);
    apptByDate.get(a.date).push(a);
  }
  return { byWeekday, exceptions, apptByDate };
}

function exceptionsForDate(date, exceptions) {
  const wd = T.weekdayOf(date);
  return exceptions.filter((e) => {
    if (e.recurring) return e.date <= date && T.weekdayOf(e.date) === wd;
    if (e.end_date) return date >= e.date && date <= e.end_date;
    return e.date === date;
  });
}

/** טווחי הפעילות של היום (לפני חסימות) */
function openWindows(date, ctx) {
  const excs = exceptionsForDate(date, ctx.exceptions);
  const vacation = excs.find((e) => e.type === 'vacation');
  if (vacation) return { windows: [], closedReason: vacation.reason || 'חופשה' };

  let windows = (ctx.byWeekday.get(T.weekdayOf(date)) || []).map((w) => ({ ...w }));

  // פתיחת שעות חריגה (גם ביום שבדרך כלל סגור)
  for (const e of excs) {
    if (e.type !== 'open') continue;
    windows.push({
      start: e.start_time ? T.toMinutes(e.start_time) : 0,
      end: e.end_time ? T.toMinutes(e.end_time) : 24 * 60,
    });
  }
  windows = mergeRanges(windows.filter((w) => w.end > w.start));
  if (windows.length === 0) return { windows: [], closedReason: 'לולה אינה עובדת ביום זה' };
  return { windows, closedReason: null };
}

/** טווחים חסומים ביום (חסימות ידניות והפסקות חריגות) */
function blockedRanges(date, ctx) {
  const excs = exceptionsForDate(date, ctx.exceptions);
  const out = [];
  for (const e of excs) {
    if (e.type !== 'block') continue;
    out.push({
      start: e.start_time ? T.toMinutes(e.start_time) : 0,
      end: e.end_time ? T.toMinutes(e.end_time) : 24 * 60,
      reason: e.reason || '',
    });
  }
  return mergeRanges(out);
}

/** טווחים תפוסים ביום (תורים קיימים + זמן מעבר), עם אפשרות להתעלם מתור מסוים */
function busyRanges(date, ctx, ignoreAppointmentId = null) {
  return (ctx.apptByDate.get(date) || [])
    .filter((a) => a.id !== ignoreAppointmentId)
    .map((a) => ({
      start: T.toMinutes(a.start_time),
      end: T.toMinutes(a.end_time) + (a.buffer_min || 0),
      id: a.id,
    }));
}

function policy(now = new Date()) {
  return {
    today: T.todayISO(now),
    nowMin: T.nowMinutes(now),
    stepMin: Math.max(5, db.settingInt('slot_step_min', 15)),
    minLeadHours: db.settingInt('min_lead_hours', 0),
    maxAdvanceDays: db.settingInt('max_advance_days', 90),
  };
}

/**
 * רשימת השעות של יום מסוים עבור טיפול נתון.
 * מוחזרות כל שעות העבודה, כל אחת עם סטטוס: free | taken | blocked | past
 */
function daySlots(date, service, opts = {}) {
  const now = opts.now || new Date();
  const p = opts.policy || policy(now);
  const ctx = opts.ctx || loadContext(date, date);
  const duration = Number(service.duration_min);
  const buffer = Number(service.buffer_min || 0);

  const { windows, closedReason } = openWindows(date, ctx);
  const result = {
    date,
    weekday: T.weekdayOf(date),
    dayName: T.dayName(date),
    dateIL: T.formatIL(date),
    open: windows.length > 0,
    closedReason,
    slots: [],
    freeCount: 0,
  };
  if (!result.open) return result;

  const dayDiff = T.diffDays(p.today, date);
  if (dayDiff < 0) { result.open = false; result.closedReason = 'תאריך שעבר'; return result; }
  if (dayDiff > p.maxAdvanceDays) {
    result.open = false;
    result.closedReason = 'היומן עדיין אינו פתוח לתאריך זה';
    return result;
  }

  const blocked = blockedRanges(date, ctx);
  const busy = busyRanges(date, ctx, opts.ignoreAppointmentId ?? null);
  // המועד המוקדם ביותר להזמנה, בדקות יחסית לתחילת התאריך המבוקש
  const earliest = p.nowMin + p.minLeadHours * 60 - dayDiff * 1440;

  for (const w of windows) {
    for (let start = w.start; start + duration <= w.end; start += p.stepMin) {
      const end = start + duration;
      const endWithBuffer = end + buffer;
      let status = 'free';

      if (start < earliest) {
        status = 'past';
      } else if (busy.some((b) => overlaps(start, endWithBuffer, b.start, b.end))) {
        status = 'taken';
      } else if (blocked.some((b) => overlaps(start, endWithBuffer, b.start, b.end))) {
        status = 'blocked';
      }

      if (status === 'free') result.freeCount++;
      result.slots.push({
        time: T.toHHMM(start),
        end: T.toHHMM(end),
        status,
      });
    }
  }
  return result;
}

/** סטטוס יומי עבור לוח השנה: available | full | closed | past | locked */
function dayStatus(date, service, opts = {}) {
  const now = opts.now || new Date();
  const p = opts.policy || policy(now);
  const dayDiff = T.diffDays(p.today, date);
  if (dayDiff < 0) return { date, status: 'past', freeCount: 0 };
  if (dayDiff > p.maxAdvanceDays) return { date, status: 'locked', freeCount: 0 };

  const day = daySlots(date, service, { ...opts, now, policy: p });
  if (!day.open) return { date, status: 'closed', freeCount: 0, reason: day.closedReason };
  if (day.freeCount === 0) return { date, status: 'full', freeCount: 0 };
  return { date, status: 'available', freeCount: day.freeCount };
}

/** לוח חודשי מלא (סעיף 6) */
function monthView(year, month1, service, opts = {}) {
  const now = opts.now || new Date();
  const p = opts.policy || policy(now);
  const first = T.isoOf(year, month1, 1);
  const last = T.isoOf(year, month1, T.daysInMonth(year, month1));
  const ctx = opts.ctx || loadContext(first, last);
  const days = [];
  for (let d = 1; d <= T.daysInMonth(year, month1); d++) {
    const date = T.isoOf(year, month1, d);
    days.push(dayStatus(date, service, { ...opts, ctx, now, policy: p }));
  }
  return {
    year, month: month1, monthName: T.monthName(month1),
    firstWeekday: T.weekdayOf(first),
    daysInMonth: T.daysInMonth(year, month1),
    days,
  };
}

/**
 * בדיקה סופית לפני שמירת תור (סעיף 8) – נקראת בתוך טרנזקציה.
 * מחזירה { ok: true } או { ok: false, reason }
 */
function checkSlot(date, time, service, opts = {}) {
  const now = opts.now || new Date();
  const p = opts.policy || policy(now);
  if (!T.isValidISO(date)) return { ok: false, reason: 'תאריך לא תקין' };
  if (!T.isValidHHMM(time)) return { ok: false, reason: 'שעה לא תקינה' };

  const ctx = opts.ctx || loadContext(date, date);
  const duration = Number(service.duration_min);
  const buffer = Number(service.buffer_min || 0);
  const start = T.toMinutes(time);
  const end = start + duration;
  const endWithBuffer = end + buffer;

  const dayDiff = T.diffDays(p.today, date);
  if (dayDiff < 0) return { ok: false, reason: 'לא ניתן לקבוע תור בתאריך שעבר' };
  if (dayDiff > p.maxAdvanceDays) return { ok: false, reason: 'היומן אינו פתוח לתאריך זה' };
  if (!opts.adminOverride && start < p.nowMin + p.minLeadHours * 60 - dayDiff * 1440) {
    return { ok: false, reason: `יש לקבוע תור לפחות ${p.minLeadHours} שעות מראש` };
  }

  const { windows, closedReason } = openWindows(date, ctx);
  if (windows.length === 0 && !opts.adminOverride) {
    return { ok: false, reason: closedReason || 'היום סגור לקביעת תורים' };
  }
  if (!opts.adminOverride) {
    const fits = windows.some((w) => start >= w.start && end <= w.end);
    if (!fits) return { ok: false, reason: 'השעה שנבחרה אינה בתוך שעות הפעילות' };
    if (blockedRanges(date, ctx).some((b) => overlaps(start, endWithBuffer, b.start, b.end))) {
      return { ok: false, reason: 'השעה שנבחרה חסומה ואינה זמינה' };
    }
    // השעה חייבת להופיע ברשת השעות שהוצגה ללקוחה
    const day = daySlots(date, service, { ...opts, ctx, now, policy: p });
    const slot = day.slots.find((s) => s.time === T.toHHMM(start));
    if (!slot) return { ok: false, reason: 'השעה שנבחרה אינה זמינה' };
    if (slot.status !== 'free') {
      return { ok: false, reason: slot.status === 'taken' ? 'השעה נתפסה זה עתה. יש לבחור שעה אחרת' : 'השעה שנבחרה אינה זמינה' };
    }
  }

  const conflict = busyRanges(date, ctx, opts.ignoreAppointmentId ?? null)
    .find((b) => overlaps(start, endWithBuffer, b.start, b.end));
  if (conflict) return { ok: false, reason: 'השעה נתפסה זה עתה. יש לבחור שעה אחרת' };

  return { ok: true, start: T.toHHMM(start), end: T.toHHMM(end) };
}

module.exports = {
  ACTIVE_STATUSES, loadContext, openWindows, blockedRanges, busyRanges,
  daySlots, dayStatus, monthView, checkSlot, policy, mergeRanges, overlaps,
  exceptionsForDate,
};
