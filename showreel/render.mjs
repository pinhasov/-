// Full render: screenshots piped straight into ffmpeg (no images on disk).
// 4 sub-frames per output frame across half the frame duration → tmix=4 → keep every 4th → 60 fps.
import { openPage } from './lib.mjs';
import { spawn } from 'child_process';
const OUT = process.argv[2] || 'showreel.mp4';
const FPS = 60, N = 12 * FPS, SUB = 4, SPAN = 0.5 / FPS;
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error',
  '-f', 'image2pipe', '-framerate', String(FPS * SUB), '-c:v', 'png', '-i', '-',
  '-vf', `tmix=frames=${SUB},select='eq(mod(n\\,${SUB})\\,${SUB - 1})',setpts=N/(${FPS}*TB)`,
  '-r', String(FPS), '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
const { browser, page, diag } = await openPage();
console.log('fonts', diag);
const write = buf => new Promise(r => ff.stdin.write(buf) ? r() : ff.stdin.once('drain', r));
for (let i = 0; i < N; i++) {
  for (let k = 0; k < SUB; k++) {
    // Sub-samples sit around the frame time but never cross a grid cut, so cuts stay hard.
    const g = Math.floor(i / FPS / 0.5 + 1e-9);
    const t = Math.min(Math.max(i / FPS + ((k + 0.5) / SUB - 0.5) * SPAN, g * 0.5), (g + 1) * 0.5 - 1e-4);
    await page.evaluate(t => window.seek(t), t);
    await write(await page.screenshot({ type: 'png' }));
  }
  if (i % 120 === 0) console.log('frame', i);
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
console.log('done', OUT);
