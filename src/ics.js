'use strict';
/** יצירת קובץ יומן (ICS) לתור – סעיף 11 באפיון. */

const T = require('./time');

function pad(n) { return String(n).padStart(2, '0'); }

function toUtcStamp(date) {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function escapeText(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** גלישת שורות לפי תקן RFC 5545 (75 בתים לשורה) */
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 73) return line;
  const out = [];
  let cur = Buffer.alloc(0);
  for (const ch of line) {
    const b = Buffer.from(ch, 'utf8');
    if (cur.length + b.length > 73) { out.push(cur.toString('utf8')); cur = Buffer.alloc(0); }
    cur = Buffer.concat([cur, b]);
  }
  out.push(cur.toString('utf8'));
  return out.join('\r\n ');
}

/**
 * @param {object} appt פרטי התור
 * @param {object} info פרטי העסק וקישור ניהול
 */
function buildICS(appt, info = {}) {
  const start = T.localToDate(appt.date, appt.start_time);
  const end = T.localToDate(appt.date, appt.end_time);
  const business = info.businessName || 'לולה';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Lola Booking//HE//',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:appt-${appt.id}-${appt.manage_token || 'x'}@lola`,
    `DTSTAMP:${toUtcStamp(new Date())}`,
    `DTSTART:${toUtcStamp(start)}`,
    `DTEND:${toUtcStamp(end)}`,
    `SUMMARY:${escapeText(`תור אצל ${business} - ${appt.service_name}`)}`,
    `DESCRIPTION:${escapeText([
      `טיפול: ${appt.service_name}`,
      `תאריך: ${T.formatIL(appt.date)} (יום ${T.dayName(appt.date)})`,
      `שעה: ${appt.start_time} - ${appt.end_time}`,
      info.phone ? `טלפון: ${info.phone}` : '',
      info.manageUrl ? `לשינוי או ביטול התור: ${info.manageUrl}` : '',
      info.policy ? `מדיניות ביטולים: ${info.policy}` : '',
    ].filter(Boolean).join('\n'))}`,
    info.address ? `LOCATION:${escapeText(info.address)}` : null,
    info.manageUrl ? `URL:${info.manageUrl}` : null,
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT2H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(`תזכורת: תור אצל ${business}`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** קישור להוספה ליומן Google */
function googleUrl(appt, info = {}) {
  const start = T.localToDate(appt.date, appt.start_time);
  const end = T.localToDate(appt.date, appt.end_time);
  const fmt = (d) => toUtcStamp(d);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `תור אצל ${info.businessName || 'לולה'} - ${appt.service_name}`,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: [`טיפול: ${appt.service_name}`, info.manageUrl ? `לשינוי או ביטול: ${info.manageUrl}` : '']
      .filter(Boolean).join('\n'),
    location: info.address || '',
    ctz: T.TZ,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** קישור להוספה ליומן Outlook */
function outlookUrl(appt, info = {}) {
  const start = T.localToDate(appt.date, appt.start_time);
  const end = T.localToDate(appt.date, appt.end_time);
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: `תור אצל ${info.businessName || 'לולה'} - ${appt.service_name}`,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: info.manageUrl ? `לשינוי או ביטול: ${info.manageUrl}` : '',
    location: info.address || '',
  });
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

module.exports = { buildICS, googleUrl, outlookUrl, toUtcStamp };
