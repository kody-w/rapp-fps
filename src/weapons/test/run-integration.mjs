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
const vector = (value) => [value.x, value.y, value.z];
const subtract = (a, b) => a.map((value, index) => value - b[index]);
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const magnitude = (value) => Math.hypot(...value);
const normalize = (value) => {
  const length = magnitude(value);
  return value.map((component) => component / length);
};
const distanceToRay = (pointValue, originValue, directionValue) => {
  const point = vector(pointValue);
  const origin = vector(originValue);
  const direction = normalize(vector(directionValue));
  const offset = subtract(point, origin);
  const closest = origin.map((component, index) => component + direction[index] * dot(offset, direction));
  return magnitude(subtract(point, closest));
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
    sensitivityScale: window.__WEAPON__.lookSensitivityScale,
  }));
  assert(Math.abs(ads.fov - 52) < 1e-6, `ADS FOV must be 52; received ${ads.fov}`);
  assert(Math.abs(ads.sensitivityScale - 0.62) < 1e-6,
    `ADS sensitivity scale must be 0.62; received ${ads.sensitivityScale}`);

  const captureShot = async (name) => {
    await page.evaluate((shotName) => {
      window.__WEAPON_EVENTS__.length = 0;
      window.__SHOT__(shotName);
    }, name);
    await page.waitForTimeout(50);
    return page.evaluate(() => ({
      capture: window.__WEAPON_CAPTURE__,
      cameraOrigin: window.engine.camera.getWorldPosition(new window.THREE.Vector3()),
      events: window.__WEAPON_EVENTS__.map(({ name: eventName, payload }) => ({
        name: eventName,
        payload,
      })),
    }));
  };

  const captures = {};
  for (const [name, count] of [['shot-1', 1], ['shot-5', 5], ['shot-15', 15]]) {
    const captured = await captureShot(name);
    captures[name] = captured;
    const fired = captured.events.filter((event) => event.name === 'weapon:fired');
    const impacts = captured.events.filter((event) => event.name === 'bullet:impact');
    const damage = captured.events.filter((event) => event.name === 'combat:damage');
    const statuses = captured.events.filter((event) => event.name === 'weapon:status');
    assert(fired.length === count, `${name} must emit ${count} WeaponFired events; received ${fired.length}`);
    assert(impacts.length === count, `${name} must emit ${count} BulletImpact events; received ${impacts.length}`);
    assert(damage.length === 0, `${name} ballistics must emit zero authoritative Damage events; received ${damage.length}`);
    assert(statuses.length >= count,
      `${name} must publish canonical WeaponStatus during fire; received ${statuses.length}`);
    const finalStatus = statuses.at(-1)?.payload;
    assert(finalStatus?.ammo === 30 - count,
      `${name} final WeaponStatus ammo must be ${30 - count}; received ${finalStatus?.ammo}`);
    for (let index = 0; index < impacts.length; index++) {
      const impact = impacts[index];
      const shot = fired[index];
      assert(impact.payload.material === 'concrete', `${name} impact must use SurfaceKind concrete`);
      const normal = impact.payload.normal;
      const length = Math.hypot(normal.x, normal.y, normal.z);
      assert(Math.abs(length - 1) < 1e-5, `${name} impact normal must be unit length; received ${length}`);
      assert(impact.payload.damage > 0, `${name} impact damage must be positive`);
      const miss = distanceToRay(impact.payload.point, shot.payload.origin, shot.payload.direction);
      assert(miss < 1e-5, `${name} event ray must be collinear with impact; miss ${miss}m`);
    }
  }

  const cleanFired = captures['shot-1'].events.find((event) => event.name === 'weapon:fired').payload;
  const cleanImpact = captures['shot-1'].events.find((event) => event.name === 'bullet:impact').payload;
  const legacyCameraDirection = normalize(subtract(
    vector(cleanImpact.point),
    vector(captures['shot-1'].cameraOrigin),
  ));
  const legacyRayMiss = distanceToRay(
    cleanImpact.point,
    cleanFired.origin,
    { x: legacyCameraDirection[0], y: legacyCameraDirection[1], z: legacyCameraDirection[2] },
  );
  const rayNegativeFailures = legacyRayMiss < 1e-5
    ? []
    : [`legacy camera-direction/muzzle-origin ray misses impact by ${legacyRayMiss}m`];
  assert(rayNegativeFailures.length > 0,
    'legacy camera-direction/muzzle-origin negative control must fail collinearity');

  const blockerSetup = await page.evaluate(({ fired, impact }) => {
    const THREE = window.THREE;
    const origin = new THREE.Vector3(fired.origin.x, fired.origin.y, fired.origin.z);
    const direction = new THREE.Vector3(fired.direction.x, fired.direction.y, fired.direction.z).normalize();
    const center = origin.clone().addScaledVector(direction, 0.12);
    const geometry = new THREE.BoxGeometry(0.05, 0.05, 0.05);
    const material = new THREE.MeshStandardMaterial({ color: 0x7d858e, metalness: 1, roughness: 0.3 });
    const blocker = new THREE.Mesh(geometry, material);
    blocker.position.copy(center);
    blocker.userData.surfaceTag = { surface: 'metal' };
    blocker.userData.characterId = 'authority-negative-control';
    blocker.updateMatrixWorld(true);
    window.engine.scene.add(blocker);
    window.__MUZZLE_BLOCKER__ = blocker;

    const camera = window.engine.camera.getWorldPosition(new THREE.Vector3());
    const aimPoint = new THREE.Vector3(impact.point.x, impact.point.y, impact.point.z);
    const cameraDirection = aimPoint.clone().sub(camera).normalize();
    const cameraOffset = center.clone().sub(camera);
    const closest = camera.clone().addScaledVector(cameraDirection, cameraOffset.dot(cameraDirection));
    return {
      center,
      cameraRayClearance: center.distanceTo(closest),
    };
  }, { fired: cleanFired, impact: cleanImpact });
  assert(blockerSetup.cameraRayClearance > 0.05,
    `muzzle blocker must be clear of camera aim ray; clearance ${blockerSetup.cameraRayClearance}m`);

  const blocked = await captureShot('shot-1');
  const blockedFired = blocked.events.filter((event) => event.name === 'weapon:fired');
  const blockedImpacts = blocked.events.filter((event) => event.name === 'bullet:impact');
  const blockedDamage = blocked.events.filter((event) => event.name === 'combat:damage');
  assert(blockedFired.length === 1, `blocked shot must emit one WeaponFired; received ${blockedFired.length}`);
  assert(blockedImpacts.length === 1, `blocked shot must emit one BulletImpact; received ${blockedImpacts.length}`);
  assert(blockedDamage.length === 0,
    `character-tagged blocker must still emit zero authoritative Damage events; received ${blockedDamage.length}`);
  assert(blockedImpacts[0].payload.material === 'metal',
    `near muzzle blocker must resolve SurfaceKind metal; received ${blockedImpacts[0].payload.material}`);
  assert(blockedImpacts[0].payload.distance < 0.2,
    `near muzzle blocker must resolve before distant aim point; distance ${blockedImpacts[0].payload.distance}m`);
  const blockedMiss = distanceToRay(
    blockedImpacts[0].payload.point,
    blockedFired[0].payload.origin,
    blockedFired[0].payload.direction,
  );
  assert(blockedMiss < 1e-5,
    `blocked event ray must be collinear with impact; miss ${blockedMiss}m`);

  await page.evaluate(() => {
    const blocker = window.__MUZZLE_BLOCKER__;
    blocker.removeFromParent();
    blocker.geometry.dispose();
    blocker.material.dispose();
    delete window.__MUZZLE_BLOCKER__;
  });

  // ── Ballistic inclusion: cosmetic FX must be transparent to bullets ──────
  // A CombatFX particle/decal InstancedMesh carries no ballistic tag. It must
  // not intercept a round even when it sits squarely on the muzzle ray in front
  // of the world geometry the player is shooting. This reproduces the reported
  // failure — a decal at 3.627m in front of the 14.698m wall — through the real
  // ballistics path, then tags the same mesh as a control to prove the ignore
  // was the inclusion convention, not a raycast miss.
  const inclusion = await page.evaluate(({ fired, cleanDistance }) => {
    const THREE = window.THREE;
    const origin = new THREE.Vector3(fired.origin.x, fired.origin.y, fired.origin.z);
    const direction = new THREE.Vector3(fired.direction.x, fired.direction.y, fired.direction.z).normalize();
    const nearDistance = Math.min(cleanDistance * 0.5, 3.627);
    const center = origin.clone().addScaledVector(direction, nearDistance);

    // A debris burst shaped exactly like a cosmetic FX emitter: an InstancedMesh
    // of small quads. Deliberately NO ballisticCollider, surfaceTag or noHit.
    const geometry = new THREE.BoxGeometry(0.14, 0.14, 0.02);
    const material = new THREE.MeshBasicMaterial({ color: 0xffaa66 });
    const count = 12;
    const decals = new THREE.InstancedMesh(geometry, material, count);
    const dummy = new THREE.Object3D();
    const facing = window.engine.camera.getWorldQuaternion(new THREE.Quaternion());
    for (let i = 0; i < count; i++) {
      // Instance 0 sits exactly on the muzzle ray; the rest are a fixed splatter.
      const ring = i === 0 ? 0 : 0.12 + (i % 3) * 0.06;
      const angle = i * 0.7;
      dummy.position.copy(center).add(new THREE.Vector3(
        Math.cos(angle) * ring, Math.sin(angle) * ring, ((i % 5) - 2) * 0.03,
      ));
      dummy.quaternion.copy(facing);
      dummy.updateMatrix();
      decals.setMatrixAt(i, dummy.matrix);
    }
    decals.instanceMatrix.needsUpdate = true;
    decals.updateMatrixWorld(true);
    window.engine.scene.add(decals);
    window.__FX_DECALS__ = decals;

    return {
      nearDistance,
      wallDistance: cleanDistance,
      hasBallisticTag: decals.userData.ballisticCollider === true,
      hasSurfaceTag: decals.userData.surfaceTag !== undefined,
      hasNoHit: decals.userData.noHit === true,
    };
  }, { fired: cleanFired, cleanDistance: cleanImpact.distance });

  assert(!inclusion.hasBallisticTag && !inclusion.hasSurfaceTag && !inclusion.hasNoHit,
    'cosmetic decal InstancedMesh must carry no ballistic tag for a valid inclusion test');

  const ignoredShot = await captureShot('shot-1');
  const ignoredImpact = ignoredShot.events.find((event) => event.name === 'bullet:impact')?.payload;
  assert(ignoredImpact !== undefined,
    'a round through untagged cosmetic decals must still resolve on world geometry');
  assert(Math.abs(ignoredImpact.distance - cleanImpact.distance) < 1e-3,
    `untagged decals must be ignored; impact ${ignoredImpact?.distance}m must match the ${cleanImpact.distance}m wall, not the ${inclusion.nearDistance}m decal`);
  assert(ignoredImpact.material === 'concrete',
    `ignored-decal round must resolve the tagged concrete wall; received ${ignoredImpact?.material}`);

  await page.evaluate(() => { window.__FX_DECALS__.userData.ballisticCollider = true; });
  const taggedShot = await captureShot('shot-1');
  const taggedImpact = taggedShot.events.find((event) => event.name === 'bullet:impact')?.payload;
  assert(taggedImpact !== undefined && taggedImpact.distance < cleanImpact.distance - 0.5,
    `tagging the decal ballisticCollider must stop the round early; impact ${taggedImpact?.distance}m must precede the ${cleanImpact.distance}m wall`);
  assert(taggedImpact !== undefined && Math.abs(taggedImpact.distance - inclusion.nearDistance) < 0.2,
    `tagged decal must be struck at ~${inclusion.nearDistance}m; received ${taggedImpact?.distance}m`);

  await page.evaluate(() => {
    const decals = window.__FX_DECALS__;
    decals.removeFromParent();
    decals.geometry.dispose();
    decals.material.dispose();
    delete window.__FX_DECALS__;
  });

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
      damage: value.events.filter((event) => event.name === 'combat:damage').length,
      status: value.events.filter((event) => event.name === 'weapon:status').length,
    }])),
    authoritativeRay: {
      cleanMissMeters: distanceToRay(cleanImpact.point, cleanFired.origin, cleanFired.direction),
      legacyNegativeControl: {
        expectedStatus: 'failed',
        actualStatus: rayNegativeFailures.length > 0 ? 'failed' : 'passed',
        assertionFailures: rayNegativeFailures,
        collectionErrors: [],
        missMeters: legacyRayMiss,
      },
      muzzleObstruction: {
        cameraRayClearanceMeters: blockerSetup.cameraRayClearance,
        impactDistanceMeters: blockedImpacts[0].payload.distance,
        impactMaterial: blockedImpacts[0].payload.material,
        eventRayMissMeters: blockedMiss,
        damageEvents: blockedDamage.length,
      },
    },
    ballisticInclusion: {
      convention: 'opt-in: userData.ballisticCollider===true OR surfaceTag; opt-out noHit/ballisticCollider===false wins',
      decalDistanceMeters: inclusion.nearDistance,
      wallDistanceMeters: inclusion.wallDistance,
      untaggedDecalImpactMeters: ignoredImpact?.distance,
      untaggedDecalImpactMaterial: ignoredImpact?.material,
      taggedDecalImpactMeters: taggedImpact?.distance,
      decalIgnoredWhenUntagged: Math.abs((ignoredImpact?.distance ?? 0) - cleanImpact.distance) < 1e-3,
      decalStopsRoundWhenTagged: (taggedImpact?.distance ?? Infinity) < cleanImpact.distance - 0.5,
    },
    sampleImpact: cleanImpact,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await browser.close();
}
