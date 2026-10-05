import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const here = path.dirname(fileURLToPath(import.meta.url));

export async function openPage(query = '') {
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--font-render-hinting=none'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => console.error('PAGE ERROR', e.message));
  await page.goto('file://' + path.join(here, 'showreel.html') + query);
  const diag = await page.evaluate(() => window.__ready.then(d => ({ ok: d.ok, ratio: d.ratio, wide: d.wide, cond: d.cond })));
  return { browser, page, diag };
}
