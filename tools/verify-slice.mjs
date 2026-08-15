#!/usr/bin/env node
/**
 * verify-slice.mjs — acceptance instrument for the vertical slice (issue #32).
 *
 * WRITTEN BEFORE THE SUBSYSTEMS IT JUDGES. That is deliberate. An acceptance
 * test authored after the implementation tends to describe whatever the
 * implementation happens to do; this one is written against the event contract
 * in src/core/contracts.ts and knows nothing about how any subsystem works.
 *
 * It answers one question: can a person move, look, shoot, and fight in this
 * build, at frame budget, without errors?
 *
 * THE CENTRAL RULE: a check that could not be observed is NOT a pass. Most test
 * harnesses conflate "nothing went wrong" with "the thing worked" — that is how
 * a build with no enemy in it reports green. Every check here resolves to
 * exactly one of pass / fail / unobserved, and only all-pass is a slice.
 *
 * The corollary cost this instrument its own first run: a DERIVED check must
 * not pass when its precondition never happened. On the gameplay-free build,
 * "the player stopped when input was released" and "the player stayed inside
 * the world" both reported green — while the player had not moved a millimetre.
 * A stationary object trivially satisfies both. Any check whose evidence
 * requires motion is therefore gated on motion having occurred.
 *
 * Exit codes are shared with tools/shoot.mjs so a caller can treat refusals
 * uniformly:
 *   0 slice verified   1 console errors   2 software rasteriser
 *   3 no presented frame   4 no GPU timer   5 too few queries   6 disjoint
 *   7 over frame budget   9 bad arguments  11 one or more checks failed
 *   12 one or more checks unobserved
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const m = /^--([^=]+)=(.*)$/.exec(raw);
  if (!m) {
    console.error(`REFUSING: unparseable argument "${raw}". Expected --key=value.`);
    process.exit(9);
  }
  args.set(m[1], m[2]);
}

const URL_BASE = args.get('url');
if (!URL_BASE) {
  console.error(
    'REFUSING: --url is required and has no default. A default port here once validated the '
      + 'wrong branch for an entire review round.',
  );
  process.exit(9);
}
const OUT = args.get('out') ?? 'shots/slice';
const WIDTH = Number(args.get('width') ?? 1920);
const HEIGHT = Number(args.get('height') ?? 1080);
const BUDGET_MS = Number(args.get('budget') ?? 16.7);
if (!Number.isFinite(BUDGET_MS) || BUDGET_MS <= 0) {
  console.error(`REFUSING: --budget must be a positive number, got "${args.get('budget')}".`);
  process.exit(9);
}

/** Event names are the contract. Duplicated here on purpose: if a subsystem
 *  renames one, this instrument must go red rather than silently follow it. */
const EV = {
  WeaponFired: 'weapon:fired',
  BulletImpact: 'bullet:impact',
  Damage: 'combat:damage',
  HitConfirmed: 'combat:hit-confirm',
  Elimination: 'combat:elimination',
  Footstep: 'player:footstep',
  Landed: 'player:landed',
  PlayerStatus: 'player:status',
  WeaponStatus: 'weapon:status',
};

const checks = [];
const record = (name, status, detail, evidence) => {
  checks.push({ name, status, detail, ...(evidence ? { evidence } : {}) });
};

mkdirSync(OUT, { recursive: true });
// Delete any previous verdict first: a stale report that survives a crash is
// worse than no report, because it reads as a fresh pass.
rmSync(join(OUT, 'slice.json'), { force: true });

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
  ],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

const die = async (code, msg, extra) => {
  console.error(`REFUSING: ${msg}`);
  if (extra) console.error(extra);
  writeFileSync(
    join(OUT, 'slice.json'),
    JSON.stringify({ verdict: 'REFUSED', exitCode: code, reason: msg, checks, consoleErrors }, null, 2),
  );
  await browser.close();
  process.exit(code);
};

await page.goto(URL_BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 });

const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return { ok: false, renderer: 'no webgl2' };
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return { ok: true, renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown') };
});
if (!gpu.ok || /swiftshader|llvmpipe|software/i.test(gpu.renderer)) {
  await die(2, `not a hardware renderer — "${gpu.renderer}". This would not be the frame a player sees.`);
}

try {
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 45_000 });
} catch {
  await die(3, 'the scene never reported a presented frame within 45s.',
    consoleErrors.length ? 'page errors:\n  ' + consoleErrors.join('\n  ') : undefined);
}
await page.waitForTimeout(1200);

if (!(await page.evaluate(() => window.engine?.profiler?.gpuSupported ?? false))) {
  await die(4, 'EXT_disjoint_timer_query_webgl2 unavailable. GPU cost is UNVERIFIED and rAF '
    + 'cadence will not be substituted for it.');
}

/* ---------------------------------------------------------------------------
 * Tap the event bus. Wrapping emit (rather than subscribing to a known list)
 * records events this instrument was never told about, which is how you find
 * out a subsystem invented a second spelling of an existing event.
 * ------------------------------------------------------------------------- */
const tapped = await page.evaluate(() => {
  const bus = window.engine?.bus;
  if (!bus || typeof bus.emit !== 'function') return false;
  window.__SLICE_EVENTS__ = [];
  const original = bus.emit.bind(bus);
  bus.emit = (event, payload) => {
    try {
      let summary = null;
      if (payload && typeof payload === 'object') {
        summary = {};
        for (const [k, v] of Object.entries(payload)) {
          if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') summary[k] = v;
          else if (v && typeof v.x === 'number') summary[k] = { x: v.x, y: v.y, z: v.z };
        }
      }
      window.__SLICE_EVENTS__.push({ event, t: performance.now(), payload: summary });
    } catch { /* recording must never break the frame */ }
    return original(event, payload);
  };
  return true;
});
if (!tapped) {
  await die(3, 'window.engine.bus is not reachable, so no gameplay event can be observed. '
    + 'Every behavioural check below would report a false green.');
}

const cameraState = () => page.evaluate(() => {
  const c = window.engine?.camera;
  if (!c) return null;
  return {
    pos: { x: c.position.x, y: c.position.y, z: c.position.z },
    quat: { x: c.quaternion.x, y: c.quaternion.y, z: c.quaternion.z, w: c.quaternion.w },
    yaw: c.rotation.y, pitch: c.rotation.x,
  };
});
const events = () => page.evaluate(() => window.__SLICE_EVENTS__ ?? []);
const countOf = (list, name) => list.filter((e) => e.event === name).length;
const dist2D = (a, b) => Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);

// A click both arms audio and requests pointer lock in the production root.
await page.mouse.click(WIDTH / 2, HEIGHT / 2);
await page.waitForTimeout(400);
const pointerLocked = await page.evaluate(() => document.pointerLockElement !== null);

/* --- check: look ----------------------------------------------------------
 * Pointer lock CANNOT be granted under Playwright on this machine: headless
 * silently declines, headed raises pointerlockerror. Verified with a minimal
 * page whose only job was to call requestPointerLock from a click handler.
 *
 * So this check drives the raw mouse deltas that a locked pointer would deliver
 * and asserts the camera responds. What that covers: sensitivity, axis mapping,
 * accumulation, clamping, and everything downstream. What it does NOT cover:
 * the browser's pointer-lock grant itself, and any code gated on
 * document.pointerLockElement. That gap is recorded in the report rather than
 * papered over, and it is why a player system must gate look on "lock was
 * requested" rather than on "lock is held".
 * ------------------------------------------------------------------------- */
const sendLookDelta = (dx, dy) => page.evaluate(([mx, my]) => {
  const target = document.querySelector('canvas') ?? document.body;
  target.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, cancelable: true, movementX: mx, movementY: my,
  }));
  document.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true, cancelable: true, movementX: mx, movementY: my,
  }));
}, [dx, dy]);

let lookInputPath = 'synthetic-movement-delta (pointer lock unavailable under automation)';
{
  const before = await cameraState();
  if (!before) {
    record('look', 'unobserved', 'window.engine.camera is not reachable.');
  } else {
    for (let i = 0; i < 30; i++) {
      await sendLookDelta(12, 0);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(250);
    const after = await cameraState();
    const dYaw = Math.abs(after.yaw - before.yaw);
    const lookMoved = dYaw > 0.02;
    if (lookMoved) {
      record('look', 'pass',
        `yaw changed by ${dYaw.toFixed(4)} rad under 30 mouse-delta events.`,
        { beforeYaw: before.yaw, afterYaw: after.yaw, pointerLocked, inputPath: lookInputPath });
    } else {
      record('look', 'fail',
        `yaw moved only ${dYaw.toFixed(5)} rad across 30 mouse-delta events. Either look input is `
          + 'not wired, or it is gated on document.pointerLockElement — which automation can never '
          + 'satisfy, and which would make mouse look permanently unverifiable.',
        { deltaYaw: dYaw, pointerLocked, inputPath: lookInputPath });
    }
    const pitchLimit = Math.PI / 2 + 1e-3;
    if (!lookMoved) {
      record('look_pitch_clamped', 'unobserved',
        'the camera never turned, so the pitch clamp was never exercised.');
    } else {
      // Drive hard past vertical in both directions; a missing clamp shows up
      // as the world inverting, which is unmistakable and unshippable.
      for (let i = 0; i < 60; i++) { await sendLookDelta(0, -40); await page.waitForTimeout(8); }
      await page.waitForTimeout(150);
      const up = await cameraState();
      for (let i = 0; i < 120; i++) { await sendLookDelta(0, 40); await page.waitForTimeout(8); }
      await page.waitForTimeout(150);
      const down = await cameraState();
      const ok = Math.abs(up.pitch) <= pitchLimit && Math.abs(down.pitch) <= pitchLimit;
      record('look_pitch_clamped', ok ? 'pass' : 'fail',
        ok ? `pitch held within ±${pitchLimit.toFixed(4)} rad when driven hard past vertical `
             + `(up ${up.pitch.toFixed(4)}, down ${down.pitch.toFixed(4)}).`
           : `pitch escaped the clamp (up ${up.pitch.toFixed(4)}, down ${down.pitch.toFixed(4)}, `
             + `limit ±${pitchLimit.toFixed(4)}); the view can be rolled past vertical.`);
    }
  }
}

/* --- check: movement ------------------------------------------------------ */
let playerMoved = false;
{
  const before = await cameraState();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1500);
  const mid = await cameraState();
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(600);
  const after = await cameraState();

  if (!before || !mid) {
    record('move', 'unobserved', 'camera unreachable during movement.');
  } else {
    const travelled = dist2D(before, mid);
    playerMoved = travelled >= 1.0;
    if (playerMoved) {
      record('move', 'pass', `travelled ${travelled.toFixed(3)} m in 1.5 s of forward input.`,
        { from: before.pos, to: mid.pos });
    } else {
      record('move', 'fail',
        `travelled only ${travelled.toFixed(3)} m in 1.5 s; expected at least 1.0 m. Either the `
          + 'player system is absent, input is not reaching it, or the player is stuck on spawn geometry.',
        { from: before.pos, to: mid.pos });
    }
    // Gated: something that never moved trivially "stops".
    if (!playerMoved) {
      record('move_stops', 'unobserved',
        'the player never moved, so deceleration on release was never exercised.');
    } else {
      const coast = dist2D(mid, after);
      record('move_stops', coast < 1.0 ? 'pass' : 'fail',
        `coasted ${coast.toFixed(3)} m after release (expected under 1.0 m; more than that is ice).`);
    }
  }

  const evs = await events();
  const steps = countOf(evs, EV.Footstep);
  record('footsteps', steps > 0 ? 'pass' : 'unobserved',
    steps > 0 ? `${steps} footstep events during movement.`
      : 'no player:footstep emitted while moving; audio and AI hearing have nothing to react to.');
}

/* --- check: the player cannot leave the world ----------------------------- */
{
  const before = await cameraState();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  const after = await cameraState();
  const fell = after && after.pos.y < -50;
  const far = before && after ? dist2D(before, after) : 0;
  if (!after) {
    record('containment', 'unobserved', 'camera unreachable.');
  } else if (!playerMoved) {
    // Gated: a player that cannot move cannot escape, which says nothing about
    // whether the arena has walls.
    record('containment', 'unobserved',
      'the player never moved, so containment was never tested. A stationary player stays inside '
        + 'any world, including one with no walls at all.');
  } else if (fell) {
    record('containment', 'fail',
      `player fell to y=${after.pos.y.toFixed(2)} — it walked off the world.`, { pos: after.pos });
  } else if (far > 400) {
    record('containment', 'fail',
      `player travelled ${far.toFixed(1)} m unobstructed; the arena has no boundary.`, { pos: after.pos });
  } else {
    record('containment', 'pass',
      `player remained in the world (y=${after.pos.y.toFixed(2)}, ${far.toFixed(1)} m from start) `
        + 'after 6 s of continuous forward input.', { pos: after.pos });
  }
}

/* --- check: weapon -------------------------------------------------------- */
{
  const before = (await events()).length;
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const evs = (await events()).slice(before);

  const fired = countOf(evs, EV.WeaponFired);
  record('weapon_fires', fired > 0 ? 'pass' : 'unobserved',
    fired > 0 ? `${fired} weapon:fired events in 1.2 s of held fire.`
      : 'no weapon:fired observed; there is no weapon in this build, or fire input never reaches it.');

  const impacts = evs.filter((e) => e.event === EV.BulletImpact);
  if (impacts.length === 0) {
    record('bullet_resolves', fired > 0 ? 'fail' : 'unobserved',
      fired > 0
        ? `${fired} shots fired but no bullet:impact resolved; rounds are not hitting the world.`
        : 'no shots were fired, so impact resolution could not be observed.');
  } else {
    const bad = impacts.filter((e) => {
      const n = e.payload?.normal;
      if (!n) return true;
      const len = Math.hypot(n.x, n.y, n.z);
      return !Number.isFinite(len) || Math.abs(len - 1) > 0.01;
    });
    record('bullet_resolves', bad.length === 0 ? 'pass' : 'fail',
      bad.length === 0
        ? `${impacts.length} impacts, every normal unit-length.`
        : `${bad.length} of ${impacts.length} impacts carry a non-unit or missing normal; decals `
          + 'and impact FX will be misoriented.',
      { sample: impacts[0]?.payload ?? null });
  }
}

/* --- check: there is something to fight ----------------------------------- */
{
  const evs = await events();
  const dmg = evs.filter((e) => e.event === EV.Damage || e.event === EV.HitConfirmed);
  const kills = countOf(evs, EV.Elimination);
  if (dmg.length > 0) {
    record('enemy_damageable', 'pass',
      `${dmg.length} damage/hit-confirm events observed${kills ? `, ${kills} elimination(s)` : ''}.`);
  } else {
    record('enemy_damageable', 'unobserved',
      'no combat:damage or combat:hit-confirm was observed at any point. Nothing in this build '
        + 'can be fought. This is NOT a pass — an empty arena produces exactly this result.');
  }
}

/* --- check: frame budget while actually playing --------------------------- */
{
  await page.evaluate(() => window.engine.profiler.reset());
  await page.keyboard.down('KeyW');
  await page.mouse.down();
  const spin = (async () => {
    for (let i = 0; i < 90; i++) {
      await page.mouse.move(WIDTH / 2 + Math.sin(i / 6) * 300, HEIGHT / 2 + Math.cos(i / 9) * 90);
      await page.waitForTimeout(16);
    }
  })();
  try {
    await page.waitForFunction(
      () => window.engine.profiler.snapshot().budgetFrameMs.samples >= 120, null, { timeout: 60_000 },
    );
  } catch {
    await page.keyboard.up('KeyW').catch(() => {});
    await die(5, 'fewer than 120 completed GPU timer queries in 60s under play load.');
  }
  await spin;
  await page.keyboard.up('KeyW');
  await page.mouse.up();

  const t = await page.evaluate(() => window.engine.profiler.snapshot());
  if (t.gpuDisjointCount > 0) await die(6, `${t.gpuDisjointCount} disjoint GPU timing event(s) under play load.`);

  const p95 = t.budgetFrameMs.p95;
  record('frame_budget', p95 <= BUDGET_MS ? 'pass' : 'fail',
    `${p95.toFixed(3)} ms p95 against a ${BUDGET_MS} ms budget, measured while moving, `
      + `turning and firing (${t.budgetFrameMs.samples} paired samples).`,
    { p95, median: t.budgetFrameMs.median, samples: t.budgetFrameMs.samples });
  var measuredP95 = p95;
}

await page.screenshot({ path: join(OUT, 'slice.png') });

record('no_console_errors', consoleErrors.length === 0 ? 'pass' : 'fail',
  consoleErrors.length === 0 ? 'no console errors across the whole play sequence.'
    : `${consoleErrors.length} console error(s).`, consoleErrors.slice(0, 10));

const failed = checks.filter((c) => c.status === 'fail');
const unobserved = checks.filter((c) => c.status === 'unobserved');
const verdict = failed.length ? 'FAILED' : unobserved.length ? 'INCOMPLETE' : 'SLICE VERIFIED';

const report = {
  verdict,
  at: new Date().toISOString(),
  url: URL_BASE,
  renderer: gpu.renderer,
  viewport: `${WIDTH}x${HEIGHT}`,
  budgetMs: BUDGET_MS,
  frameMsP95: typeof measuredP95 === 'number' ? measuredP95 : null,
  pointerLocked,
  lookInputPath,
  coverageGaps: [
    'Pointer lock is never granted under Playwright (verified: headless declines silently, headed '
      + 'raises pointerlockerror). Look is exercised by dispatching the mouse deltas a locked '
      + 'pointer would produce, so the lock grant itself is UNVERIFIED by this instrument.',
  ],
  passed: checks.filter((c) => c.status === 'pass').length,
  failed: failed.length,
  unobserved: unobserved.length,
  checks,
  consoleErrors,
};
writeFileSync(join(OUT, 'slice.json'), JSON.stringify(report, null, 2));

for (const c of checks) {
  const mark = c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'UNOBSERVED';
  console.log(`${mark.padEnd(11)} ${c.name}: ${c.detail}`);
}
console.log(`\n${verdict} — ${report.passed} passed, ${failed.length} failed, ${unobserved.length} unobserved.`);
if (unobserved.length && !failed.length) {
  console.log('An unobserved check is not a pass. The build did not demonstrate that behaviour at all.');
}

await browser.close();
process.exit(
  consoleErrors.length ? 1
    : failed.length ? 11
      : unobserved.length ? 12
        : 0,
);
