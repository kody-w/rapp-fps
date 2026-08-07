import { RecoilModel, type RecoilSnapshot } from '../Recoil.js';
import { DUSKLINE_A7, type RecoilPoint } from '../WeaponConfig.js';

const FIXED_STEP = 1 / 120;
const SHOT_TICKS = Math.round(DUSKLINE_A7.shotInterval / FIXED_STEP);
const SAMPLE_TICKS = 4;
const DEG = 180 / Math.PI;
const TARGET_SHOTS = new Set([1, 5, 15]);

interface DisplaySnapshot {
  cameraPitchDeg: number;
  cameraYawDeg: number;
  targetPitchDeg: number;
  targetYawDeg: number;
  gunBackMm: number;
  gunPitchDeg: number;
}

interface HarnessResult {
  mode: 'normal' | 'constant-pattern-negative';
  status: 'passed' | 'failed' | 'collection-error';
  assertionCount: number;
  failures: string[];
  collectionErrors: string[];
  shots: Record<string, DisplaySnapshot>;
  recovered: DisplaySnapshot | null;
  reset: DisplaySnapshot | null;
  fixedStepCadencesHz: number[];
}

const GOLDEN: Record<string, DisplaySnapshot> = {
  '1': {
    cameraPitchDeg: 0.390831,
    cameraYawDeg: 0,
    targetPitchDeg: 0.5616,
    targetYawDeg: 0,
    gunBackMm: 20.517772,
    gunPitchDeg: 1.667069,
  },
  '5': {
    cameraPitchDeg: 2.262175,
    cameraYawDeg: 0.410505,
    targetPitchDeg: 2.4024,
    targetYawDeg: 0.4602,
    gunBackMm: 30.468454,
    gunPitchDeg: 2.475562,
  },
  '15': {
    cameraPitchDeg: 5.971098,
    cameraYawDeg: -0.587467,
    targetPitchDeg: 6.0762,
    targetYawDeg: -0.6084,
    gunBackMm: 30.586698,
    gunPitchDeg: 2.485169,
  },
};

function display(snapshot: RecoilSnapshot): DisplaySnapshot {
  return {
    cameraPitchDeg: snapshot.cameraPitch * DEG,
    cameraYawDeg: snapshot.cameraYaw * DEG,
    targetPitchDeg: snapshot.targetPitch * DEG,
    targetYawDeg: snapshot.targetYaw * DEG,
    gunBackMm: snapshot.gunBack * 1000,
    gunPitchDeg: snapshot.gunPitch * DEG,
  };
}

function collectDirect(pattern: readonly RecoilPoint[]): {
  shots: Record<string, DisplaySnapshot>;
  recovered: DisplaySnapshot;
  reset: DisplaySnapshot;
} {
  const model = new RecoilModel(DUSKLINE_A7, pattern);
  const shots: Record<string, DisplaySnapshot> = {};

  for (let shot = 1; shot <= 15; shot++) {
    model.fire(1);
    for (let tick = 1; tick <= SHOT_TICKS; tick++) {
      model.step(FIXED_STEP);
      if (tick === SAMPLE_TICKS && TARGET_SHOTS.has(shot)) {
        shots[String(shot)] = display(model.snapshot());
      }
    }
  }

  for (let tick = 0; tick < 360; tick++) model.step(FIXED_STEP);
  const recovered = display(model.snapshot());
  model.reset();
  const reset = display(model.snapshot());
  return { shots, recovered, reset };
}

/**
 * Feed render frames at a chosen cadence through an accumulator, while recoil
 * still receives only 120 Hz fixed steps. Every cadence must collect the exact
 * same shot states; render scheduling is not allowed to alter the pattern.
 */
function collectAtRenderCadence(renderHz: number, pattern: readonly RecoilPoint[]): Record<string, DisplaySnapshot> {
  const model = new RecoilModel(DUSKLINE_A7, pattern);
  const shots: Record<string, DisplaySnapshot> = {};
  let accumulator = 0;
  let fixedTick = 0;
  let shot = 0;
  const totalTicks = 15 * SHOT_TICKS;

  while (fixedTick < totalTicks) {
    accumulator += 1 / renderHz;
    while (accumulator + 1e-12 >= FIXED_STEP && fixedTick < totalTicks) {
      if (fixedTick % SHOT_TICKS === 0) {
        shot++;
        model.fire(1);
      }
      model.step(FIXED_STEP);
      fixedTick++;
      const tickWithinShot = ((fixedTick - 1) % SHOT_TICKS) + 1;
      if (tickWithinShot === SAMPLE_TICKS && TARGET_SHOTS.has(shot)) {
        shots[String(shot)] = display(model.snapshot());
      }
      accumulator -= FIXED_STEP;
    }
  }
  return shots;
}

function run(): HarnessResult {
  const negative = new URLSearchParams(location.search).get('negative') === 'constant';
  const first = DUSKLINE_A7.recoilPattern[0];
  const pattern = negative
    ? DUSKLINE_A7.recoilPattern.map(() => ({ pitch: first.pitch, yaw: 0 }))
    : DUSKLINE_A7.recoilPattern;

  const result: HarnessResult = {
    mode: negative ? 'constant-pattern-negative' : 'normal',
    status: 'passed',
    assertionCount: 0,
    failures: [],
    collectionErrors: [],
    shots: {},
    recovered: null,
    reset: null,
    fixedStepCadencesHz: [30, 60, 144],
  };

  const assert = (condition: boolean, message: string): void => {
    result.assertionCount++;
    if (!condition) result.failures.push(message);
  };
  const close = (actual: number, expected: number, tolerance: number, label: string): void => {
    assert(Math.abs(actual - expected) <= tolerance,
      `${label}: expected ${expected} ± ${tolerance}, received ${actual}`);
  };

  try {
    const direct = collectDirect(pattern);
    result.shots = direct.shots;
    result.recovered = direct.recovered;
    result.reset = direct.reset;

    for (const shot of ['1', '5', '15']) {
      const actual = direct.shots[shot];
      const expected = GOLDEN[shot];
      assert(actual !== undefined, `shot ${shot} was not collected`);
      if (!actual) continue;
      for (const key of Object.keys(expected) as Array<keyof DisplaySnapshot>) {
        close(actual[key], expected[key], 0.0005, `shot ${shot} ${key}`);
      }
    }

    assert(direct.shots['5'].cameraYawDeg > 0.35,
      'shot 5 must be on the authored rightward branch of the recoil pattern');
    assert(direct.shots['15'].cameraYawDeg < -0.5,
      'shot 15 must cross to the authored leftward branch of the recoil pattern');

    for (const [key, value] of Object.entries(direct.reset)) {
      close(value, 0, 1e-9, `reset ${key}`);
    }
    close(direct.recovered.cameraPitchDeg, 0, 0.001, 'recovered cameraPitchDeg');
    close(direct.recovered.cameraYawDeg, 0, 0.001, 'recovered cameraYawDeg');
    close(direct.recovered.gunBackMm, 0, 0.001, 'recovered gunBackMm');
    close(direct.recovered.gunPitchDeg, 0, 0.001, 'recovered gunPitchDeg');

    for (const cadence of result.fixedStepCadencesHz) {
      const cadenceShots = collectAtRenderCadence(cadence, pattern);
      for (const shot of ['1', '5', '15']) {
        const actual = cadenceShots[shot];
        const expected = direct.shots[shot];
        assert(actual !== undefined, `${cadence} Hz did not collect shot ${shot}`);
        if (!actual) continue;
        for (const key of Object.keys(expected) as Array<keyof DisplaySnapshot>) {
          close(actual[key], expected[key], 1e-10, `${cadence} Hz shot ${shot} ${key}`);
        }
      }
    }
  } catch (error) {
    result.collectionErrors.push(error instanceof Error ? error.message : String(error));
  }

  result.status = result.collectionErrors.length > 0
    ? 'collection-error'
    : result.failures.length > 0 ? 'failed' : 'passed';
  return result;
}

const result = run();
(window as unknown as { __RECOIL_RESULT__: HarnessResult }).__RECOIL_RESULT__ = result;
document.querySelector('#result')!.textContent = JSON.stringify(result, null, 2);
