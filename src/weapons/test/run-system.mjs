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

  const cadenceRuns = {};
  for (const renderHz of [30, 60, 144]) {
    cadenceRuns[renderHz] = await page.evaluate((hz) => {
      const step = 1 / 120;
      const weapon = window.__WEAPON__;
      const input = window.__WEAPON_INPUT__;
      input.fire = false;
      input.aim = false;
      input.reload = false;
      weapon.capture('hip');
      weapon.resume();
      window.__WEAPON_EVENTS__.length = 0;
      window.__RESET_WEAPON_PROFILE__();
      input.fire = true;

      let accumulator = 0;
      let fixedTick = 0;
      let renderFrames = 0;
      const shotTicks = [];
      while (window.__WEAPON_PROFILE__.fired < 30 && renderFrames < 2_000) {
        accumulator += 1 / hz;
        while (accumulator + 1e-12 >= step && window.__WEAPON_PROFILE__.fired < 30) {
          const before = window.__WEAPON_PROFILE__.fired;
          weapon.fixedUpdate(step, window.engine.context);
          fixedTick++;
          if (window.__WEAPON_PROFILE__.fired > before) shotTicks.push(fixedTick);
          accumulator -= step;
        }
        renderFrames++;
      }
      input.fire = false;
      return {
        renderHz: hz,
        shotTicks,
        intervals: shotTicks.slice(1).map((tick, index) => tick - shotTicks[index]),
        achievedRpm: shotTicks.length > 1
          ? 60 / ((shotTicks.at(-1) - shotTicks[0]) / (shotTicks.length - 1) * step)
          : 0,
        shakes: window.__WEAPON_PROFILE__.shakes,
        reloadStarts: window.__WEAPON_PROFILE__.reloadStarts,
      };
    }, renderHz);
  }

  const expectedTicks = Array.from({ length: 30 }, (_, index) => 1 + index * 10);
  for (const renderHz of [30, 60, 144]) {
    const run = cadenceRuns[renderHz];
    assert(JSON.stringify(run.shotTicks) === JSON.stringify(expectedTicks),
      `${renderHz} Hz batching must fire on fixed ticks 1,11..291; received ${run.shotTicks.join(',')}`);
    assert(run.intervals.every((ticks) => ticks === 10),
      `${renderHz} Hz batching must preserve 10-tick intervals; received ${run.intervals.join(',')}`);
    assert(Math.abs(run.achievedRpm - 720) < 1e-9,
      `${renderHz} Hz batching must achieve 720 RPM; received ${run.achievedRpm}`);
    assert(run.shakes === 0,
      `${renderHz} Hz live fire must emit zero destructive Shake events; received ${run.shakes}`);
    assert(run.reloadStarts === 0,
      `${renderHz} Hz 30-shot cadence window must not enter reload; received ${run.reloadStarts}`);
  }

  // Exact negative control for the removed clamp/residue algorithm.
  let legacyCooldown = 0;
  const legacyTicks = [];
  for (let tick = 1; tick <= expectedTicks.at(-1); tick++) {
    legacyCooldown = Math.max(0, legacyCooldown - 1 / 120);
    if (legacyCooldown <= 0) {
      legacyTicks.push(tick);
      legacyCooldown += 60 / 720;
    }
  }
  const negativeFailures = [];
  for (let index = 0; index < Math.min(expectedTicks.length, legacyTicks.length); index++) {
    if (legacyTicks[index] !== expectedTicks[index]) {
      negativeFailures.push(
        `shot ${index + 1}: expected tick ${expectedTicks[index]}, legacy fired ${legacyTicks[index]}`,
      );
    }
  }
  if (legacyTicks.length !== expectedTicks.length) {
    negativeFailures.push(`expected 30 shots, legacy produced ${legacyTicks.length}`);
  }
  assert(negativeFailures.length > 0,
    'legacy clamp/residue negative control must fail cadence assertions');

  // Prove why weapons must not emit the current shared Shake event. This calls
  // the unmodified RenderSystem update deterministically at 60 Hz.
  const destructiveShake = await page.evaluate(() => {
    const camera = window.engine.camera;
    const render = window.engine.get('render');
    camera.rotation.set(0, 0, 0);
    const update = { dt: 1 / 60, elapsed: 0, frame: 0, alpha: 0 };
    for (let shot = 0; shot < 30; shot++) {
      window.engine.bus.emit('camera:shake', {
        amplitude: 0.0025,
        duration: 0.07,
        frequency: 34,
      });
      render.update(update, window.engine.context);
    }
    for (let frame = 0; frame < 120; frame++) render.update(update, window.engine.context);
    const degrees = 180 / Math.PI;
    return {
      pitchDeg: camera.rotation.x * degrees,
      yawDeg: camera.rotation.y * degrees,
      rollDeg: camera.rotation.z * degrees,
    };
  });
  assert(Math.abs(destructiveShake.pitchDeg) > 3,
    `legacy Shake probe must prove permanent pitch corruption; received ${destructiveShake.pitchDeg}°`);
  assert(Math.abs(destructiveShake.yawDeg) > 2,
    `legacy Shake probe must prove permanent yaw corruption; received ${destructiveShake.yawDeg}°`);
  assert(Math.abs(destructiveShake.rollDeg) > 1,
    `legacy Shake probe must prove permanent roll corruption; received ${destructiveShake.rollDeg}°`);
  assert(consoleErrors.length === 0,
    `browser console must remain clean; received ${consoleErrors.join(' | ')}`);

  const result = {
    passed: failures.length === 0,
    assertions,
    failures,
    consoleErrors,
    cadenceRuns,
    cadenceNegativeControl: {
      expectedStatus: 'failed',
      actualStatus: negativeFailures.length > 0 ? 'failed' : 'passed',
      assertionFailures: negativeFailures,
      collectionErrors: [],
      legacyTicks,
      legacyIntervals: legacyTicks.slice(1).map((tick, index) => tick - legacyTicks[index]),
      legacyRpm: 60 / (11 / 120),
    },
    destructiveShakeProbe: destructiveShake,
    weaponShakeEventsAcrossRuns: Object.fromEntries(
      Object.entries(cadenceRuns).map(([hz, run]) => [hz, run.shakes]),
    ),
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser.close();
}
