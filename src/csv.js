'use strict';
/** יצוא נתונים לקובץ CSV הנפתח כראוי ב-Excel בעברית (BOM + UTF-8). */

function cell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(headers, rows) {
  const lines = [headers.map((h) => cell(h.label)).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => cell(typeof h.value === 'function' ? h.value(row) : row[h.key])).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { toCSV };
