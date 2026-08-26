/* מערכת הניהול של לולה ואבי (סעיף 13) */
(function () {
  'use strict';
  const { api, el, clear, toast, formatIL, money, duration } = window.Lola;
  const $ = (id) => document.getElementById(id);

  const state = { admin: null, view: 'day', date: null, services: [], settings: {} };

  const STATUS_OPTIONS = [
    ['pending', 'ממתין לאישור'],
    ['confirmed', 'מאושר'],
    ['completed', 'הושלם'],
    ['cancelled_customer', 'בוטל על ידי הלקוחה'],
    ['cancelled_admin', 'בוטל על ידי מנהל'],
    ['no_show', 'הלקוחה לא הגיעה'],
  ];
  const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

  const send = (path, method, body) => api(path, { method, body, admin: true });

  // ---------- כלי תאריך ----------
  function todayISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  function weekdayOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  // ---------- התחברות ----------
  async function checkAuth() {
    try {
      const data = await api('/api/admin/me');
      state.admin = data.admin;
      $('loginScreen').classList.add('hidden');
      $('adminApp').classList.remove('hidden');
      $('whoami').textContent = `מחוברת/ת כ${data.admin.name}`;
      await bootstrap();
    } catch {
      $('loginScreen').classList.remove('hidden');
      $('adminApp').classList.add('hidden');
    }
  }

  async function doLogin(e) {
    e.preventDefault();
    const err = $('loginError');
    err.classList.add('hidden');
    try {
      await api('/api/admin/login', {
        method: 'POST',
        body: { username: $('username').value.trim(), password: $('password').value },
      });
      $('password').value = '';
      await checkAuth();
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
    }
  }

  async function bootstrap() {
    state.date = todayISO();
    $('fltFrom').value = todayISO();
    $('fltTo').value = addDays(todayISO(), 30);
    $('excDate').value = todayISO();
    await loadServices();
    await loadCalendar();
  }

  // ---------- לשוניות ----------
  function bindTabs() {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
        for (const p of document.querySelectorAll('.panel')) {
          p.classList.toggle('active', p.id === `panel-${tab.dataset.panel}`);
        }
        const loaders = {
          calendar: loadCalendar, appointments: loadAppointments, services: renderServices,
          hours: loadHours, blocks: loadExceptions, customers: loadCustomers,
          waitlist: loadWaitlist, settings: loadSettings,
        };
        loaders[tab.dataset.panel]?.();
      });
    }
  }

  // ---------- יומן ----------
  async function loadCalendar() {
    const box = $('calendarView');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      if (state.view === 'day') await renderDay(box);
      else if (state.view === 'week') await renderWeek(box);
      else await renderMonth(box);
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  function dateNav(onPrev, onNext, title) {
    return el('div', { class: 'card row-between' }, [
      el('button', { class: 'cal-nav', type: 'button', text: '›', 'aria-label': 'הקודם', onclick: onPrev }),
      el('div', { class: 'cal-title', text: title }),
      el('button', { class: 'cal-nav', type: 'button', text: '‹', 'aria-label': 'הבא', onclick: onNext }),
    ]);
  }

  async function renderDay(box) {
    const data = await api(`/api/admin/day?date=${state.date}`);
    clear(box);
    box.appendChild(dateNav(
      () => { state.date = addDays(state.date, -1); loadCalendar(); },
      () => { state.date = addDays(state.date, 1); loadCalendar(); },
      `יום ${data.dayName}, ${data.dateIL}`,
    ));

    const info = el('div', { class: 'card' }, [
      el('div', { class: 'hint', text: data.open ? `שעות פעילות: ${data.windows.map((w) => `${w.start}-${w.end}`).join(', ')}` : (data.closedReason || 'יום סגור') }),
      data.blocked.length ? el('div', { class: 'hint', text: `חסימות: ${data.blocked.map((b) => `${b.start}-${b.end}`).join(', ')}` }) : null,
    ]);
    box.appendChild(info);

    const active = data.appointments.filter((a) => !a.status.startsWith('cancelled'));
    if (!data.appointments.length) {
      box.appendChild(el('div', { class: 'card center hint', text: 'אין תורים ביום זה.' }));
    } else {
      box.appendChild(el('p', { class: 'hint', text: `${active.length} תורים פעילים ביום זה` }));
      for (const a of data.appointments) box.appendChild(apptCard(a));
    }
  }

  async function renderWeek(box) {
    const start = addDays(state.date, -weekdayOf(state.date));
    const end = addDays(start, 6);
    const data = await api(`/api/admin/appointments?from=${start}&to=${end}&status=all`);
    clear(box);
    box.appendChild(dateNav(
      () => { state.date = addDays(state.date, -7); loadCalendar(); },
      () => { state.date = addDays(state.date, 7); loadCalendar(); },
      `שבוע ${formatIL(start)} - ${formatIL(end)}`,
    ));
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const items = data.appointments.filter((a) => a.date === date);
      box.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'row-between' }, [
          el('strong', { text: `יום ${DAY_NAMES[weekdayOf(date)]} · ${formatIL(date)}` }),
          el('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', text: 'תצוגת יום',
            onclick: () => { state.date = date; setView('day'); },
          }),
        ]),
        items.length
          ? el('div', { class: 'day-timeline' }, items.map((a) => el('div', { class: 'tl-slot' + (a.status.startsWith('cancelled') ? '' : ' busy') }, [
            el('span', { class: 't', text: a.startTime }),
            el('span', { text: `${a.customerName} · ${a.service}` }),
            el('span', { class: 'pill ' + statusClass(a.status), text: a.statusLabel }),
          ])))
          : el('div', { class: 'hint', text: 'אין תורים' }),
      ]));
    }
  }

  async function renderMonth(box) {
    const y = Number(state.date.slice(0, 4));
    const m = Number(state.date.slice(5, 7));
    const data = await api(`/api/admin/month?year=${y}&month=${m}`);
    clear(box);
    box.appendChild(dateNav(
      () => { state.date = prevMonth(state.date); loadCalendar(); },
      () => { state.date = nextMonth(state.date); loadCalendar(); },
      `${data.monthName} ${data.year}`,
    ));
    const grid = el('div', { class: 'cal-grid' });
    for (const d of DAY_NAMES) grid.appendChild(el('div', { class: 'cal-dow', text: d.slice(0, 3) }));
    for (let i = 0; i < data.firstWeekday; i++) grid.appendChild(el('div', { class: 'cal-day empty' }));
    for (const day of data.days) {
      const cls = ['cal-day'];
      if (!day.open) cls.push('closed');
      else cls.push('available');
      if (day.date === data.today) cls.push('today');
      grid.appendChild(el('button', {
        class: cls.join(' '), type: 'button',
        title: day.open ? `${day.count} תורים` : (day.closedReason || 'סגור'),
        onclick: () => { state.date = day.date; setView('day'); },
      }, [
        el('span', { text: String(Number(day.date.slice(8, 10))) }),
        day.count ? el('small', { style: 'font-size:11px', text: `${day.count}` }) : null,
      ]));
    }
    box.appendChild(el('div', { class: 'calendar' }, [grid]));
  }

  function prevMonth(iso) {
    let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) - 1;
    if (m < 1) { m = 12; y--; }
    return `${y}-${String(m).padStart(2, '0')}-01`;
  }
  function nextMonth(iso) {
    let y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)) + 1;
    if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, '0')}-01`;
  }

  function setView(view) {
    state.view = view;
    for (const b of document.querySelectorAll('.view-btn')) b.classList.toggle('active', b.dataset.view === view);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.panel === 'calendar');
    for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === 'panel-calendar');
    loadCalendar();
  }

  function statusClass(status) {
    if (status.startsWith('cancelled') || status === 'no_show') return 'red';
    if (status === 'pending') return 'gold';
    if (status === 'completed') return 'gray';
    return 'green';
  }

  function apptCard(a) {
    return el('div', { class: `appt-card status-${a.status}` }, [
      el('div', { class: 'line' }, [
        el('span', { class: 'time', text: `${a.startTime} - ${a.endTime}` }),
        el('span', { class: 'pill ' + statusClass(a.status), text: a.statusLabel }),
      ]),
      el('div', { class: 'line' }, [
        el('strong', { text: a.customerName }),
        a.customerPhone ? el('a', { href: `tel:${a.customerPhone}`, text: a.customerPhone }) : null,
      ]),
      el('div', { class: 'hint', text: `${a.service} · ${duration(a.durationMin)}${a.price ? ' · ' + money(a.price) : ''}` }),
      a.note ? el('div', { class: 'hint', text: `הערת לקוחה: ${a.note}` }) : null,
      a.internalNote ? el('div', { class: 'hint', text: `הערה פנימית: ${a.internalNote}` }) : null,
      a.firstVisit ? el('span', { class: 'pill', text: 'לקוחה חדשה' }) : null,
      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'עריכה', onclick: () => editAppointment(a) }),
        el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'העברת מועד', onclick: () => rescheduleModal(a) }),
        a.status.startsWith('cancelled') ? null
          : el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'ביטול', onclick: () => cancelAppointment(a) }),
      ]),
    ]);
  }

  // ---------- תורים ----------
  async function loadAppointments() {
    const box = $('apptList');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    const qs = new URLSearchParams({
      from: $('fltFrom').value || '',
      to: $('fltTo').value || '',
      status: $('fltStatus').value,
      q: $('fltQ').value.trim(),
    });
    $('btnExport').href = `/api/admin/export/appointments.csv?${qs.toString()}`;
    try {
      const data = await api(`/api/admin/appointments?${qs.toString()}`);
      clear(box);
      if (!data.appointments.length) {
        box.appendChild(el('div', { class: 'card center hint', text: 'לא נמצאו תורים לפי הסינון.' }));
        return;
      }
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['תאריך', 'שעה', 'לקוחה', 'טלפון', 'טיפול', 'מחיר', 'סטטוס', 'פעולות']
          .map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.appointments.map((a) => el('tr', {}, [
          el('td', { text: a.dateIL }),
          el('td', { text: `${a.startTime}-${a.endTime}` }),
          el('td', { text: a.customerName }),
          el('td', {}, [a.customerPhone ? el('a', { href: `tel:${a.customerPhone}`, text: a.customerPhone }) : el('span', { text: '' })]),
          el('td', { text: a.service }),
          el('td', { text: a.price ? money(a.price) : '' }),
          el('td', {}, [el('span', { class: 'pill ' + statusClass(a.status), text: a.statusLabel })]),
          el('td', {}, [
            el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'עריכה', onclick: () => editAppointment(a) }),
            el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'מחיקה', onclick: () => deleteAppointment(a) }),
          ]),
        ]))),
      ]);
      box.appendChild(el('div', { class: 'card table-wrap' }, [table]));
      box.appendChild(el('p', { class: 'hint', text: `סה"כ ${data.appointments.length} תורים` }));
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  function editAppointment(a) {
    openModal(`תור · ${a.customerName} · ${a.dateIL} ${a.startTime}`, (body, close) => {
      const status = selectField(body, 'סטטוס', STATUS_OPTIONS, a.status);
      const price = inputField(body, 'מחיר', 'number', a.price ?? '');
      const internal = textareaField(body, 'הערה פנימית', a.internalNote || '');
      const note = textareaField(body, 'הערת לקוחה', a.note || '');
      const err = el('div', { class: 'alert error hidden' });
      body.appendChild(err);
      body.appendChild(el('button', {
        class: 'btn btn-block', type: 'button', text: 'שמירה',
        onclick: async () => {
          try {
            await send(`/api/admin/appointments/${a.id}`, 'PATCH', {
              status: status.value,
              price: price.value === '' ? null : Number(price.value),
              internalNote: internal.value,
              note: note.value,
            });
            close();
            toast('התור עודכן');
            refreshCurrent();
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
        },
      }));
    });
  }

  async function cancelAppointment(a) {
    const reason = prompt('סיבת הביטול (לא חובה):', '');
    if (reason === null) return;
    try {
      await send(`/api/admin/appointments/${a.id}/cancel`, 'POST', { reason });
      toast('התור בוטל והשעה חזרה להיות פנויה');
      refreshCurrent();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function deleteAppointment(a) {
    if (!confirm(`למחוק לצמיתות את התור של ${a.customerName} בתאריך ${a.dateIL}?`)) return;
    try {
      await send(`/api/admin/appointments/${a.id}`, 'DELETE');
      toast('התור נמחק');
      refreshCurrent();
    } catch (e) { toast(e.message, 'error'); }
  }

  function rescheduleModal(a) {
    openModal('העברת התור למועד אחר', (body, close) => {
      const date = inputField(body, 'תאריך חדש', 'date', a.date);
      const time = inputField(body, 'שעה חדשה', 'time', a.startTime);
      const err = el('div', { class: 'alert error hidden' });
      body.appendChild(err);
      body.appendChild(el('button', {
        class: 'btn btn-block', type: 'button', text: 'העברת התור',
        onclick: async () => {
          try {
            await send(`/api/admin/appointments/${a.id}/reschedule`, 'POST', { date: date.value, time: time.value });
            close();
            toast('התור הועבר');
            refreshCurrent();
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
        },
      }));
    });
  }

  function newAppointmentModal() {
    openModal('הוספת תור ידנית', (body, close) => {
      const service = selectField(body, 'טיפול', state.services.map((s) => [String(s.id), `${s.name} (${s.duration_min} דק')`]), '');
      const date = inputField(body, 'תאריך', 'date', state.date || todayISO());
      const time = inputField(body, 'שעה', 'time', '');
      const name = inputField(body, 'שם הלקוחה', 'text', '');
      const phone = inputField(body, 'טלפון', 'tel', '');
      const note = textareaField(body, 'הערה פנימית', '');
      body.appendChild(el('p', { class: 'hint', text: 'לחסימת זמן ללא לקוחה יש להשתמש בלשונית "חסימות וחופשות".' }));
      const err = el('div', { class: 'alert error hidden' });
      body.appendChild(err);
      body.appendChild(el('button', {
        class: 'btn btn-block', type: 'button', text: 'שמירת התור',
        onclick: async () => {
          try {
            await send('/api/admin/appointments', 'POST', {
              serviceId: Number(service.value), date: date.value, time: time.value,
              fullName: name.value, phone: phone.value, internalNote: note.value,
            });
            close();
            toast('התור נוסף והשעה נחסמה ללקוחות');
            refreshCurrent();
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
        },
      }));
    });
  }

  function refreshCurrent() {
    const active = document.querySelector('.tab.active')?.dataset.panel;
    if (active === 'calendar') loadCalendar();
    else if (active === 'appointments') loadAppointments();
    else if (active === 'customers') loadCustomers();
  }

  // ---------- טיפולים ----------
  async function loadServices() {
    const data = await api('/api/admin/services');
    state.services = data.services;
    return state.services;
  }

  async function renderServices() {
    const box = $('servicesList');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      await loadServices();
      clear(box);
      for (const s of state.services) {
        box.appendChild(el('div', { class: 'card' }, [
          el('div', { class: 'row-between' }, [
            el('div', {}, [
              el('strong', { style: 'font-size:18px;color:var(--plum-700)', text: s.name }),
              el('div', { class: 'hint', style: 'margin:2px 0', text: s.description || '' }),
              el('div', {}, [
                el('span', { class: 'pill', text: duration(s.duration_min) }),
                s.price ? el('span', { class: 'pill gold', text: money(s.price) }) : null,
                s.buffer_min ? el('span', { class: 'pill gray', text: `מעבר ${s.buffer_min} דק'` }) : null,
                s.active ? null : el('span', { class: 'pill red', text: 'לא פעיל' }),
                s.bookable_online ? null : el('span', { class: 'pill gray', text: 'לא להזמנה מקוונת' }),
                s.requires_approval ? el('span', { class: 'pill gold', text: 'דורש אישור' }) : null,
              ]),
            ]),
            el('div', { class: 'btn-row' }, [
              el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'עריכה', onclick: () => serviceModal(s) }),
              el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: 'מחיקה', onclick: () => deleteService(s) }),
            ]),
          ]),
        ]));
      }
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  function serviceModal(s) {
    const isNew = !s;
    openModal(isNew ? 'טיפול חדש' : `עריכת טיפול: ${s.name}`, (body, close) => {
      const name = inputField(body, 'שם הטיפול', 'text', s?.name || '');
      const desc = textareaField(body, 'תיאור', s?.description || '');
      const dur = inputField(body, 'משך בדקות', 'number', s?.duration_min ?? 60);
      const price = inputField(body, 'מחיר (ריק = ללא מחיר מוצג)', 'number', s?.price ?? '');
      const buffer = inputField(body, 'זמן מעבר אחרי הטיפול (דקות)', 'number', s?.buffer_min ?? 0);
      const image = inputField(body, 'כתובת תמונה (לא חובה)', 'text', s?.image_url || '');
      const order = inputField(body, 'סדר תצוגה', 'number', s?.sort_order ?? 0);
      const active = checkboxField(body, 'הטיפול פעיל', s ? !!s.active : true);
      const online = checkboxField(body, 'ניתן לקבוע דרך האתר', s ? !!s.bookable_online : true);
      const approval = checkboxField(body, 'נדרש אישור ידני', s ? !!s.requires_approval : false);
      const depositType = selectField(body, 'מקדמה', [
        ['none', 'ללא מקדמה'], ['fixed', 'סכום קבוע'], ['percent', 'אחוז מהמחיר'], ['full', 'תשלום מלא מראש'],
      ], s?.deposit_type || 'none');
      const depositValue = inputField(body, 'סכום/אחוז המקדמה', 'number', s?.deposit_value ?? 0);
      const err = el('div', { class: 'alert error hidden' });
      body.appendChild(err);
      body.appendChild(el('button', {
        class: 'btn btn-block', type: 'button', text: 'שמירה',
        onclick: async () => {
          const payload = {
            name: name.value, description: desc.value, duration_min: Number(dur.value),
            price: price.value === '' ? null : Number(price.value), buffer_min: Number(buffer.value || 0),
            image_url: image.value, sort_order: Number(order.value || 0),
            active: active.checked ? 1 : 0, bookable_online: online.checked ? 1 : 0,
            requires_approval: approval.checked ? 1 : 0,
            deposit_type: depositType.value, deposit_value: Number(depositValue.value || 0),
          };
          try {
            if (isNew) await send('/api/admin/services', 'POST', payload);
            else await send(`/api/admin/services/${s.id}`, 'PATCH', payload);
            close();
            toast('הטיפול נשמר');
            renderServices();
          } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
        },
      }));
    });
  }

  async function deleteService(s) {
    if (!confirm(`למחוק את הטיפול "${s.name}"?`)) return;
    try {
      const res = await send(`/api/admin/services/${s.id}`, 'DELETE');
      toast(res.message || 'הטיפול נמחק');
      renderServices();
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- שעות פעילות ----------
  async function loadHours() {
    const box = $('hoursEditor');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api('/api/admin/working-hours');
      clear(box);
      for (const day of data.days) {
        const ranges = el('div', { class: 'stack', dataset: { weekday: String(day.weekday) } });
        const addRange = (r = { start: '09:00', end: '18:00' }) => {
          const row = el('div', { class: 'btn-row range-row' }, [
            el('input', { type: 'time', value: r.start, class: 'r-start' }),
            el('input', { type: 'time', value: r.end, class: 'r-end' }),
            el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'הסרה', onclick: () => row.remove() }),
          ]);
          ranges.appendChild(row);
        };
        for (const r of day.ranges) addRange(r);
        box.appendChild(el('fieldset', {}, [
          el('legend', { text: `יום ${day.name}` }),
          ranges,
          el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '+ הוספת טווח שעות', onclick: () => addRange() }),
          el('div', { class: 'hint', text: day.ranges.length ? '' : 'יום סגור (ללא טווחים)' }),
        ]));
      }
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function saveHours() {
    const days = [];
    for (const group of document.querySelectorAll('#hoursEditor [data-weekday]')) {
      const weekday = Number(group.dataset.weekday);
      const ranges = [...group.querySelectorAll('.range-row')].map((row) => ({
        start: row.querySelector('.r-start').value,
        end: row.querySelector('.r-end').value,
      })).filter((r) => r.start && r.end);
      days.push({ weekday, ranges });
    }
    try {
      await send('/api/admin/working-hours', 'PUT', { days });
      toast('שעות הפעילות נשמרו');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- חסימות ----------
  async function loadExceptions() {
    const box = $('blocksList');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api('/api/admin/exceptions');
      clear(box);
      if (!data.exceptions.length) {
        box.appendChild(el('div', { class: 'card center hint', text: 'לא הוגדרו חסימות או חופשות.' }));
        return;
      }
      const labels = { block: 'חסימה', open: 'פתיחת שעות', vacation: 'חופשה' };
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['סוג', 'תאריך', 'שעות', 'סיבה', 'חוזר', ''].map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.exceptions.map((x) => el('tr', {}, [
          el('td', { text: labels[x.type] || x.type }),
          el('td', { text: x.end_date ? `${formatIL(x.date)} - ${formatIL(x.end_date)}` : formatIL(x.date) }),
          el('td', { text: x.start_time ? `${x.start_time} - ${x.end_time}` : 'כל היום' }),
          el('td', { text: x.reason || '' }),
          el('td', { text: x.recurring ? 'כן' : '' }),
          el('td', {}, [el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: 'מחיקה',
            onclick: async () => {
              if (!confirm('למחוק את הרשומה?')) return;
              try { await send(`/api/admin/exceptions/${x.id}`, 'DELETE'); toast('נמחק'); loadExceptions(); }
              catch (e) { toast(e.message, 'error'); }
            },
          })]),
        ]))),
      ]);
      box.appendChild(el('div', { class: 'card table-wrap' }, [table]));
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function addException() {
    const err = $('excError');
    err.classList.add('hidden');
    const payload = {
      type: $('excType').value,
      date: $('excDate').value,
      endDate: $('excEndDate').value || null,
      startTime: $('excStart').value || null,
      endTime: $('excEnd').value || null,
      reason: $('excReason').value,
      recurring: $('excRecurring').checked,
    };
    try {
      await send('/api/admin/exceptions', 'POST', payload);
      toast('הרשומה נוספה');
      $('excReason').value = '';
      loadExceptions();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
  }

  // ---------- לקוחות ----------
  async function loadCustomers() {
    const box = $('customersList');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const q = $('custSearch').value.trim();
      const data = await api(`/api/admin/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      clear(box);
      if (!data.customers.length) {
        box.appendChild(el('div', { class: 'card center hint', text: 'לא נמצאו לקוחות.' }));
        return;
      }
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['שם', 'טלפון', 'תורים', 'תור אחרון', ''].map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.customers.map((c) => el('tr', {}, [
          el('td', { text: c.full_name }),
          el('td', {}, [el('a', { href: `tel:${c.phone}`, text: c.phone })]),
          el('td', { text: String(c.visits) }),
          el('td', { text: c.last_visit ? formatIL(c.last_visit) : '' }),
          el('td', {}, [el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'כרטיס', onclick: () => customerCard(c) })]),
        ]))),
      ]);
      box.appendChild(el('div', { class: 'card table-wrap' }, [table]));
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function customerCard(c) {
    const data = await api(`/api/admin/customers/${c.id}`);
    openModal(`כרטיס לקוחה: ${data.customer.full_name}`, (body, close) => {
      const name = inputField(body, 'שם מלא', 'text', data.customer.full_name);
      const phone = inputField(body, 'טלפון', 'tel', data.customer.phone);
      const email = inputField(body, 'דואר אלקטרוני', 'email', data.customer.email || '');
      const notes = textareaField(body, 'הערות פנימיות', data.customer.notes || '');
      const err = el('div', { class: 'alert error hidden' });
      body.appendChild(err);
      body.appendChild(el('div', { class: 'btn-row' }, [
        el('button', {
          class: 'btn', type: 'button', text: 'שמירה',
          onclick: async () => {
            try {
              await send(`/api/admin/customers/${c.id}`, 'PATCH', {
                full_name: name.value, phone: phone.value, email: email.value, notes: notes.value,
              });
              close(); toast('פרטי הלקוחה עודכנו'); loadCustomers();
            } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
          },
        }),
        el('button', {
          class: 'btn btn-danger', type: 'button', text: 'מחיקת פרטים',
          onclick: async () => {
            if (!confirm('למחוק את פרטי הלקוחה? התורים יישמרו ללא זיהוי.')) return;
            try {
              await send(`/api/admin/customers/${c.id}`, 'DELETE');
              close(); toast('פרטי הלקוחה נמחקו'); loadCustomers();
            } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
          },
        }),
      ]));
      body.appendChild(el('h4', { text: `היסטוריית תורים (${data.appointments.length})` }));
      const list = el('div', { class: 'stack' });
      for (const a of data.appointments) {
        list.appendChild(el('div', { class: 'tl-slot' }, [
          el('span', { class: 't', text: a.dateIL }),
          el('span', { text: `${a.startTime} · ${a.service}` }),
          el('span', { class: 'pill ' + statusClass(a.status), text: a.statusLabel }),
        ]));
      }
      body.appendChild(list);
    });
  }

  // ---------- רשימת המתנה ----------
  async function loadWaitlist() {
    const box = $('waitlistList');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api('/api/admin/waitlist');
      clear(box);
      if (!data.waitlist.length) {
        box.appendChild(el('div', { class: 'card center hint', text: 'אין לקוחות ברשימת ההמתנה.' }));
        return;
      }
      const labels = { waiting: 'ממתינה', contacted: 'נוצר קשר', booked: 'נקבע תור', closed: 'סגור' };
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['תאריך מבוקש', 'שם', 'טלפון', 'טיפול', 'טווח שעות', 'סטטוס', ''].map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.waitlist.map((w) => el('tr', {}, [
          el('td', { text: formatIL(w.desired_date) }),
          el('td', { text: w.full_name }),
          el('td', {}, [el('a', { href: `tel:${w.phone}`, text: w.phone })]),
          el('td', { text: w.service_name || '' }),
          el('td', { text: w.time_from ? `${w.time_from}-${w.time_to || ''}` : 'גמיש' }),
          el('td', {}, [selectInline(Object.entries(labels), w.status, async (value) => {
            try { await send(`/api/admin/waitlist/${w.id}`, 'PATCH', { status: value }); toast('עודכן'); }
            catch (e) { toast(e.message, 'error'); }
          })]),
          el('td', {}, [el('button', {
            class: 'btn btn-sm btn-danger', type: 'button', text: 'מחיקה',
            onclick: async () => {
              if (!confirm('למחוק מרשימת ההמתנה?')) return;
              try { await send(`/api/admin/waitlist/${w.id}`, 'DELETE'); loadWaitlist(); }
              catch (e) { toast(e.message, 'error'); }
            },
          })]),
        ]))),
      ]);
      box.appendChild(el('div', { class: 'card table-wrap' }, [table]));
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  // ---------- הגדרות ----------
  const SETTING_FIELDS = [
    ['business_name', 'שם העסק', 'text'],
    ['page_title', 'כותרת ראשית ללקוחה', 'text'],
    ['intro_text', 'מלל פתיחה', 'textarea'],
    ['address', 'כתובת העסק', 'text'],
    ['phone', 'טלפון', 'tel'],
    ['whatsapp', 'מספר וואטסאפ', 'tel'],
    ['logo_url', 'כתובת לוגו', 'text'],
    ['public_base_url', 'כתובת האתר (לקישורים אישיים)', 'text'],
    ['slot_step_min', 'מרווח בין שעות מוצגות (דקות)', 'number'],
    ['min_lead_hours', 'זמן מינימלי להזמנה מראש (שעות)', 'number'],
    ['max_advance_days', 'עד כמה ימים קדימה היומן פתוח', 'number'],
    ['cancel_cutoff_hours', 'עד כמה שעות לפני ניתן לבטל', 'number'],
    ['auto_approve', 'אישור אוטומטי של תורים', 'bool'],
    ['waitlist_enabled', 'רשימת המתנה פעילה', 'bool'],
    ['payments_enabled', 'גביית מקדמה פעילה', 'bool'],
    ['cancellation_policy', 'מדיניות ביטולים', 'textarea'],
    ['terms_text', 'תנאי שימוש', 'textarea'],
    ['privacy_text', 'מדיניות פרטיות', 'textarea'],
  ];

  async function loadSettings() {
    const box = $('settingsForm');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api('/api/admin/settings');
      state.settings = data.settings;
      clear(box);
      for (const [key, label, type] of SETTING_FIELDS) {
        const value = data.settings[key] ?? '';
        if (type === 'bool') checkboxField(box, label, value === '1', key);
        else if (type === 'textarea') textareaField(box, label, value, key);
        else inputField(box, label, type, value, key);
      }
      loadAdmins();
      loadAudit();
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function saveSettings() {
    const settings = {};
    for (const [key, , type] of SETTING_FIELDS) {
      const node = document.querySelector(`#settingsForm [data-key="${key}"]`);
      if (!node) continue;
      settings[key] = type === 'bool' ? (node.checked ? '1' : '0') : node.value;
    }
    try {
      await send('/api/admin/settings', 'PUT', { settings });
      toast('ההגדרות נשמרו');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function loadAdmins() {
    const box = $('adminsList');
    clear(box);
    try {
      const data = await api('/api/admin/admins');
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['שם', 'שם משתמש', 'הרשאה', 'פעיל'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.admins.map((a) => el('tr', {}, [
          el('td', { text: a.name }),
          el('td', { text: a.username }),
          el('td', { text: a.role === 'owner' ? 'בעלים' : 'מנהל' }),
          el('td', { text: a.active ? 'כן' : 'לא' }),
        ]))),
      ]);
      box.appendChild(el('div', { class: 'table-wrap' }, [table]));
      box.appendChild(el('p', { class: 'hint', text: 'הוספת משתמש ניהול נוסף מתבצעת בשרת: npm run create-admin' }));
    } catch (e) {
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function loadAudit() {
    const box = $('auditList');
    clear(box);
    try {
      const data = await api('/api/admin/audit');
      if (!data.log.length) { box.appendChild(el('p', { class: 'hint', text: 'אין רישומים.' })); return; }
      const table = el('table', {}, [
        el('thead', {}, [el('tr', {}, ['מועד', 'מנהל', 'פעולה', 'פריט'].map((h) => el('th', { text: h })))]),
        el('tbody', {}, data.log.slice(0, 60).map((r) => el('tr', {}, [
          el('td', { text: r.created_at }),
          el('td', { text: r.admin_name || '' }),
          el('td', { text: r.action }),
          el('td', { text: `${r.entity || ''} ${r.entity_id || ''}` }),
        ]))),
      ]);
      box.appendChild(el('div', { class: 'table-wrap' }, [table]));
    } catch (e) {
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  async function changePassword() {
    try {
      await send('/api/admin/password', 'POST', {
        currentPassword: $('curPass').value,
        newPassword: $('newPass').value,
      });
      $('curPass').value = ''; $('newPass').value = '';
      toast('הסיסמה עודכנה');
    } catch (e) { toast(e.message, 'error'); }
  }

  // ---------- רכיבי טופס ----------
  function fieldWrap(parent, label, control) {
    parent.appendChild(el('div', { class: 'field' }, [el('label', { text: label }), control]));
    return control;
  }
  function inputField(parent, label, type, value, key) {
    return fieldWrap(parent, label, el('input', { type, value: value ?? '', dataset: key ? { key } : {} }));
  }
  function textareaField(parent, label, value, key) {
    const t = el('textarea', { dataset: key ? { key } : {} });
    t.value = value ?? '';
    return fieldWrap(parent, label, t);
  }
  function selectField(parent, label, options, value) {
    const sel = el('select', {}, options.map(([v, t]) => el('option', { value: v, text: t, selected: String(v) === String(value) })));
    sel.value = String(value);
    return fieldWrap(parent, label, sel);
  }
  function checkboxField(parent, label, checked, key) {
    const input = el('input', { type: 'checkbox', dataset: key ? { key } : {} });
    input.checked = !!checked;
    parent.appendChild(el('label', { class: 'checkbox' }, [input, el('span', { text: label })]));
    return input;
  }
  function selectInline(options, value, onChange) {
    const sel = el('select', { style: 'min-height:38px' }, options.map(([v, t]) => el('option', { value: v, text: t })));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }

  function openModal(title, builder) {
    const root = $('modalRoot');
    clear(root);
    const body = el('div');
    const close = () => clear(root);
    const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, [
      el('div', { class: 'modal' }, [
        el('div', { class: 'row-between' }, [
          el('h3', { text: title }),
          el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'סגירה', onclick: close }),
        ]),
        body,
      ]),
    ]);
    root.appendChild(backdrop);
    builder(body, close);
  }

  // ---------- אתחול ----------
  document.addEventListener('DOMContentLoaded', () => {
    $('loginForm').addEventListener('submit', doLogin);
    $('btnLogout').addEventListener('click', async () => {
      await api('/api/admin/logout', { method: 'POST', admin: true }).catch(() => {});
      location.reload();
    });
    bindTabs();
    for (const b of document.querySelectorAll('.view-btn')) {
      b.addEventListener('click', () => setView(b.dataset.view));
    }
    $('btnToday').addEventListener('click', () => { state.date = todayISO(); loadCalendar(); });
    $('btnNewAppt').addEventListener('click', newAppointmentModal);
    $('btnFilter').addEventListener('click', loadAppointments);
    $('fltQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAppointments(); });
    $('btnNewService').addEventListener('click', () => serviceModal(null));
    $('btnSaveHours').addEventListener('click', saveHours);
    $('btnAddException').addEventListener('click', addException);
    $('custSearch').addEventListener('input', debounce(loadCustomers, 350));
    $('btnSaveSettings').addEventListener('click', saveSettings);
    $('btnChangePass').addEventListener('click', changePassword);
    checkAuth();
  });

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }
})();
