/* ממשק הלקוחה – תהליך קביעת התור (סעיפים 4–14) */
(function () {
  'use strict';
  const { api, el, clear, toast, formatIL, money, duration, saveToken, savedTokens, removeToken } = window.Lola;

  const state = {
    config: null,
    services: [],
    service: null,
    date: null,
    time: null,
    slotEnd: null,
    details: null,
    calYear: null,
    calMonth: null,
    result: null,
  };

  const $ = (id) => document.getElementById(id);
  const screens = ['welcome', 'service', 'date', 'details', 'confirm', 'success', 'my'];

  function show(name, step) {
    for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
    const steps = $('steps');
    steps.classList.toggle('hidden', !step);
    if (step) {
      const order = ['service', 'date', 'time', 'details', 'confirm'];
      const idx = order.indexOf(step);
      [...steps.children].forEach((li, i) => {
        li.classList.toggle('active', i === idx);
        li.classList.toggle('done', i < idx);
      });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- טעינת הגדרות ----------
  async function loadConfig() {
    const cfg = await api('/api/config');
    state.config = cfg;
    document.title = cfg.pageTitle || 'קביעת תור אצל לולה';
    $('brandName').textContent = cfg.businessName || '';
    $('pageTitle').textContent = cfg.pageTitle || 'קביעת תור אצל לולה';
    $('introText').textContent = cfg.introText || '';
    if (cfg.logoUrl) { const l = $('logo'); l.src = cfg.logoUrl; l.alt = cfg.businessName || ''; l.classList.remove('hidden'); }

    const lines = [cfg.address, cfg.phone].filter(Boolean).join(' · ');
    $('contactLines').textContent = lines || 'ניתן ליצור קשר עם לולה בכל שאלה.';
    $('footerContact').textContent = lines;
    if (cfg.whatsapp) {
      const wa = $('waLink');
      wa.href = `https://wa.me/${String(cfg.whatsapp).replace(/\D/g, '').replace(/^0/, '972')}`;
      wa.classList.remove('hidden');
    }
    if (cfg.phone) {
      const t = $('telLink');
      t.href = `tel:${String(cfg.phone).replace(/[^\d+]/g, '')}`;
      t.classList.remove('hidden');
    }
    $('policyBox').textContent = cfg.cancellationPolicy || '';
  }

  // ---------- טיפולים ----------
  async function loadServices() {
    const box = $('serviceList');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api('/api/services');
      state.services = data.services;
      clear(box);
      if (!data.services.length) {
        box.appendChild(el('div', { class: 'alert info', text: 'בשלב זה אין טיפולים פתוחים להזמנה. ניתן ליצור קשר עם לולה.' }));
        return;
      }
      for (const s of data.services) box.appendChild(serviceCard(s));
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  function serviceCard(s) {
    const meta = el('div', { class: 'meta' }, [
      el('span', { class: 'pill', text: duration(s.durationMin) }),
      s.price ? el('span', { class: 'pill gold', text: money(s.price) }) : null,
      s.requiresApproval ? el('span', { class: 'pill gray', text: 'דורש אישור' }) : null,
      s.depositRequired ? el('span', { class: 'pill gray', text: 'נדרשת מקדמה' }) : null,
    ]);
    return el('button', {
      class: 'service', type: 'button',
      onclick: () => chooseService(s),
    }, [
      s.imageUrl ? el('img', { src: s.imageUrl, alt: s.name, loading: 'lazy' }) : el('div', { class: 'thumb', text: '💅' }),
      el('div', { class: 'info' }, [
        el('div', { class: 'name', text: s.name }),
        s.description ? el('div', { class: 'desc', text: s.description }) : null,
        meta,
      ]),
      el('span', { class: 'pill', text: 'בחירה' }),
    ]);
  }

  function chooseService(s) {
    state.service = s;
    state.date = null;
    state.time = null;
    const today = state.config.today;
    state.calYear = Number(today.slice(0, 4));
    state.calMonth = Number(today.slice(5, 7));
    renderChosenService();
    $('slotsArea').classList.add('hidden');
    show('date', 'date');
    loadCalendar();
  }

  function renderChosenService() {
    const s = state.service;
    const box = $('chosenServiceBox');
    clear(box);
    box.appendChild(el('div', { class: 'row-between' }, [
      el('div', {}, [
        el('div', { class: 'name', text: s.name, style: 'font-weight:700;color:var(--plum-700);font-size:18px' }),
        el('div', { class: 'hint', style: 'margin:2px 0 0', text: `${duration(s.durationMin)}${s.price ? ' · ' + money(s.price) : ''}` }),
      ]),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'החלפת טיפול', onclick: () => show('service', 'service') }),
    ]));
  }

  // ---------- לוח שנה ----------
  async function loadCalendar() {
    const box = $('calendar');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api(`/api/calendar?service_id=${state.service.id}&year=${state.calYear}&month=${state.calMonth}`);
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
    const curY = Number(today.slice(0, 4));
    const curM = Number(today.slice(5, 7));
    const maxDate = addDaysISO(today, state.config.maxAdvanceDays);
    const maxY = Number(maxDate.slice(0, 4));
    const maxM = Number(maxDate.slice(5, 7));

    const atFirst = data.year === curY && data.month === curM;
    const atLast = data.year > maxY || (data.year === maxY && data.month >= maxM);

    box.appendChild(el('div', { class: 'cal-head' }, [
      el('button', {
        class: 'cal-nav', type: 'button', 'aria-label': 'החודש הקודם', text: '›',
        disabled: atFirst, onclick: () => moveMonth(-1),
      }),
      el('div', { class: 'cal-title', text: `${data.monthName} ${data.year}` }),
      el('button', {
        class: 'cal-nav', type: 'button', 'aria-label': 'החודש הבא', text: '‹',
        disabled: atLast, onclick: () => moveMonth(1),
      }),
    ]));

    const grid = el('div', { class: 'cal-grid' });
    for (const d of state.config.dayNames) grid.appendChild(el('div', { class: 'cal-dow', text: d.slice(0, 3) }));
    for (let i = 0; i < data.firstWeekday; i++) grid.appendChild(el('div', { class: 'cal-day empty' }));

    for (const day of data.days) {
      const num = Number(day.date.slice(8, 10));
      const label = {
        available: 'זמין', full: 'תפוס', closed: 'סגור', past: 'עבר', locked: 'סגור',
      }[day.status] || '';
      // יום מלא נשאר לחיץ כדי לאפשר הצטרפות לרשימת המתנה
      const waitlistable = day.status === 'full' && state.config.waitlistEnabled;
      const cls = ['cal-day', day.status];
      if (day.date === today) cls.push('today');
      if (day.date === state.date) cls.push('selected');
      grid.appendChild(el('button', {
        class: cls.join(' '), type: 'button',
        disabled: day.status !== 'available' && !waitlistable,
        dataset: { date: day.date },
        'aria-label': `${formatIL(day.date)} – ${label}`,
        title: waitlistable ? 'היום מלא – ניתן להצטרף לרשימת המתנה' : (day.reason || label),
        onclick: () => (day.status === 'available' ? chooseDate(day.date) : offerWaitlist(day.date)),
      }, [
        el('span', { text: String(num) }),
        day.status === 'available' ? el('i', { class: 'dot' }) : null,
      ]));
    }
    box.appendChild(grid);
  }

  function moveMonth(delta) {
    let m = state.calMonth + delta;
    let y = state.calYear;
    if (m < 1) { m = 12; y--; }
    if (m > 12) { m = 1; y++; }
    state.calMonth = m;
    state.calYear = y;
    loadCalendar();
  }

  function addDaysISO(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
    return dt.toISOString().slice(0, 10);
  }

  // ---------- שעות ----------
  async function chooseDate(date) {
    state.date = date;
    state.time = null;
    renderCalendarSelection();
    const area = $('slotsArea');
    area.classList.remove('hidden');
    const box = $('slotsBox');
    clear(box);
    box.appendChild(el('div', { class: 'spinner' }));
    show('date', 'time');
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const data = await api(`/api/slots?service_id=${state.service.id}&date=${date}`);
      renderSlots(data);
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  function renderCalendarSelection() {
    for (const btn of document.querySelectorAll('.cal-day')) {
      btn.classList.toggle('selected', btn.dataset.date === state.date);
    }
  }

  function renderSlots(data) {
    const box = $('slotsBox');
    clear(box);
    $('slotsTitle').textContent = `שעות פנויות ליום ${data.dayName}, ${data.dateIL}`;
    $('slotsHint').textContent = `משך הטיפול: ${duration(data.durationMin)}. מוצגות רק שעות שבהן קיימת זמינות מלאה.`;

    if (!data.open) {
      box.appendChild(el('div', { class: 'alert info', text: data.closedReason || 'ביום זה אין קבלת קהל.' }));
      return;
    }
    const visible = data.slots.filter((s) => s.status !== 'past');
    if (!visible.length) {
      box.appendChild(el('div', { class: 'alert info', text: 'לא נותרו שעות פנויות ביום זה.' }));
      if (state.config.waitlistEnabled) {
        box.appendChild(el('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'הצטרפות לרשימת המתנה ליום זה', onclick: () => offerWaitlist(data.date) }));
      }
      return;
    }

    const grid = el('div', { class: 'slots' });
    for (const s of visible) {
      const labels = { free: '', taken: 'תפוס', blocked: 'לא זמין' };
      grid.appendChild(el('button', {
        class: `slot ${s.status}`, type: 'button', disabled: s.status !== 'free',
        'aria-label': `${s.time} ${labels[s.status] || 'פנוי'}`,
        onclick: (ev) => chooseTime(s, ev),
      }, [
        el('span', { text: s.time }),
        el('small', { text: s.status === 'free' ? `עד ${s.end}` : labels[s.status] }),
      ]));
    }
    box.appendChild(grid);

    if (data.freeCount === 0 && state.config.waitlistEnabled) {
      box.appendChild(el('p', { class: 'center' }, [
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'הצטרפות לרשימת המתנה ליום זה', onclick: () => offerWaitlist(data.date) }),
      ]));
    }
  }

  function chooseTime(slot, ev) {
    state.time = slot.time;
    state.slotEnd = slot.end;
    for (const b of document.querySelectorAll('.slot')) b.classList.remove('selected');
    if (ev && ev.currentTarget) ev.currentTarget.classList.add('selected');
    show('details', 'details');
    if (state.details) fillDetails(state.details);
  }

  // ---------- פרטים ----------
  function fillDetails(d) {
    $('fullName').value = d.fullName || '';
    $('phone').value = d.phone || '';
    $('email').value = d.email || '';
    $('note').value = d.note || '';
    $('sensitivities').value = d.sensitivities || '';
    $('firstVisit').checked = !!d.firstVisit;
    $('acceptTerms').checked = !!d.acceptTerms;
  }

  function validPhone(raw) {
    let s = String(raw || '').replace(/[^\d+]/g, '');
    if (s.startsWith('+972')) s = '0' + s.slice(4);
    s = s.replace(/\D/g, '');
    return /^0(5\d|[23489]|7\d)\d{7}$/.test(s) ? s : null;
  }

  function onDetailsSubmit(e) {
    e.preventDefault();
    const err = $('detailsError');
    err.classList.add('hidden');
    const fullName = $('fullName').value.trim();
    const phone = validPhone($('phone').value);
    const email = $('email').value.trim();

    if (fullName.length < 2) return showError(err, 'יש להזין שם מלא.');
    if (!phone) return showError(err, 'יש להזין מספר טלפון נייד תקין, לדוגמה 0501234567.');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return showError(err, 'כתובת הדואר האלקטרוני אינה תקינה.');
    if (!$('acceptTerms').checked) return showError(err, 'יש לאשר את תנאי השימוש ומדיניות הביטולים.');

    state.details = {
      fullName, phone, email,
      note: $('note').value.trim(),
      sensitivities: $('sensitivities').value.trim(),
      firstVisit: $('firstVisit').checked,
      acceptTerms: true,
    };
    renderSummary();
    show('confirm', 'confirm');
  }

  function showError(node, message) {
    node.textContent = message;
    node.classList.remove('hidden');
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- סיכום ואישור ----------
  function renderSummary() {
    const list = $('summaryList');
    clear(list);
    const rows = [
      ['הטיפול', state.service.name],
      ['משך הטיפול', duration(state.service.durationMin)],
      ['מחיר', state.service.price ? money(state.service.price) : 'ייקבע במקום'],
      ['תאריך', `${formatIL(state.date)} (יום ${dayNameOf(state.date)})`],
      ['שעה', `${state.time} - ${state.slotEnd}`],
      ['שם', state.details.fullName],
      ['טלפון', state.details.phone],
    ];
    if (state.details.note) rows.push(['הערה', state.details.note]);
    for (const [k, v] of rows) {
      list.appendChild(el('li', {}, [el('span', { class: 'k', text: k }), el('span', { class: 'v', text: v })]));
    }
  }

  function dayNameOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return state.config.dayNames[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  async function confirmBooking() {
    const btn = $('btnConfirm');
    const err = $('confirmError');
    err.classList.add('hidden');
    btn.disabled = true;
    btn.textContent = 'שומרת את התור...';
    try {
      const data = await api('/api/book', {
        method: 'POST',
        body: {
          serviceId: state.service.id,
          date: state.date,
          time: state.time,
          ...state.details,
        },
      });
      state.result = data;
      saveToken(data.appointment.manageToken);
      renderSuccess(data);
      show('success', null);
    } catch (e) {
      showError(err, e.message);
      if (e.status === 409) {
        err.appendChild(el('p', {}, [
          el('button', { class: 'btn btn-sm', type: 'button', text: 'חזרה לבחירת שעה', onclick: () => { show('date', 'time'); chooseDate(state.date); } }),
        ]));
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'אישור וקביעת התור';
    }
  }

  function renderSuccess(data) {
    const a = data.appointment;
    $('successText').textContent =
      `מחכות לך אצל ${state.config.businessName} בתאריך ${a.dateIL}, בשעה ${a.startTime}, לטיפול ${a.service}.`;
    $('pendingNote').classList.toggle('hidden', a.status !== 'pending');
    $('icsLink').href = data.calendar.ics;
    $('googleLink').href = data.calendar.google;
    $('outlookLink').href = data.calendar.outlook;
    $('manageLink').href = a.manageUrl;
    $('manageLink').textContent = a.manageUrl;
    $('btnGoManage').href = a.manageUrl;
  }

  // ---------- רשימת המתנה ----------
  function offerWaitlist(date) {
    if (!state.config.waitlistEnabled) { toast('היום מלא. ניתן לבחור יום אחר.'); return; }
    openModal('רשימת המתנה', (body, close) => {
      body.appendChild(el('p', { class: 'hint', text: `היום ${formatIL(date)} מלא. ניתן להשאיר פרטים ולולה תיצור קשר אם יתפנה מקום.` }));
      const name = inputField(body, 'שם מלא', 'text', state.details?.fullName || '');
      const phone = inputField(body, 'טלפון נייד', 'tel', state.details?.phone || '');
      const from = inputField(body, 'משעה (לא חובה)', 'time', '');
      const to = inputField(body, 'עד שעה (לא חובה)', 'time', '');
      const err = el('div', { class: 'alert error hidden' });
      body.appendChild(err);
      body.appendChild(el('button', {
        class: 'btn btn-block', type: 'button', text: 'הצטרפות לרשימת ההמתנה',
        onclick: async () => {
          const tel = validPhone(phone.value);
          if (name.value.trim().length < 2) return showError(err, 'יש להזין שם מלא.');
          if (!tel) return showError(err, 'יש להזין מספר טלפון תקין.');
          try {
            const res = await api('/api/waitlist', {
              method: 'POST',
              body: {
                fullName: name.value.trim(), phone: tel, serviceId: state.service.id,
                date, timeFrom: from.value || null, timeTo: to.value || null,
              },
            });
            close();
            toast(res.message || 'נרשמת לרשימת ההמתנה.');
          } catch (e) { showError(err, e.message); }
        },
      }));
    });
  }

  function inputField(parent, label, type, value) {
    const id = 'f_' + Math.random().toString(36).slice(2, 8);
    const input = el('input', { type, id, value: value || '' });
    parent.appendChild(el('div', { class: 'field' }, [el('label', { for: id, text: label }), input]));
    return input;
  }

  // ---------- מודאל ----------
  function openModal(title, builder) {
    const root = $('modalRoot');
    clear(root);
    const body = el('div');
    const close = () => clear(root);
    const backdrop = el('div', {
      class: 'modal-backdrop',
      onclick: (e) => { if (e.target === backdrop) close(); },
    }, [
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
    return close;
  }

  // ---------- התורים שלי ----------
  async function loadMine() {
    const box = $('myList');
    clear(box);
    const tokens = savedTokens();
    if (!tokens.length) {
      box.appendChild(el('div', { class: 'alert info', text: 'לא נמצאו תורים ששמורים במכשיר זה.' }));
      return;
    }
    box.appendChild(el('div', { class: 'spinner' }));
    try {
      const data = await api('/api/my-appointments', { method: 'POST', body: { tokens } });
      clear(box);
      if (!data.appointments.length) {
        box.appendChild(el('div', { class: 'alert info', text: 'לא נמצאו תורים.' }));
        return;
      }
      for (const a of data.appointments) {
        const cancelled = a.status.startsWith('cancelled');
        box.appendChild(el('div', { class: 'card' }, [
          el('div', { class: 'row-between' }, [
            el('div', {}, [
              el('div', { style: 'font-weight:700;font-size:18px;color:var(--plum-700)', text: `${a.dateIL} · ${a.startTime}` }),
              el('div', { class: 'hint', style: 'margin:2px 0', text: `${a.service} · ${duration(a.durationMin)}` }),
            ]),
            el('span', { class: 'pill ' + (cancelled ? 'red' : 'green'), text: a.statusLabel }),
          ]),
          el('div', { class: 'btn-row' }, [
            el('a', { class: 'btn btn-ghost btn-sm', href: a.manageUrl, text: 'ניהול התור' }),
            cancelled ? el('button', {
              class: 'btn btn-ghost btn-sm', type: 'button', text: 'הסרה מהרשימה',
              onclick: () => { removeToken(a.manageToken); loadMine(); },
            }) : null,
          ]),
        ]));
      }
    } catch (e) {
      clear(box);
      box.appendChild(el('div', { class: 'alert error', text: e.message }));
    }
  }

  // ---------- אתחול ----------
  function bind() {
    $('btnStart').addEventListener('click', () => { show('service', 'service'); loadServices(); });
    $('btnMine').addEventListener('click', () => { show('my', null); loadMine(); });
    $('detailsForm').addEventListener('submit', onDetailsSubmit);
    $('btnConfirm').addEventListener('click', confirmBooking);
    $('btnNewBooking').addEventListener('click', () => { state.date = state.time = null; show('service', 'service'); loadServices(); });
    $('btnCopyLink').addEventListener('click', async () => {
      const url = $('manageLink').href;
      try { await navigator.clipboard.writeText(url); toast('הקישור הועתק'); }
      catch { toast('לא ניתן להעתיק. ניתן לשמור את הקישור ידנית.', 'error'); }
    });
    for (const btn of document.querySelectorAll('[data-back]')) {
      btn.addEventListener('click', () => {
        const target = btn.dataset.back;
        const stepFor = { welcome: null, service: 'service', date: 'time', details: 'details' };
        show(target, stepFor[target]);
      });
    }
    const showTerms = (e) => {
      e.preventDefault();
      openModal('תנאי שימוש, פרטיות ומדיניות ביטולים', (body) => {
        body.appendChild(el('h4', { text: 'מדיניות ביטולים' }));
        body.appendChild(el('p', { text: state.config.cancellationPolicy || '' }));
        body.appendChild(el('h4', { text: 'תנאי שימוש' }));
        body.appendChild(el('p', { text: state.config.termsText || '' }));
        body.appendChild(el('h4', { text: 'פרטיות' }));
        body.appendChild(el('p', { text: state.config.privacyText || '' }));
      });
    };
    $('termsLink').addEventListener('click', showTerms);
    $('privacyLink').addEventListener('click', showTerms);
  }

  async function init() {
    bind();
    window.Lola.registerServiceWorker();
    try {
      await loadConfig();
    } catch (e) {
      document.querySelector('.page').prepend(el('div', { class: 'alert error', text: e.message }));
      return;
    }
    if (location.hash === '#mine') {
      show('my', null);
      loadMine();
    } else if (location.pathname === '/book' || location.hash === '#book') {
      show('service', 'service');
      loadServices();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
