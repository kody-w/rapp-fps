import type { ProfilerSnapshot } from '../../core/profiler.js';
import { Engine } from '../../core/engine.js';
import { TestLevel } from '../../level/TestLevel.js';
import { RenderSystem } from '../RenderSystem.js';
import {
  EVIDENCE_HEIGHT,
  EVIDENCE_WIDTH,
  SEQUENCES,
  TemporalCameraSystem,
  TemporalEvidenceCapture,
  type SequenceName,
  type TemporalCaptureResult,
} from './TemporalEvidence.js';

interface TemporalHarnessApi {
  status: 'ready' | 'running' | 'complete' | 'failed';
  mode: 'capture' | 'performance';
  capture(includeControls: boolean): Promise<TemporalCaptureResult>;
  profiler(): ProfilerSnapshot;
  error?: string;
}

declare global {
  interface Window {
    __TEMPORAL_EVIDENCE__: TemporalHarnessApi;
    engine: Engine;
  }
}

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Temporal harness canvas is missing.');
}

const query = new URLSearchParams(location.search);
const runMode = query.get('run') === 'perf' ? 'performance' : 'capture';
const sequenceValue = query.get('sequence') ?? 'fast-yaw';
if (!SEQUENCES.includes(sequenceValue as SequenceName)) {
  throw new Error(`Unsupported temporal sequence: ${sequenceValue}`);
}

const engine = new Engine(canvas);
engine.renderer.setPixelRatio(1);
engine.renderer.setSize(EVIDENCE_WIDTH, EVIDENCE_HEIGHT, false);
engine.camera.aspect = EVIDENCE_WIDTH / EVIDENCE_HEIGHT;
engine.camera.updateProjectionMatrix();
engine.input = {
  move: { x: 0, y: 0 },
  look: { x: 0, y: 0 },
  jump: false,
  crouch: false,
  sprint: false,
  fire: false,
  aim: false,
  reload: false,
  pressed: () => false,
};

const renderSystem = new RenderSystem();
engine.add(renderSystem);
engine.add(new TestLevel());
if (runMode === 'performance') {
  engine.add(new TemporalCameraSystem(sequenceValue as SequenceName));
}

const api: TemporalHarnessApi = {
  status: 'running',
  mode: runMode,
  async capture(includeControls) {
    if (runMode !== 'capture') {
      throw new Error('Capture is unavailable while the performance loop is running.');
    }
    api.status = 'running';
    try {
      const result = await new TemporalEvidenceCapture(
        engine,
        renderSystem,
      ).capture(includeControls);
      api.status = 'complete';
      return result;
    } catch (error) {
      api.status = 'failed';
      api.error = error instanceof Error ? error.stack ?? error.message : String(error);
      throw error;
    }
  },
  profiler: () => engine.profiler.snapshot(),
};
window.__TEMPORAL_EVIDENCE__ = api;
window.engine = engine;

await engine.init();
engine.renderer.info.autoReset = false;
engine.present = () => {
  engine.renderer.info.reset();
  renderSystem.render();
};

if (runMode === 'performance') {
  engine.start();
}
api.status = 'ready';

addEventListener('pagehide', () => engine.dispose(), { once: true });
