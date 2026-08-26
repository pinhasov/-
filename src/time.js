'use strict';
/**
 * עזרי זמן ותאריך – כל המערכת עובדת לפי שעון ישראל (Asia/Jerusalem).
 * תאריכים נשמרים כמחרוזת YYYY-MM-DD ושעות כמחרוזת HH:MM (זמן מקומי).
 */

const TZ = process.env.TZ_NAME || 'Asia/Jerusalem';

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

const _parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function partsInTz(date) {
  const out = {};
  for (const p of _parts.formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  // Intl יכול להחזיר 24 עבור חצות
  if (out.hour === '24') out.hour = '00';
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour), minute: Number(out.minute), second: Number(out.second),
  };
}

/** היסט הזמן (בדקות) של אזור הזמן עבור רגע מסוים ב-UTC */
function tzOffsetMinutes(date) {
  const p = partsInTz(date);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** ממיר שעה מקומית (תאריך + שעה בישראל) לאובייקט Date ב-UTC */
function localToDate(iso, hhmm = '00:00') {
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let offset = tzOffsetMinutes(new Date(guess));
  let stamp = guess - offset * 60000;
  // תיקון נוסף למעברי שעון קיץ/חורף
  const offset2 = tzOffsetMinutes(new Date(stamp));
  if (offset2 !== offset) stamp = guess - offset2 * 60000;
  return new Date(stamp);
}

/** התאריך הנוכחי בישראל בפורמט YYYY-MM-DD */
function todayISO(now = new Date()) {
  const p = partsInTz(now);
  return isoOf(p.year, p.month, p.day);
}

/** השעה הנוכחית בישראל בדקות מתחילת היום */
function nowMinutes(now = new Date()) {
  const p = partsInTz(now);
  return p.hour * 60 + p.minute;
}

function isoOf(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseISO(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return { y, m, d };
}

function isValidISO(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const { y, m, d } = parseISO(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function isValidHHMM(t) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(t || ''));
}

function addDays(iso, n) {
  const { y, m, d } = parseISO(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** מספר הימים בין שני תאריכים (b - a) */
function diffDays(a, b) {
  const pa = parseISO(a), pb = parseISO(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86400000);
}

/** יום בשבוע: 0=ראשון ... 6=שבת */
function weekdayOf(iso) {
  const { y, m, d } = parseISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** פורמט ישראלי: DD/MM/YYYY */
function formatIL(iso) {
  const { y, m, d } = parseISO(iso);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

function dayName(iso) {
  return DAY_NAMES[weekdayOf(iso)];
}

function monthName(month1) {
  return MONTH_NAMES[month1 - 1];
}

/** מספר הימים בחודש */
function daysInMonth(year, month1) {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

module.exports = {
  TZ, DAY_NAMES, MONTH_NAMES,
  partsInTz, tzOffsetMinutes, localToDate,
  todayISO, nowMinutes, isoOf, parseISO, isValidISO, isValidHHMM,
  addDays, diffDays, weekdayOf, toMinutes, toHHMM,
  formatIL, dayName, monthName, daysInMonth,
};
