/* ניהול תור באמצעות הקישור האישי (סעיף 12) */
(function () {
  'use strict';
  const { api, el, clear, toast, formatIL, money, duration, removeToken } = window.Lola;
  const $ = (id) => document.getElementById(id);

  const token = decodeURIComponent(location.pathname.replace(/^\/t\//, '').replace(/\/$/, ''))
    || new URLSearchParams(location.search).get('token') || '';

  const state = { data: null, config: null, calYear: null, calMonth: null, date: null };

  /** מזהי הטיפולים של התור, לצורך חישוב זמינות במועד חדש */
  function serviceIds() {
    const a = state.data?.appointment;
    if (!a) return '';
    if (a.serviceIds && a.serviceIds.length) return a.serviceIds.join(',');
    return a.serviceId ? String(a.serviceId) : '';
  }

  async function load() {
    try {
      state.config = await api('/api/config');
      $('brandName').textContent = state.config.businessName || '';
      const data = await api(`/api/appointment/${encodeURIComponent(token)}`);
      state.data = data;
      render();
    } catch (e) {
      $('loading').classList.add('hidden');
      const err = $('error');
      err.textContent = e.message;
      err.classList.remove('hidden');
    }
  }

  function render() {
    const a = state.data.appointment;
    $('loading').classList.add('hidden');
    $('content').classList.remove('hidden');

    const cancelled = a.status.startsWith('cancelled');
    const pill = $('statusPill');
    pill.textContent = a.statusLabel;
    pill.className = 'pill ' + (cancelled ? 'red' : a.status === 'pending' ? 'gold' : 'green');

    const list = $('details');
    clear(list);
    const multi = (a.services || []).length > 1;
    const rows = [
      [multi ? 'הטיפולים' : 'הטיפול', a.service],
      ['תאריך', `${a.dateIL} (יום ${a.dayName})`],
      ['שעה', `${a.startTime} - ${a.endTime}`],
      ['משך', duration(a.durationMin)],
      ['שם', a.customerName || ''],
      ['טלפון', a.customerPhone || ''],
    ];
    if (a.price) rows.splice(4, 0, ['מחיר', money(a.price)]);
    if (a.note) rows.push(['הערה', a.note]);
    for (const [k, v] of rows) {
      list.appendChild(el('li', {}, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })]));
    }

    $('icsLink').href = state.data.calendar.ics;
    $('googleLink').href = state.data.calendar.google;
    $('outlookLink').href = state.data.calendar.outlook;
    $('policyBox').textContent = state.data.cancellationPolicy || '';
    $('calendarCard').classList.toggle('hidden', cancelled);

    const blocked = $('modifyBlocked');
    const buttons = $('actionButtons');
    if (cancelled) {
      blocked.textContent = 'התור בוטל. ניתן לקבוע תור חדש בעמוד הראשי.';
      blocked.classList.remove('hidden');
      buttons.classList.add('hidden');
    } else if (!state.data.canModify) {
      blocked.textContent = state.data.modifyReason || 'לא ניתן לשנות את התור בשלב זה.';
      blocked.classList.remove('hidden');
      buttons.classList.add('hidden');
    } else {
      blocked.classList.add('hidden');
      buttons.classList.remove('hidden');
    }
  }

  async function cancelAppointment() {
    if (!confirm('לבטל את התור? הפעולה אינה ניתנת לשחזור.')) return;
    try {
      await api(`/api/appointment/${encodeURIComponent(token)}/cancel`, { method: 'POST', body: {} });
      toast('התור בוטל. השעה חזרה להיות פנויה.');
      removeToken(token);
      await load();
      $('rescheduleArea').classList.add('hidden');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---------- שינוי מועד ----------
  function startReschedule() {
    const today = state.config.today;
    state.calYear = Number(today.slice(0, 4));
    state.calMonth = Number(today.slice(5, 7));
    $('rescheduleArea').classList.remove('hidden');
    $('rescheduleArea').scrollIntoView({ behavior: 'smooth' });
    loadCalendar();
  }

  async function loadCalendar() {
    const box = $('calendar');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    const ids = serviceIds();
    if (!ids) {
      clear(box);
      box.appendChild(el('div', { class: 'alert info', text: 'לשינוי מועד התור יש ליצור קשר עם לולה.' }));
      return;
    }
    try {
      const data = await api(`/api/calendar?service_ids=${ids}&year=${state.calYear}&month=${state.calMonth}`);
      renderCalendar(data);
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  function renderCalendar(data) {
    const box = $('calendar');
    clear(box);
    const today = state.config.today;
    const atFirst = data.year === Number(today.slice(0, 4)) && data.month === Number(today.slice(5, 7));
    box.appendChild(el('div', { class: 'cal-head' }, [
      el('button', { class: 'cal-nav', type: 'button', text: '›', 'aria-label': 'החודש הקודם', disabled: atFirst, onclick: () => moveMonth(-1) }),
      el('div', { class: 'cal-title', text: `${data.monthName} ${data.year}` }),
      el('button', { class: 'cal-nav', type: 'button', text: '‹', 'aria-label': 'החודש הבא', onclick: () => moveMonth(1) }),
    ]));
    const grid = el('div', { class: 'cal-grid' });
    for (const d of state.config.dayNames) grid.appendChild(el('div', { class: 'cal-dow', text: d.slice(0, 3) }));
    for (let i = 0; i < data.firstWeekday; i++) grid.appendChild(el('div', { class: 'cal-day empty' }));
    for (const day of data.days) {
      const cls = ['cal-day', day.status];
      if (day.date === today) cls.push('today');
      if (day.date === state.date) cls.push('selected');
      grid.appendChild(el('button', {
        class: cls.join(' '), type: 'button', disabled: day.status !== 'available',
        dataset: { date: day.date },
        'aria-label': formatIL(day.date),
        onclick: () => chooseDate(day.date),
      }, [el('span', { text: String(Number(day.date.slice(8, 10))) })]));
    }
    box.appendChild(grid);
  }

  function moveMonth(delta) {
    let m = state.calMonth + delta, y = state.calYear;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.calMonth = m; state.calYear = y;
    loadCalendar();
  }

  async function chooseDate(date) {
    state.date = date;
    for (const b of document.querySelectorAll('.cal-day')) b.classList.toggle('selected', b.dataset.date === date);
    const area = $('slotsArea');
    area.classList.remove('hidden');
    const box = $('slotsBox');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api(`/api/slots?service_ids=${serviceIds()}&date=${date}`);
      $('slotsTitle').textContent = `שעות פנויות ליום ${data.dayName}, ${data.dateIL}`;
      clear(box);
      const visible = data.slots.filter((s) => s.status !== 'past');
      if (!data.open || !visible.length) {
        box.appendChild(el('div', { class: 'alert info', text: data.closedReason || 'אין שעות פנויות ביום זה.' }));
        return;
      }
      const grid = el('div', { class: 'slots' });
      for (const s of visible) {
        grid.appendChild(el('button', {
          class: `slot ${s.status}`, type: 'button', disabled: s.status !== 'free',
          onclick: () => confirmReschedule(date, s.time),
        }, [
          el('span', { text: s.time }),
          el('small', { text: s.status === 'free' ? `עד ${s.end}` : (s.status === 'taken' ? 'תפוס' : 'לא זמין') }),
        ]));
      }
      box.appendChild(grid);
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function confirmReschedule(date, time) {
    if (!confirm(`להעביר את התור ל-${formatIL(date)} בשעה ${time}?`)) return;
    try {
      await api(`/api/appointment/${encodeURIComponent(token)}/reschedule`, { method: 'POST', body: { date, time } });
      toast('התור הועבר בהצלחה למועד החדש.');
      $('rescheduleArea').classList.add('hidden');
      $('slotsArea').classList.add('hidden');
      await load();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    window.Lola.registerServiceWorker();
    $('btnCancel').addEventListener('click', cancelAppointment);
    $('btnReschedule').addEventListener('click', startReschedule);
    $('btnCancelReschedule').addEventListener('click', () => $('rescheduleArea').classList.add('hidden'));
    load();
  });
})();
