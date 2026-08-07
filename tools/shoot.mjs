/**
 * The shot tool. Renders the game headlessly and writes real frames to disk.
 *
 * Every quality claim in this project has to point at one of these files. A
 * critic that reviews a description instead of a frame is reviewing my
 * opinion, which is worth nothing.
 *
 * Two things it refuses to do, both learned the hard way elsewhere:
 *
 *  - It will not capture before the scene has actually presented frames. A
 *    screenshot taken on `load` is a black rectangle, and a black rectangle
 *    reviewed by a critic produces confident nonsense.
 *  - It will not silently accept a software rasteriser. If the GPU is not
 *    driving, the image is not the image players would see, and the whole
 *    exercise is measuring the wrong thing. It says so and exits non-zero.
 *
 * Usage:  node tools/shoot.mjs [--out shots/2026-08-07] [--shots a,b,c]
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    return m ? [[m[1], m[2]]] : [];
  }),
);

const URL_BASE = args.url ?? 'http://127.0.0.1:5273/';
const OUT = args.out ?? 'shots/latest';
const WIDTH = Number(args.width ?? 1920);
const HEIGHT = Number(args.height ?? 1080);

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-frame-rate-limit',
  ],
});

const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });

// Refuse a software rasteriser rather than quietly measuring the wrong thing.
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  return { ok: true, renderer: String(renderer) };
});
if (!gpu.ok || /swiftshader|llvmpipe|software/i.test(gpu.renderer)) {
  console.error(`REFUSING: not a hardware renderer — "${gpu.renderer}". `
    + `Frames captured here would not be the frames a player sees.`);
  await browser.close();
  process.exit(2);
}

// Wait for real presented frames, not for `load`.
try {
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 45_000 });
} catch {
  console.error('REFUSING: the scene never reported a presented frame within 45s.');
  if (consoleErrors.length) console.error('page errors:\n  ' + consoleErrors.join('\n  '));
  await browser.close();
  process.exit(3);
}

// Let temporal effects (SMAA history, AO denoise) settle so the capture is the
// converged image rather than frame one of an accumulating effect.
await page.waitForTimeout(1200);

const perf = await page.evaluate(async () => {
  // Headless Chromium runs requestAnimationFrame unthrottled, so "fps" here is
  // GPU THROUGHPUT, not display frame rate. Reporting 1428 fps because rAF
  // fired in a burst is the kind of number that looks like good news and is
  // not an answer to any question anyone asked.
  //
  // So measure the thing that actually transfers: how long the GPU takes to
  // produce one presented frame, over a window, reported as a distribution.
  const deltas = [];
  await new Promise((resolve) => {
    let n = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      const d = now - last;
      last = now;
      // Discard the first few: shader compilation and texture upload land
      // there and describe startup, not steady state.
      if (n > 20) deltas.push(d);
      if (++n < 200) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  deltas.sort((a, b) => a - b);
  const q = (p) => +deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * p))].toFixed(2);
  const s = window.__SCENE_STATS__ ?? {};
  return {
    // Named for what they are. A budget is stated in milliseconds because a
    // 60fps target means 16.7ms and a 120fps target means 8.3ms.
    frameMsMedian: q(0.5),
    frameMsP95: q(0.95),
    frameMsWorst: q(0.999),
    note: 'headless rAF is unthrottled — these are GPU throughput times, not display fps',
    drawCallsPerFrame: s.drawCallsPerFrame ?? null,
    trianglesPerFrame: s.trianglesPerFrame ?? null,
    programs: s.programs ?? null,
    textures: s.textures ?? null,
    geometries: s.geometries ?? null,
  };
});

const shots = (args.shots ?? 'default').split(',').filter(Boolean);
const written = [];
for (const name of shots) {
  if (name !== 'default') {
    // A named shot may reposition the camera through a hook the level exposes.
    await page.evaluate((n) => window.__SHOT__?.(n), name);
    await page.waitForTimeout(700);
  }
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  written.push(file);
}

const report = {
  at: new Date().toISOString(),
  renderer: gpu.renderer,
  viewport: `${WIDTH}x${HEIGHT}`,
  performance: perf,
  shots: written,
  consoleErrors,
};
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
process.exit(consoleErrors.length ? 1 : 0);
