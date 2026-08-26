/* עזרים משותפים לכל מסכי המערכת */
(function () {
  'use strict';

  const STORE_KEY = 'lola_my_appointments';

  async function api(path, options = {}) {
    const opts = Object.assign({ headers: {} }, options);
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    if (opts.admin) opts.headers['X-Requested-With'] = 'lola-admin';
    opts.credentials = 'same-origin';
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new Error('אין חיבור לאינטרנט. יש לבדוק את החיבור ולנסות שוב.');
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok || data.ok === false) {
      const err = new Error((data && data.error) || 'אירעה שגיאה. יש לנסות שוב.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const child of [].concat(children)) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  let toastTimer = null;
  function toast(message, kind = '') {
    let box = document.querySelector('.toast');
    if (!box) {
      box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(box);
    }
    box.className = 'toast show ' + kind;
    box.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = 'toast ' + kind; }, 4000);
  }

  function formatIL(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }

  function money(value) {
    if (value === null || value === undefined || value === '') return '';
    return '₪' + Number(value).toLocaleString('he-IL');
  }

  function duration(min) {
    const m = Number(min) || 0;
    if (m < 60) return `${m} דקות`;
    const h = Math.floor(m / 60), rest = m % 60;
    const hourText = h === 1 ? 'שעה' : `${h} שעות`;
    return rest ? `${hourText} ו-${rest} דקות` : hourText;
  }

  /** שמירת קישורי הניהול של הלקוחה במכשיר שלה בלבד (ללא חשיפת מידע לאחרים) */
  function savedTokens() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
  }
  function saveToken(token) {
    if (!token) return;
    const list = savedTokens().filter((t) => t !== token);
    list.unshift(token);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 20))); } catch { /* מצב פרטי */ }
  }
  function removeToken(token) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(savedTokens().filter((t) => t !== token))); } catch { /* ignore */ }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => { /* לא קריטי */ });
      });
    }
  }

  window.Lola = {
    api, el, clear, toast, formatIL, money, duration,
    savedTokens, saveToken, removeToken, escapeHtml, registerServiceWorker,
  };
})();
