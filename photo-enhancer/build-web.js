'use strict';
// בונה את גרסת הרשת לתיקייה ‎.web-build/ – לפרסום כקישור (Artifact):
//  • web.html – דף אחד עם העיצוב מוטמע
//  • משקלי המודלים כ-‎.b64.txt (אחסון הקישור לא מגיש קבצי ‎.bin)
// הפעלה: node build-web.js
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const OUT = path.join(ROOT, '.web-build');
fs.rmSync(OUT, { recursive: true, force: true });

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const title = html.match(/<title>[\s\S]*?<\/title>/)[0];
const body = html.match(/<body>([\s\S]*)<\/body>/)[1];
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'web.html'), `${title}\n<style>\n${css}</style>\n<div dir="rtl" lang="he">${body}</div>\n`);

const copy = (rel, data) => {
  const dst = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, data ?? fs.readFileSync(path.join(ROOT, rel)));
};
copy('app.js');
for (const f of fs.readdirSync(path.join(ROOT, 'vendor'))) copy(`vendor/${f}`);
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
for (const rel of walk('models')) {
  if (rel.endsWith('.bin')) copy(rel.replace(/\.bin$/, '.b64.txt'), fs.readFileSync(path.join(ROOT, rel)).toString('base64'));
  else copy(rel);
}
console.log(`נבנה ב-${OUT}`);
