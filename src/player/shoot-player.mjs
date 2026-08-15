import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((argument) => {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    return match ? [[match[1], match[2]]] : [];
  }),
);
const url = args.url ?? 'http://127.0.0.1:5311/';
const out = args.out ?? 'shots/player-1';
const names = (args.shots ?? 'mid-air,crouched,landing,top-of-step')
  .split(',')
  .filter(Boolean);
mkdirSync(out, { recursive: true });

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
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForFunction(() => window.__FRAME_READY__ === true, null, {
  timeout: 45_000,
});

const gpu = await page.evaluate(() => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2' };
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  return { ok: true, renderer: String(renderer) };
});
if (!gpu.ok || /swiftshader|llvmpipe|software/i.test(gpu.renderer)) {
  console.error(`REFUSING: not a hardware renderer — "${gpu.renderer}".`);
  await browser.close();
  process.exit(2);
}

const playerTiming = await page.evaluate(async () => {
  const { createPlayer } = await import('/src/player/index.ts');
  const engine = window.engine;
  const canvas = document.querySelector('#game');
  const bundle = createPlayer(canvas);
  engine.input = bundle.input;
  engine.add(bundle.system);
  const initStart = performance.now();
  await bundle.system.init(engine.context);
  const initMs = performance.now() - initStart;
  window.__PLAYER_BUNDLE__ = bundle;

  engine.stop();
  const motor = bundle.system.getMotor();
  const spawn = motor.position.clone();
  const iterations = 6_000;
  const benchmarkStart = performance.now();
  for (let tick = 0; tick < iterations; tick++) {
    if (tick > 0 && tick % 600 === 0) motor.teleport(spawn);
    bundle.system.fixedUpdate(1 / 120, engine.context);
  }
  const fixedTickMicroseconds = (performance.now() - benchmarkStart) * 1000 / iterations;
  motor.teleport(spawn);
  engine.start();
  return {
    collisionBvhBuildMs: Number(initMs.toFixed(3)),
    fixedTickMicroseconds: Number(fixedTickMicroseconds.toFixed(3)),
    estimatedPlayerCostAt60FpsMs: Number((fixedTickMicroseconds * 2 / 1000).toFixed(4)),
  };
});
await page.waitForTimeout(500);

const performanceReport = await page.evaluate(async () => {
  const deltas = [];
  await new Promise((resolve) => {
    let frame = 0;
    let last = performance.now();
    const tick = () => {
      const now = performance.now();
      if (frame > 20) deltas.push(now - last);
      last = now;
      if (++frame < 200) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  deltas.sort((a, b) => a - b);
  const quantile = (amount) => Number(
    deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * amount))]
      .toFixed(2),
  );
  return {
    frameMsMedian: quantile(0.5),
    frameMsP95: quantile(0.95),
    frameMsWorst: quantile(0.999),
  };
});

const shots = [];
for (const name of names) {
  await page.evaluate((shotName) => window.__SHOT__?.(shotName), name);
  await page.waitForTimeout(700);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, type: 'png' });
  const state = await page.evaluate(() => window.__PLAYER_STATE__);
  shots.push({ name, file, state });
}

const report = {
  at: new Date().toISOString(),
  renderer: gpu.renderer,
  playerTiming,
  performance: performanceReport,
  shots,
  consoleErrors,
};
writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(consoleErrors.length === 0 ? 0 : 1);
