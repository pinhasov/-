'use strict';

/* ================= הגדרות קבועות ================= */
const MAX_FILES = 100;
const TILE = 160;          // גודל אריח (פיקסלים בתמונת הקלט)
const TILE_PAD = 16;       // שוליים חופפים סביב כל אריח – מונע תפרים
const MODELS = {
  fast: { lib: () => window.ESRGANMedium, base: 'models/fast' },
  max:  { lib: () => window.ESRGANThick,  base: 'models/max' },
};
const SETTINGS_KEY = 'photo-enhancer-settings';
const DEFAULTS = {
  quality: 'fast', scale: 'auto', maxEdge: '6000',
  levels: true, vibrance: true, sharpen: true, format: 'image/jpeg',
};

const $ = (id) => document.getElementById(id);
const els = {
  engine: $('engine'), drop: $('drop'), files: $('files'), list: $('list'),
  start: $('start'), stop: $('stop'), zip: $('zip'), folder: $('folder'), clear: $('clear'),
  summary: $('summary'), overallBar: $('overallBar'), rowTpl: $('rowTpl'),
  compare: $('compare'), cmpTitle: $('cmpTitle'), cmpClose: $('cmpClose'), cmpStage: $('cmpStage'),
  cmpAfter: $('cmpAfter'), cmpBefore: $('cmpBefore'), cmpBeforeWrap: $('cmpBeforeWrap'), cmpLine: $('cmpLine'),
};

/* ================= הגדרות משתמש ================= */
const settingIds = Object.keys(DEFAULTS);
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* אין גישה לאחסון */ }
  const s = { ...DEFAULTS, ...saved };
  for (const id of settingIds) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!s[id]; else el.value = s[id];
    el.addEventListener('change', saveSettings);
  }
}
function readSettings() {
  const s = {};
  for (const id of settingIds) { const el = $(id); s[id] = el.type === 'checkbox' ? el.checked : el.value; }
  return s;
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings())); } catch { /* לא קריטי */ }
}

/* ================= מנוע AI ================= */
// בגרסת הרשת קבצי המשקלים של המודל מתפרסמים כטקסט base64 (‎.b64.txt) –
// אם ‎.bin לא נמצא, טוענים את גרסת הטקסט וממירים חזרה לבינארי.
{
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!/(^|\/)models\/.+\.bin$/.test(url)) return origFetch(input, init);
    const res = await origFetch(url, init).catch(() => null);
    if (res && res.ok) return res;
    const alt = await origFetch(url.replace(/\.bin$/, '.b64.txt'), init);
    if (!alt.ok) return alt;
    const bin = atob((await alt.text()).trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  };
}

const upscalers = new Map();
async function initEngine() {
  try {
    await tf.setBackend('webgl');
  } catch { /* ננסה את ברירת המחדל */ }
  await tf.ready();
  const backend = tf.getBackend();
  els.engine.textContent = backend === 'webgl' ? 'מנוע: כרטיס מסך (WebGL) ✓' : 'מנוע: מעבד (איטי) – מומלץ Chrome עם האצת חומרה';
  els.engine.classList.toggle('warn', backend !== 'webgl');
}
function getUpscaler(quality, scale) {
  const key = `${quality}-x${scale}`;
  if (!upscalers.has(key)) {
    const m = MODELS[quality];
    const def = m.lib()[`x${scale}`];
    upscalers.set(key, new Upscaler({ model: { ...def, path: `${m.base}/x${scale}/model.json` } }));
  }
  return upscalers.get(key);
}

/* ================= תור העבודה ================= */
let items = [];
let nextId = 1;
let running = false;
let abortCtrl = null;

function addFiles(fileList) {
  const imgs = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name));
  const room = MAX_FILES - items.length;
  if (room <= 0) { notify(`אפשר לטעון עד ${MAX_FILES} תמונות בכל סבב. נקה את הרשימה או הסר תמונות.`, 'warn'); return; }
  if (imgs.length > room) notify(`נוספו ${room} תמונות בלבד – המקסימום הוא ${MAX_FILES} בכל סבב.`, 'warn');
  for (const file of imgs.slice(0, room)) {
    const item = { id: nextId++, file, status: 'pending', progress: 0, blob: null, url: null, origUrl: null, width: 0, height: 0, outW: 0, outH: 0, error: '' };
    items.push(item);
    item.row = createRow(item);
    els.list.appendChild(item.row);
    readMeta(item);
  }
  refresh();
}

async function readMeta(item) {
  try {
    const bmp = await createImageBitmap(item.file);
    item.width = bmp.width; item.height = bmp.height;
    bmp.close();
    const thumb = await createImageBitmap(item.file, item.width >= item.height ? { resizeWidth: 112, resizeQuality: 'medium' } : { resizeHeight: 112, resizeQuality: 'medium' });
    const c = document.createElement('canvas');
    c.width = thumb.width; c.height = thumb.height;
    c.getContext('2d').drawImage(thumb, 0, 0);
    thumb.close();
    item.row.querySelector('.thumb').src = c.toDataURL('image/jpeg', 0.8);
  } catch {
    item.status = 'error';
    item.error = 'הקובץ לא נקרא – פורמט לא נתמך';
  }
  renderRow(item);
  refresh();
}

function createRow(item) {
  const row = els.rowTpl.content.firstElementChild.cloneNode(true);
  row.querySelector('.name').textContent = item.file.name;
  row.querySelector('.compareBtn').addEventListener('click', () => openCompare(item));
  row.querySelector('.retryBtn').addEventListener('click', () => { item.status = 'pending'; item.error = ''; item.progress = 0; renderRow(item); refresh(); if (!running) runQueue(); });
  row.querySelector('.removeBtn').addEventListener('click', () => removeItem(item));
  row.querySelector('.downloadBtn').addEventListener('click', (e) => {
    if (!IN_ARTIFACT) return; // במחשב – קישור הורדה רגיל
    e.preventDefault();
    saveBlob(item.blob, outputName(item)).catch((err) => notify(`ההורדה נכשלה: ${friendlyError(err)}`, 'error'));
  });
  return row;
}

function removeItem(item) {
  if (item.status === 'working') return;
  if (item.url) URL.revokeObjectURL(item.url);
  if (item.origUrl) URL.revokeObjectURL(item.origUrl);
  item.row.remove();
  items = items.filter((i) => i !== item);
  refresh();
}

const STATUS_TEXT = { pending: 'ממתינה', working: 'בעיבוד', done: 'מוכנה ✓', error: 'שגיאה' };
function renderRow(item) {
  const r = item.row;
  r.dataset.status = item.status;
  const target = item.width ? planSize(item, readSettings()) : null;
  r.querySelector('.dims').textContent = item.width
    ? `${item.width}×${item.height}  ⟵  ${item.outW ? `${item.outW}×${item.outH}` : `${target.outW}×${target.outH}`}`
    : '';
  const st = item.status === 'working' ? `בעיבוד ${Math.round(item.progress * 100)}%` : STATUS_TEXT[item.status];
  r.querySelector('.status').textContent = item.error ? `${st}: ${item.error}` : st;
  r.querySelector('.bar > div').style.width = `${Math.round((item.status === 'done' ? 1 : item.progress) * 100)}%`;
  r.querySelector('.compareBtn').hidden = item.status !== 'done';
  const dl = r.querySelector('.downloadBtn');
  dl.hidden = item.status !== 'done' || (IN_ARTIFACT && !saver);
  if (item.url) { dl.href = item.url; dl.download = outputName(item); }
  r.querySelector('.retryBtn').hidden = item.status !== 'error' || !item.width;
  r.querySelector('.removeBtn').disabled = item.status === 'working';
}

function refresh() {
  const done = items.filter((i) => i.status === 'done').length;
  const pending = items.filter((i) => i.status === 'pending').length;
  const errors = items.filter((i) => i.status === 'error').length;
  els.start.disabled = running || pending === 0;
  els.stop.disabled = !running;
  els.zip.disabled = done === 0;
  els.zip.hidden = IN_ARTIFACT && !saver;
  els.folder.hidden = IN_ARTIFACT || !('showDirectoryPicker' in window);
  els.folder.disabled = done === 0;
  els.clear.disabled = running || items.length === 0;
  els.drop.classList.toggle('compact', items.length > 0);
  els.summary.textContent = items.length
    ? `${items.length} תמונות · ${done} מוכנות${errors ? ` · ${errors} שגיאות` : ''}${pending ? ` · ${pending} ממתינות` : ''}`
    : '';
  const working = items.find((i) => i.status === 'working');
  const total = items.filter((i) => i.status !== 'error').length || 1;
  els.overallBar.style.width = `${((done + (working ? working.progress : 0)) / total) * 100}%`;
}

async function runQueue() {
  if (running) return;
  running = true;
  abortCtrl = new AbortController();
  refresh();
  try {
    let item;
    while (!abortCtrl.signal.aborted && (item = items.find((i) => i.status === 'pending' && i.width))) {
      item.status = 'working'; item.progress = 0; item.error = '';
      renderRow(item); refresh();
      try {
        await processItem(item, readSettings(), abortCtrl.signal);
        item.status = 'done';
      } catch (err) {
        if (abortCtrl.signal.aborted) { item.status = 'pending'; item.progress = 0; }
        else { item.status = 'error'; item.error = friendlyError(err); console.error(err); }
      }
      renderRow(item); refresh();
    }
  } finally {
    running = false;
    refresh();
  }
}

function friendlyError(err) {
  const msg = String(err && err.message || err);
  if (/memory|OOM|allocate|context lost/i.test(msg)) return 'אין מספיק זיכרון – נסה גודל מקסימלי קטן יותר';
  return msg.slice(0, 120);
}

/* ================= צינור העיבוד ================= */
function planSize(item, s) {
  const long = Math.max(item.width, item.height);
  const maxEdge = Number(s.maxEdge);
  const scale = s.scale === 'auto' ? (long * 4 <= maxEdge && long <= 1200 ? 4 : 2) : Number(s.scale);
  const outLong = Math.min(long * scale, maxEdge);
  const ratio = outLong / long;
  const outW = Math.round(item.width * ratio);
  const outH = Math.round(item.height * ratio);
  // גודל הקלט למודל – כך שאחרי ההגדלה נגיע בדיוק ליעד
  const inW = Math.max(1, Math.round(outW / scale));
  const inH = Math.max(1, Math.round(outH / scale));
  return { scale, inW, inH, outW: inW * scale, outH: inH * scale };
}

async function processItem(item, s, signal) {
  const plan = planSize(item, s);
  const upscaler = getUpscaler(s.quality, plan.scale);

  // 1. פענוח והתאמת גודל הקלט (כולל סיבוב EXIF), על רקע לבן לתמונות שקופות
  const bmp = await createImageBitmap(item.file);
  const src = document.createElement('canvas');
  src.width = plan.inW; src.height = plan.inH;
  const sctx = src.getContext('2d');
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, plan.inW, plan.inH);
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(bmp, 0, 0, plan.inW, plan.inH);
  bmp.close();

  // 2. הגדלת AI באריחים
  const out = document.createElement('canvas');
  out.width = plan.outW; out.height = plan.outH;
  const octx = out.getContext('2d');
  await upscaleTiled(upscaler, src, octx, plan.scale, signal, (p) => {
    item.progress = p * 0.9; renderRow(item); refresh();
  });
  src.width = src.height = 0;

  // 3. שיפורים
  if (s.levels || s.vibrance || s.sharpen) {
    await tf.nextFrame();
    const img = octx.getImageData(0, 0, plan.outW, plan.outH);
    if (s.levels) autoLevels(img.data);
    if (s.vibrance) vibrance(img.data, 0.18);
    if (s.sharpen) unsharp(img, plan.scale >= 4 ? 0.35 : 0.5);
    octx.putImageData(img, 0, 0);
  }
  item.progress = 0.97; renderRow(item);

  // 4. קידוד
  const q = s.format === 'image/png' ? undefined : 0.95;
  const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('שמירת התמונה נכשלה – ייתכן שהיא גדולה מדי'))), s.format, q));
  out.width = out.height = 0;
  if (item.url) URL.revokeObjectURL(item.url);
  item.blob = blob;
  item.format = s.format;
  item.url = URL.createObjectURL(blob);
  item.outW = plan.outW; item.outH = plan.outH;
  item.progress = 1;
}

async function upscaleTiled(upscaler, srcCanvas, octx, scale, signal, onProgress) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const cols = Math.ceil(W / TILE), rows = Math.ceil(H / TILE);
  const total = cols * rows;
  const input = tf.browser.fromPixels(srcCanvas);
  try {
    let n = 0;
    for (let ty = 0; ty < rows; ty++) {
      for (let tx = 0; tx < cols; tx++) {
        if (signal.aborted) throw new Error('aborted');
        const x0 = tx * TILE, y0 = ty * TILE;
        const w = Math.min(TILE, W - x0), h = Math.min(TILE, H - y0);
        // אזור עם שוליים חופפים
        const px0 = Math.max(0, x0 - TILE_PAD), py0 = Math.max(0, y0 - TILE_PAD);
        const px1 = Math.min(W, x0 + w + TILE_PAD), py1 = Math.min(H, y0 + h + TILE_PAD);
        const patch = tf.slice(input, [py0, px0, 0], [py1 - py0, px1 - px0, 3]);
        let result;
        try {
          result = await upscaler.execute(patch, { output: 'tensor' });
        } finally {
          patch.dispose();
        }
        const pixels = tf.tidy(() => result.clipByValue(0, 255).round().toInt());
        result.dispose();
        const data = await tf.browser.toPixels(pixels);
        const [ph, pw] = pixels.shape;
        pixels.dispose();
        const imageData = new ImageData(data, pw, ph);
        // מדביקים רק את מרכז האריח, בלי השוליים
        const cx = (x0 - px0) * scale, cy = (y0 - py0) * scale;
        octx.putImageData(imageData, x0 * scale - cx, y0 * scale - cy, cx, cy, w * scale, h * scale);
        n++;
        onProgress(n / total);
        await tf.nextFrame();
      }
    }
  } finally {
    input.dispose();
  }
}

/* ---------- שיפורי תמונה ---------- */
function autoLevels(d) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  const count = d.length / 4;
  const pct = (p) => { let acc = 0; const lim = count * p; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lim) return v; } return 255; };
  let lo = pct(0.003), hi = pct(0.997);
  // תקרה – לא למתוח יותר מדי (כדי לא לשרוף תמונות כהות/בהירות במכוון)
  lo = Math.min(lo, 40); hi = Math.max(hi, 215);
  if (hi - lo < 10 || (lo <= 2 && hi >= 253)) return;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
}

function vibrance(d, amount) {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) / max;
    const k = amount * (1 - sat); // מחזק בעיקר צבעים חלשים – גוני עור נשארים טבעיים
    const avg = (r + g + b) / 3;
    d[i] = r + (r - avg) * k; d[i + 1] = g + (g - avg) * k; d[i + 2] = b + (b - avg) * k;
  }
}

// Unsharp mask על ערוץ הבהירות בלבד (טשטוש קופסה כפול ברדיוס 1)
function unsharp(img, amount) {
  const { width: w, height: h, data: d } = img;
  const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  const tmp = new Float32Array(w * h);
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const a = lum[row + (x > 0 ? x - 1 : x)], c = lum[row + x], b = lum[row + (x < w - 1 ? x + 1 : x)];
      tmp[row + x] = (a + 2 * c + b) * 0.25;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w, row = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) blur[row + x] = (tmp[up + x] + 2 * tmp[row + x] + tmp[dn + x]) * 0.25;
  }
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    let diff = (lum[p] - blur[p]) * amount;
    if (diff > 24) diff = 24; else if (diff < -24) diff = -24; // מונע הילות
    d[i] += diff; d[i + 1] += diff; d[i + 2] += diff;
  }
}

/* ================= הורדות ================= */
// בגרסת הרשת (קישור) הדפדפן חוסם הורדות ישירות – ההורדה עוברת דרך אישור של הצופה
const IN_ARTIFACT = typeof window.claude?.use === 'function';
let saver = null;
if (IN_ARTIFACT) {
  window.claude.use('downloads').then((d) => {
    saver = d;
    if (!d) notify('ההורדה לא זמינה בתצוגה הזו. פתח את הקישור בדפדפן רגיל (Chrome/Edge).', 'warn');
    items.forEach(renderRow); refresh();
  }).catch(() => {});
}
async function saveBlob(blob, filename) {
  if (!IN_ARTIFACT) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return;
  }
  if (!saver) throw new Error('ההורדה לא זמינה בתצוגה הזו');
  try {
    await saver.save({ filename, data: blob });
  } catch (err) {
    if (err && err.code === 'declined') return;
    if (err && err.code === 'rate_limited') { notify('חלון הורדה כבר פתוח – אשר או סגור אותו קודם.', 'warn'); return; }
    throw err;
  }
}

let noticeTimer = null;
function notify(text, kind = 'ok') {
  const el = document.getElementById('notice');
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 7000);
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
function outputName(item) {
  const base = item.file.name.replace(/\.[^.]+$/, '');
  return `${base}_enhanced.${EXT[item.format] || 'jpg'}`;
}
function uniqueNames(done) {
  const used = new Map();
  return done.map((item) => {
    let name = outputName(item);
    const c = used.get(name) || 0;
    used.set(name, c + 1);
    if (c) name = name.replace(/(\.[^.]+)$/, `-${c + 1}$1`);
    return { item, name };
  });
}

async function downloadZip() {
  const done = items.filter((i) => i.status === 'done');
  if (!done.length) return;
  els.zip.disabled = true;
  const label = els.zip.textContent;
  els.zip.textContent = 'מכין ZIP…';
  try {
    const zip = new JSZip();
    for (const { item, name } of uniqueNames(done)) zip.file(name, item.blob, { compression: 'STORE' });
    const blob = await zip.generateAsync({ type: 'blob', streamFiles: true }, (m) => { els.zip.textContent = `מכין ZIP… ${Math.round(m.percent)}%`; });
    await saveBlob(blob, `enhanced-${new Date().toISOString().slice(0, 10)}.zip`);
  } catch (err) {
    notify(`יצירת ה-ZIP נכשלה (${friendlyError(err)}). נסה הורדה בודדת.`, 'error');
  } finally {
    els.zip.textContent = label;
    refresh();
  }
}

async function saveToFolder() {
  const done = items.filter((i) => i.status === 'done');
  let dir;
  try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  let saved = 0;
  for (const { item, name } of uniqueNames(done)) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(item.blob);
    await w.close();
    saved++;
  }
  notify(`נשמרו ${saved} תמונות בתיקייה "${dir.name}".`, 'ok');
}

/* ================= השוואת לפני/אחרי ================= */
function openCompare(item) {
  if (!item.origUrl) item.origUrl = URL.createObjectURL(item.file);
  els.cmpTitle.textContent = `${item.file.name} · ${item.width}×${item.height} ⟵ ${item.outW}×${item.outH}`;
  els.cmpAfter.src = item.url;
  els.cmpBefore.src = item.origUrl;
  els.compare.showModal();
  setSplit(0.5);
}
function setSplit(f) {
  f = Math.min(1, Math.max(0, f));
  // "לפני" בצד ימין (RTL) – חשיפה מימין לשמאל
  els.cmpBeforeWrap.style.clipPath = `inset(0 0 0 ${f * 100}%)`;
  els.cmpLine.style.left = `${f * 100}%`;
}
function splitFromEvent(e) {
  const r = els.cmpStage.getBoundingClientRect();
  setSplit((e.clientX - r.left) / r.width);
}
let dragging = false;
els.cmpStage.addEventListener('pointerdown', (e) => { dragging = true; els.cmpStage.setPointerCapture(e.pointerId); splitFromEvent(e); });
els.cmpStage.addEventListener('pointermove', (e) => { if (dragging) splitFromEvent(e); });
els.cmpStage.addEventListener('pointerup', () => { dragging = false; });
els.cmpClose.addEventListener('click', () => els.compare.close());
els.compare.addEventListener('click', (e) => { if (e.target === els.compare) els.compare.close(); });

/* ================= חיבור הממשק ================= */
els.drop.addEventListener('click', () => els.files.click());
els.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.files.click(); } });
els.files.addEventListener('change', () => { addFiles(els.files.files); els.files.value = ''; });
for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || e.target === document.documentElement) els.drop.classList.remove('over'); });
document.addEventListener('drop', (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

els.start.addEventListener('click', runQueue);
els.stop.addEventListener('click', () => abortCtrl && abortCtrl.abort());
els.zip.addEventListener('click', downloadZip);
els.folder.addEventListener('click', saveToFolder);
els.clear.addEventListener('click', () => { for (const i of [...items]) removeItem(i); });
for (const id of ['scale', 'maxEdge']) $(id).addEventListener('change', () => items.forEach(renderRow));

window.addEventListener('beforeunload', (e) => { if (running || items.some((i) => i.status === 'done')) { e.preventDefault(); e.returnValue = ''; } });

loadSettings();
initEngine().catch((err) => { els.engine.textContent = `שגיאה בטעינת המנוע: ${err.message}`; els.engine.classList.add('warn'); });
refresh();
