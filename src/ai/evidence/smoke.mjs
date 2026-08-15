import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=metal', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-zero-copy'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + String(e)));

await page.goto('http://127.0.0.1:5284/src/ai/harness.html', { waitUntil: 'domcontentloaded', timeout: 60000 });

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2', timer: false };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
  const timer = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
  return { ok: true, renderer: String(renderer), timer };
});
console.log('GPU:', JSON.stringify(gpu));

let ready = false;
try {
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 30000 });
  ready = true;
} catch { ready = false; }
console.log('FRAME_READY:', ready);

const info = await page.evaluate(() => ({
  gpuSupported: window.engine?.profiler?.gpuSupported ?? null,
  aiName: window.ai?.name ?? null,
  stats: window.__SCENE_STATS__ ?? null,
  bench: typeof window.__AI_BENCH__ === 'function' ? window.__AI_BENCH__(20000) : null,
}));
console.log('INFO:', JSON.stringify(info, null, 2));

// Exercise each shot hook and report the resulting state.
for (const name of ['patrol', 'notice', 'telegraph', 'fire', 'cover', 'search', 'death']) {
  const r = await page.evaluate((n) => {
    window.__SHOT__(n);
    const a = window.ai.agent;
    const round = (v) => ({ x: +v.x.toFixed(2), y: +v.y.toFixed(2), z: +v.z.toFixed(2) });
    return {
      n, state: a.state, phase: a.combatPhase, tick: a.tick, health: Math.round(a.health),
      pos: round(a.position), fwd: round(a.forward),
      canSee: a.canSeeNow, lastKnown: round(a.lastKnown),
      camPos: round(window.engine.camera.position),
    };
  }, name);
  console.log('SHOT', JSON.stringify(r));
}

console.log('ERRORS:', errors.length);
for (const e of errors.slice(0, 20)) console.log('  -', e);
await browser.close();
process.exit(errors.length ? 1 : 0);
