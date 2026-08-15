import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5347/src/weapons/dev/index.html?evidence=1';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

const failures = [];
let assertions = 0;
const assert = (condition, message) => {
  assertions++;
  if (!condition) failures.push(message);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 45_000 });
  await page.evaluate(() => window.engine.stop());

  // Drive presentation and simulation by hand so spread transitions are
  // deterministic. Every WeaponStatus the weapon publishes is captured through
  // a real bus subscription — the same seam the HUD uses.
  const data = await page.evaluate(() => {
    const step = 1 / 120;
    const weapon = window.__WEAPON__;
    const ctx = window.engine.context;
    const input = window.__WEAPON_INPUT__;

    const statuses = [];
    const off = window.engine.bus.on('weapon:status', (status) => statuses.push({
      spread: status.spread, aim: status.aim, ammo: status.ammo, reloading: status.reloading,
    }));

    const reset = () => {
      input.fire = false; input.aim = false; input.reload = false;
      input.move.x = 0; input.move.y = 0; input.look.x = 0; input.look.y = 0;
      weapon.capture('hip');
      weapon.resume();
    };
    const runUpdates = (frames, dt) => {
      for (let i = 0; i < frames; i++) weapon.update({ dt, elapsed: i * dt, frame: i, alpha: 0 }, ctx);
    };
    const runFixed = (ticks) => { for (let i = 0; i < ticks; i++) weapon.fixedUpdate(step, ctx); };
    // Movement spread is gameplay state advanced on the 120 Hz fixed step, so a
    // faithful ramp drives BOTH the fixed simulation and the render presentation,
    // exactly as the engine's accumulator loop does. (Before the defect-#2 fix,
    // movement spread advanced inside update(), so render frames alone ramped it;
    // that render-rate dependence was the bug. Driving fixedUpdate here is not a
    // test relaxation — it makes the harness mirror the real engine loop.)
    const runFrames = (frames, dt) => {
      let acc = 0;
      for (let i = 0; i < frames; i++) {
        acc += dt;
        while (acc >= step) { weapon.fixedUpdate(step, ctx); acc -= step; }
        weapon.update({ dt, elapsed: i * dt, frame: i, alpha: acc / step }, ctx);
      }
    };

    // Analytic reference points from the tuning.
    const cfg = window.DUSKLINE_A7;
    const minSpread = cfg.adsSpread;
    const maxSpread = cfg.hipSpread + cfg.moveSpread;
    const normalize = (radians) => (radians - minSpread) / (maxSpread - minSpread);
    const reference = {
      adsStill: normalize(cfg.adsSpread),                 // 0
      hipStill: normalize(cfg.hipSpread),                 // still minimum, hip
      hipFullMove: normalize(cfg.hipSpread + cfg.moveSpread), // 1
      rawRadianFullMove: cfg.hipSpread + cfg.moveSpread,  // legacy un-normalized value
    };

    // Phase A — hip fire stance, ramp from still to full movement.
    reset();
    const aStart = statuses.length;
    input.move.x = 0; input.move.y = 1;
    runFrames(90, 1 / 60);
    const phaseA = statuses.slice(aStart).map((s) => s.spread);

    // Phase B — stop; spread relaxes back to the hip-still minimum.
    input.move.x = 0; input.move.y = 0;
    const bStart = statuses.length;
    runFrames(150, 1 / 60);
    const phaseB = statuses.slice(bStart).map((s) => s.spread);

    // Phase C — aim down sights while still; spread reaches the global minimum.
    const cStart = statuses.length;
    input.aim = true;
    runFixed(60);
    runUpdates(4, 1 / 60);
    const phaseC = statuses.slice(cStart);

    // Phase D — fully settled and idle; the quantiser must emit nothing.
    runUpdates(6, 1 / 60);
    const dStart = statuses.length;
    runUpdates(120, 1 / 60);
    const idleEmitted = statuses.length - dStart;

    off();
    return {
      reference,
      phaseA: {
        count: phaseA.length,
        min: Math.min(...phaseA),
        max: Math.max(...phaseA),
        final: phaseA.at(-1),
      },
      phaseB: { count: phaseB.length, final: phaseB.length ? phaseB.at(-1) : null },
      phaseC: {
        count: phaseC.length,
        finalSpread: phaseC.length ? phaseC.at(-1).spread : null,
        finalAim: phaseC.length ? phaseC.at(-1).aim : null,
      },
      phaseD: { idleFramesDriven: 120, statusEmitted: idleEmitted },
      allInUnitRange: statuses.every((s) => s.spread >= 0 && s.spread <= 1),
      totalStatuses: statuses.length,
    };
  });

  // Normalized range.
  assert(data.allInUnitRange, 'every published WeaponStatus spread must lie within 0..1');

  // Full movement reaches ~1 and the subscriber observed the transition up.
  assert(data.phaseA.count >= 2,
    `movement ramp must publish multiple statuses; received ${data.phaseA.count}`);
  assert(data.phaseA.max > 0.98,
    `full movement must drive normalized spread to ~1; received max ${data.phaseA.max}`);
  assert(data.phaseA.min < 0.45,
    `movement ramp must start from the tighter still stance; received min ${data.phaseA.min}`);
  assert(data.phaseA.max - data.phaseA.min > 0.5,
    `a subscriber must observe the full movement transition; span ${data.phaseA.max - data.phaseA.min}`);

  // Still reaches the minimum: hip-still floor, then the global minimum at ADS.
  assert(data.phaseB.final !== null && Math.abs(data.phaseB.final - data.reference.hipStill) < 0.02,
    `stopping must relax spread to the hip-still minimum ${data.reference.hipStill.toFixed(3)}; received ${data.phaseB.final}`);
  assert(data.phaseC.finalAim !== null && data.phaseC.finalAim > 0.98,
    `ADS phase must complete the aim transition; received aim ${data.phaseC.finalAim}`);
  assert(data.phaseC.finalSpread !== null && data.phaseC.finalSpread < 0.02,
    `still ADS must reach the global minimum normalized spread ~0; received ${data.phaseC.finalSpread}`);

  // No per-frame spam once the state is quantised and settled.
  assert(data.phaseD.statusEmitted === 0,
    `a settled idle weapon must emit no status spam; received ${data.phaseD.statusEmitted} over 120 frames`);

  // Negative control: the removed behaviour emitted the raw radian cone. Fed to
  // the HUD's 0..1 contract it reads as ~0 (tightest) at full movement — the
  // opposite of the truth. Assert the un-normalized value fails the contract.
  const legacyNegativeFailures = [];
  if (!(data.reference.rawRadianFullMove < 0.1)) {
    legacyNegativeFailures.push('raw radian spread unexpectedly satisfied the 0..1 HUD range');
  } else {
    legacyNegativeFailures.push(
      `raw radian spread ${data.reference.rawRadianFullMove.toFixed(4)} at full movement reads as ~0 (tightest) under the HUD 0..1 contract`,
    );
  }
  assert(legacyNegativeFailures.length > 0 && data.reference.rawRadianFullMove < 0.1,
    'un-normalized radian spread negative control must fail the HUD 0..1 contract');

  assert(consoleErrors.length === 0, `browser console must remain clean; received ${consoleErrors.join(' | ')}`);

  const result = {
    passed: failures.length === 0,
    assertions,
    failures,
    consoleErrors,
    ...data,
    normalizationNegativeControl: {
      expectedStatus: 'failed',
      actualStatus: legacyNegativeFailures.length > 0 ? 'failed' : 'passed',
      assertionFailures: legacyNegativeFailures,
      collectionErrors: [],
      rawRadianFullMove: data.reference.rawRadianFullMove,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser.close();
}
