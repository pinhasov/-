// One still per grid (at 0.30 s into each grid) for review.
import { openPage } from './lib.mjs';
import fs from 'fs';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const { browser, page, diag } = await openPage();
console.log('fonts', diag);
for (let g = 0; g < 24; g++) {
  const t = g * 0.5 + (+process.argv[3] || 0.3);
  await page.evaluate(t => window.seek(t), t);
  await page.screenshot({ path: `${out}/g${String(g).padStart(2, '0')}.png` });
}
await browser.close();
