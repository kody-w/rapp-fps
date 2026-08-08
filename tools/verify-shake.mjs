/**
 * Non-destructive camera-shake verification. — #25
 *
 * Captures the camera quaternion inside the real composer render, proves it
 * differs while a shake frame is submitted, and proves the authoritative
 * quaternion is restored immediately afterward. A second page forces the
 * composer to throw and proves the finally path still restores it.
 */

import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const TARGET = process.env.FPS_URL ?? 'http://127.0.0.1:5273/';
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});

const epsilon = 1e-10;
const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

async function open() {
  const page = await browser.newPage();
  await page.goto(TARGET, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__FRAME_READY__ === true);
  return page;
}

try {
  const page = await open();
  const realFrames = await page.evaluate(async () => {
    const engine = window.engine;
    const render = engine.get('render');
    const camera = engine.camera;
    camera.rotation.set(-0.17, 0.31, 0.04);
    camera.updateMatrixWorld(true);
    const authoritative = camera.quaternion.toArray();
    const during = [];
    const original = render.composer.render.bind(render.composer);
    render.composer.render = (...args) => {
      during.push(camera.quaternion.toArray());
      return original(...args);
    };

    for (let i = 0; i < 30; i++) {
      engine.bus.emit('camera:shake', {
        amplitude: 0.006,
        duration: 0.09,
        frequency: 24,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    for (let i = 0; i < 180; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    render.composer.render = original;
    return {
      authoritative,
      during,
      after: camera.quaternion.toArray(),
    };
  });
  assert(
    realFrames.during.some((sample) => distance(sample, realFrames.authoritative) > 1e-6),
    'shake was never applied inside composer render',
  );
  assert(
    distance(realFrames.after, realFrames.authoritative) <= epsilon,
    `camera drifted by ${distance(realFrames.after, realFrames.authoritative)}`,
  );
  await page.close();

  const throwPage = await open();
  const throwResult = await throwPage.evaluate(() => {
    const engine = window.engine;
    const render = engine.get('render');
    engine.stop();
    const camera = engine.camera;
    camera.rotation.set(0.12, -0.23, 0.07);
    camera.updateMatrixWorld(true);
    const before = camera.quaternion.toArray();
    engine.bus.emit('camera:shake', { amplitude: 0.02, duration: 1, frequency: 18 });
    render.update(
      { dt: 1 / 60, elapsed: performance.now() / 1000, frame: 1, alpha: 0 },
      engine.context,
    );
    const original = render.composer.render;
    let threw = false;
    render.composer.render = () => { throw new Error('forced composer failure'); };
    try {
      render.render();
    } catch {
      threw = true;
    }
    render.composer.render = original;
    return { before, after: camera.quaternion.toArray(), threw };
  });
  assert.equal(throwResult.threw, true, 'forced composer failure did not throw');
  assert(
    distance(throwResult.after, throwResult.before) <= epsilon,
    'composer throw left shake in authoritative camera',
  );
  await throwPage.close();

  // Negative control: the previous additive algorithm necessarily drifts.
  let oldRotation = [0, 0, 0];
  let amplitude = 0;
  let t = 0;
  for (let shot = 0; shot < 30; shot++) {
    amplitude = Math.max(amplitude, 0.006);
    t = 0;
    for (let frame = 0; frame < 4; frame++) {
      t += 1 / 60;
      oldRotation[2] += Math.sin(t * 24) * amplitude * 0.6;
      oldRotation[0] += Math.sin(t * 24 * 1.7) * amplitude;
      oldRotation[1] += Math.cos(t * 24 * 1.3) * amplitude * 0.8;
      amplitude = Math.max(0, amplitude - (1 / 0.09) * (1 / 60) * amplitude * 4);
    }
  }
  assert(
    Math.hypot(...oldRotation) > 0.01,
    'negative control did not reproduce additive camera drift',
  );

  console.log(JSON.stringify({
    passed: true,
    renderSamples: realFrames.during.length,
    maxDuringOffset: Math.max(
      ...realFrames.during.map((sample) => distance(sample, realFrames.authoritative)),
    ),
    finalDrift: distance(realFrames.after, realFrames.authoritative),
    throwDrift: distance(throwResult.after, throwResult.before),
    oldAdditiveDriftRadians: Math.hypot(...oldRotation),
  }, null, 2));
} finally {
  await browser.close();
}
