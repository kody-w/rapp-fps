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

  // ── End-to-end trigger-edge behaviour through WeaponSystem.fixedUpdate ──
  // The outstanding deadline must survive trigger release. Tapping an auto
  // trigger, holding it, and mashing a semi trigger must all obey shotInterval;
  // a held semi trigger must fire exactly once. Everything below drives the
  // real fixedUpdate on real WeaponSystem instances, not a re-implementation.
  const triggerModes = await page.evaluate(() => {
    const step = 1 / 120;
    const ctx = window.engine.context;
    const input = window.__WEAPON_INPUT__;
    const rpmOf = (ticks) => (ticks.length > 1
      ? 60 / (((ticks.at(-1) - ticks[0]) / (ticks.length - 1)) * step)
      : 0);

    const drive = (weapon, firePattern, cap) => {
      input.fire = false; input.aim = false; input.reload = false;
      weapon.capture('hip');
      weapon.resume();
      const ticks = [];
      for (let tick = 1; tick <= 320 && ticks.length < cap; tick++) {
        input.fire = firePattern(tick);
        const before = weapon.totalShotsFired;
        weapon.fixedUpdate(step, ctx);
        if (weapon.totalShotsFired > before) ticks.push(tick);
      }
      input.fire = false;
      return ticks;
    };

    // Auto weapon (the harness instance) — tapping press/release every 2 ticks.
    const autoTapTicks = drive(window.__WEAPON__, (tick) => tick % 2 === 1, 30);

    // A branch-local semi-auto instance shares the live scene/camera/bus.
    const semi = new window.WeaponSystem({ ...window.DUSKLINE_A7, fireMode: 'semi' });
    semi.init(ctx);
    const semiHoldTicks = drive(semi, () => true, 30);
    const semiTapTicks = drive(semi, (tick) => tick % 2 === 1, 5);
    input.fire = false;
    semi.dispose();

    return {
      autoTap: { ticks: autoTapTicks, intervals: autoTapTicks.slice(1).map((t, i) => t - autoTapTicks[i]), rpm: rpmOf(autoTapTicks) },
      semiHold: { ticks: semiHoldTicks },
      semiTap: { ticks: semiTapTicks, intervals: semiTapTicks.slice(1).map((t, i) => t - semiTapTicks[i]), rpm: rpmOf(semiTapTicks) },
    };
  });

  assert(JSON.stringify(triggerModes.autoTap.ticks) === JSON.stringify(expectedTicks),
    `auto tap must obey 10-tick interval (1,11..291); received ${triggerModes.autoTap.ticks.join(',')}`);
  assert(triggerModes.autoTap.intervals.every((ticks) => ticks === 10),
    `auto tap must not out-run interval; received intervals ${triggerModes.autoTap.intervals.join(',')}`);
  assert(Math.abs(triggerModes.autoTap.rpm - 720) < 1e-9,
    `auto tap must hold 720 RPM, not 3600; received ${triggerModes.autoTap.rpm}`);
  assert(JSON.stringify(triggerModes.semiHold.ticks) === JSON.stringify([1]),
    `held semi trigger must fire exactly once at tick 1; received ${triggerModes.semiHold.ticks.join(',')}`);
  assert(JSON.stringify(triggerModes.semiTap.ticks) === JSON.stringify([1, 11, 21, 31, 41]),
    `semi taps must obey shotInterval (1,11,21,31,41); received ${triggerModes.semiTap.ticks.join(',')}`);
  assert(triggerModes.semiTap.intervals.every((ticks) => ticks === 10),
    `semi taps must not out-run interval; received intervals ${triggerModes.semiTap.intervals.join(',')}`);
  assert(Math.abs(triggerModes.semiTap.rpm - 720) < 1e-9,
    `semi taps must hold 720 RPM; received ${triggerModes.semiTap.rpm}`);

  // Negative control: the removed reset-on-edge / reset-on-release scheduler.
  // Fed the same auto-tap pattern it fires every 2 ticks (3600 RPM), proving
  // the old code let a cycled trigger out-run the configured cadence.
  const interval = 60 / 720;
  let resetSimTime = 0;
  let resetNext = 0;
  let resetPrevFire = false;
  const resetTicks = [];
  for (let tick = 1; tick <= expectedTicks.at(-1) && resetTicks.length < 30; tick++) {
    resetSimTime += 1 / 120;
    const fire = tick % 2 === 1;
    const fireEdge = fire && !resetPrevFire;
    const wantsFire = fire; // auto
    resetPrevFire = fire;
    if (!wantsFire) resetNext = resetSimTime;
    if (fireEdge) resetNext = resetSimTime;
    if (wantsFire && resetSimTime + 1e-9 >= resetNext) {
      resetTicks.push(tick);
      resetNext += interval;
    }
  }
  const resetIntervals = resetTicks.slice(1).map((tick, index) => tick - resetTicks[index]);
  const resetRpm = resetIntervals.length > 0 ? 60 / ((resetIntervals[0] / 120)) : 0;
  const triggerResetNegativeFailures = [];
  if (JSON.stringify(resetTicks) === JSON.stringify(expectedTicks)) {
    triggerResetNegativeFailures.push('reset-on-edge scheduler unexpectedly matched exact 720 cadence');
  } else {
    triggerResetNegativeFailures.push(
      `reset-on-edge scheduler fired ${resetTicks.length} rounds at intervals ${resetIntervals.slice(0, 4).join(',')}.. (${resetRpm} RPM), not 720`,
    );
  }
  assert(triggerResetNegativeFailures.length > 0 && resetRpm > 720,
    `trigger-reset negative control must fail exact cadence; measured ${resetRpm} RPM`);

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
    triggerModes,
    triggerResetNegativeControl: {
      expectedStatus: 'failed',
      actualStatus: triggerResetNegativeFailures.length > 0 ? 'failed' : 'passed',
      assertionFailures: triggerResetNegativeFailures,
      collectionErrors: [],
      resetTicks,
      resetIntervals,
      resetRpm,
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
