// Pixel check: every frame at 60 fps rendered in check mode (each word in its own pure channel).
import { openPage } from './lib.mjs';
import fs from 'fs';
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true });
const { browser, page } = await openPage('?check=1');
const meta = [];
for (let i = 0; i < 720; i++) {
  const t = i / 60;
  await page.evaluate(t => window.seek(t), t);
  // The sliding word may start outside the frame (allowed); flag those frames.
  const slideOff = t >= 2.5 && t < 3.0;
  await page.screenshot({ path: `${out}/f${String(i).padStart(4, '0')}.png` });
  meta.push({ i, t, slideIn: slideOff });
}
fs.writeFileSync(out + '/meta.json', JSON.stringify(meta));
await browser.close();
