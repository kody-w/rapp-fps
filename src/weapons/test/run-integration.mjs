import { chromium } from 'playwright';

const urlArg = process.argv.find((arg) => arg.startsWith('--url='));
const url = urlArg?.slice('--url='.length)
  ?? 'http://127.0.0.1:5347/src/weapons/dev/index.html?evidence=1';
const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

const assertions = [];
const failures = [];
const assert = (condition, message) => {
  assertions.push(message);
  if (!condition) failures.push(message);
};

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__FRAME_READY__ === true, null, { timeout: 45_000 });

  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  assert(!/swiftshader|llvmpipe|software/i.test(renderer), `hardware renderer required; received ${renderer}`);

  await page.evaluate(() => window.__SHOT__('ads'));
  await page.waitForTimeout(50);
  const ads = await page.evaluate(() => ({
    fov: window.engine.camera.fov,
    sensitivityScale: window.engine.get('weapon').lookSensitivityScale,
  }));
  assert(Math.abs(ads.fov - 52) < 1e-6, `ADS FOV must be 52; received ${ads.fov}`);
  assert(Math.abs(ads.sensitivityScale - 0.62) < 1e-6,
    `ADS sensitivity scale must be 0.62; received ${ads.sensitivityScale}`);

  const captures = {};
  for (const [name, count] of [['shot-1', 1], ['shot-5', 5], ['shot-15', 15]]) {
    await page.evaluate((shotName) => {
      window.__WEAPON_EVENTS__.length = 0;
      window.__SHOT__(shotName);
    }, name);
    await page.waitForTimeout(50);
    captures[name] = await page.evaluate(() => ({
      capture: window.__WEAPON_CAPTURE__,
      events: window.__WEAPON_EVENTS__.map(({ name: eventName, payload }) => ({
        name: eventName,
        payload,
      })),
    }));
    const fired = captures[name].events.filter((event) => event.name === 'weapon:fired');
    const impacts = captures[name].events.filter((event) => event.name === 'bullet:impact');
    assert(fired.length === count, `${name} must emit ${count} WeaponFired events; received ${fired.length}`);
    assert(impacts.length === count, `${name} must emit ${count} BulletImpact events; received ${impacts.length}`);
    for (const impact of impacts) {
      assert(impact.payload.material === 'concrete', `${name} impact must use SurfaceKind concrete`);
      const normal = impact.payload.normal;
      const length = Math.hypot(normal.x, normal.y, normal.z);
      assert(Math.abs(length - 1) < 1e-5, `${name} impact normal must be unit length; received ${length}`);
      assert(impact.payload.damage > 0, `${name} impact damage must be positive`);
    }
  }

  const toDegrees = (value) => value * 180 / Math.PI;
  const recoil = Object.fromEntries(Object.entries(captures).map(([name, value]) => [name, {
    cameraPitchDeg: toDegrees(value.capture.recoil.cameraPitch),
    cameraYawDeg: toDegrees(value.capture.recoil.cameraYaw),
    gunBackMm: value.capture.recoil.gunBack * 1000,
    gunPitchDeg: toDegrees(value.capture.recoil.gunPitch),
  }]));
  assert(recoil['shot-1'].cameraPitchDeg < recoil['shot-5'].cameraPitchDeg,
    'camera recoil must accumulate from shot 1 to shot 5');
  assert(recoil['shot-5'].cameraPitchDeg < recoil['shot-15'].cameraPitchDeg,
    'camera recoil must accumulate from shot 5 to shot 15');
  assert(recoil['shot-5'].cameraYawDeg > 0 && recoil['shot-15'].cameraYawDeg < 0,
    'authored recoil must cross from right at shot 5 to left at shot 15');

  assert(consoleErrors.length === 0, `browser console must remain clean; received ${consoleErrors.join(' | ')}`);

  const result = {
    passed: failures.length === 0,
    renderer,
    assertions: assertions.length,
    failures,
    consoleErrors,
    ads,
    recoil,
    eventCounts: Object.fromEntries(Object.entries(captures).map(([name, value]) => [name, {
      fired: value.events.filter((event) => event.name === 'weapon:fired').length,
      impacts: value.events.filter((event) => event.name === 'bullet:impact').length,
    }])),
    sampleImpact: captures['shot-1'].events.find((event) => event.name === 'bullet:impact')?.payload ?? null,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser.close();
}
