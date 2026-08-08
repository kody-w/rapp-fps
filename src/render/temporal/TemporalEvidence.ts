import * as THREE from 'three';
import type { System, UpdateContext } from '../../core/contracts.js';
import type { Engine } from '../../core/engine.js';
import type { RenderSystem } from '../RenderSystem.js';

export const EVIDENCE_FRAMES = 120;

export const SEQUENCES = [
  'static',
  'slow-yaw',
  'fast-yaw',
  'lateral',
  'hard-stop',
  'reveal',
] as const;

export type SequenceName = typeof SEQUENCES[number];

interface Pose {
  x: number;
  y: number;
  z: number;
  pitch?: number;
  yaw?: number;
  target?: THREE.Vector3;
  jitterX?: number;
  jitterY?: number;
}

interface PatchLayout {
  id: string;
  kind: 'bar' | 'specular';
  width: number;
  height: number;
}

interface PatchMap extends PatchLayout {
  coordinates: Float32Array;
}

interface ReadRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

interface Distribution {
  samples: number;
  median: number;
  p95: number;
  worst: number;
}

interface TemporalAnalysis {
  coverageNoise: Distribution;
  compensatedFrameDifference: Distribution;
  edgeEnergy: Distribution;
  edgeSampleFraction: number;
}

interface AnalysisGroups {
  all: TemporalAnalysis;
  bars: TemporalAnalysis;
  specular: TemporalAnalysis;
}

interface GhostAnalysis {
  holdFrame: number;
  changedSampleFraction: number;
  trail: Distribution;
  firstFrame: number;
  fourthFrame: number;
  twelfthFrame: number;
}

interface SequenceEvidence {
  analysis: AnalysisGroups;
  wrongCompensation: AnalysisGroups;
  ghostTrail?: GhostAnalysis;
}

interface NegativeControlEvidence {
  staticFalsePositive: {
    threshold: number;
    actual: number;
    passes: boolean;
  };
  subpixelJitter: {
    requiredRatio: number;
    actualRatio: number;
    staticP95: number;
    jitterP95: number;
    passes: boolean;
  };
  deliberateBlur: {
    requiredFlickerReduction: number;
    requiredSharpnessLoss: number;
    flickerReduction: number;
    sharpnessLoss: number;
    unblurredFlickerP95: number;
    blurredFlickerP95: number;
    unblurredEdgeEnergy: number;
    blurredEdgeEnergy: number;
    passes: boolean;
  };
  historyWithoutRejection: {
    requiredMinimumTrail: number;
    rawHardStopTrailP95: number;
    historyHardStopTrailP95: number;
    rawRevealTrailP95: number;
    historyRevealTrailP95: number;
    passes: boolean;
  };
  wrongMotionCompensation: {
    requiredRatio: number;
    correctP95: number;
    wrongP95: number;
    actualRatio: number;
    passes: boolean;
  };
  allPass: boolean;
}

export interface TemporalCaptureResult {
  methodology: {
    frameCount: number;
    viewport: string;
    primaryMetric: string;
    motionCompensation: string;
    roiDescription: string;
    ghostMetric: string;
    sharpnessMetric: string;
  };
  sequences: Record<SequenceName, SequenceEvidence>;
  summary: {
    staticCoverageNoiseP95: number;
    staticEdgeEnergy: number;
    worstMotionCoverageNoiseP95: number;
    worstMotionSequence: SequenceName;
    hardStopGhostTrailP95: number;
    revealGhostTrailP95: number;
    motionNoiseToJitterRatio: number | null;
  };
  controls?: NegativeControlEvidence;
  images: {
    contactSheet: string;
    roiSheet: string;
    negativeControls?: string;
    ghostStrips?: string;
  };
}

interface CaptureSheets {
  contact: HTMLCanvasElement;
  contactContext: CanvasRenderingContext2D;
  roi: HTMLCanvasElement;
  roiContext: CanvasRenderingContext2D;
  controls?: HTMLCanvasElement;
  controlsContext?: CanvasRenderingContext2D;
  ghosts?: HTMLCanvasElement;
  ghostsContext?: CanvasRenderingContext2D;
  blur?: HTMLCanvasElement;
  blurContext?: CanvasRenderingContext2D;
}

interface EvidenceDimensions {
  width: number;
  height: number;
}

interface SequenceCapture {
  frames: Float32Array[][];
  wrongFrames: Float32Array[][];
  historyFrames?: Float32Array[][];
  analysis: AnalysisGroups;
  wrongAnalysis: AnalysisGroups;
  ghost?: GhostAnalysis;
  historyGhost?: GhostAnalysis;
  blurredAnalysis?: AnalysisGroups;
}

const BASE_POSITION = new THREE.Vector3(0.6, 1.65, 3.4);
const REVEAL_TARGET = new THREE.Vector3(0, 1.2, -13);
const CONTACT_FRAMES = [0, 40, 80, 119];
const HARD_STOP_FRAMES = [59, 60, 64, 72];
const REVEAL_FRAMES = [79, 80, 84, 96];
const CONTACT_TILE = { width: 256, height: 144 };
const ROI_TILE = { width: 256, height: 96 };
const EDGE_THRESHOLD = 0.018;
const STATIC_FALSE_POSITIVE_MAX = 0.5;
const BAR_COUNT = 9;
const SPECULAR_CENTERS = [
  new THREE.Vector3(-4.5, 0.45, -3.6),
  new THREE.Vector3(-3.0, 0.45, -3.6),
  new THREE.Vector3(-1.5, 0.45, -3.6),
];

const PATCH_LAYOUTS: PatchLayout[] = [
  ...Array.from({ length: BAR_COUNT }, (_, index) => ({
    id: `bar-${index}`,
    kind: 'bar' as const,
    width: 20,
    height: 48,
  })),
  ...SPECULAR_CENTERS.map((_, index) => ({
    id: `specular-${index}`,
    kind: 'specular' as const,
    width: 28,
    height: 28,
  })),
];

const JITTER_PATTERN = [
  [-0.375, -0.125],
  [0.125, 0.375],
  [0.375, -0.375],
  [-0.125, 0.125],
  [-0.25, 0.25],
  [0.25, -0.25],
  [0.0, 0.5],
  [0.5, 0.0],
] as const;

function interpolate(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sequencePose(name: SequenceName | 'static-jitter', frame: number): Pose {
  const t = frame / (EVIDENCE_FRAMES - 1);
  switch (name) {
    case 'static':
      return { x: BASE_POSITION.x, y: BASE_POSITION.y, z: BASE_POSITION.z, pitch: -0.06, yaw: 0 };
    case 'slow-yaw':
      return {
        x: BASE_POSITION.x,
        y: BASE_POSITION.y,
        z: BASE_POSITION.z,
        pitch: -0.06,
        yaw: interpolate(-0.012, 0.012, t),
      };
    case 'fast-yaw':
      return {
        x: BASE_POSITION.x,
        y: BASE_POSITION.y,
        z: BASE_POSITION.z,
        pitch: -0.06,
        yaw: interpolate(-0.105, 0.105, t),
      };
    case 'lateral':
      return {
        x: BASE_POSITION.x + interpolate(-0.5, 0.5, t),
        y: BASE_POSITION.y,
        z: BASE_POSITION.z,
        pitch: -0.06,
        yaw: 0,
      };
    case 'hard-stop': {
      const movingT = Math.min(frame, 59) / 59;
      return {
        x: BASE_POSITION.x,
        y: BASE_POSITION.y,
        z: BASE_POSITION.z,
        pitch: -0.06,
        yaw: interpolate(-0.08, 0.04, movingT),
      };
    }
    case 'reveal': {
      const movingT = Math.min(frame, 79) / 79;
      return {
        x: interpolate(-2.8, 3.2, movingT),
        y: BASE_POSITION.y,
        z: BASE_POSITION.z,
        target: REVEAL_TARGET,
      };
    }
    case 'static-jitter': {
      const jitter = JITTER_PATTERN[frame % JITTER_PATTERN.length];
      return {
        x: BASE_POSITION.x,
        y: BASE_POSITION.y,
        z: BASE_POSITION.z,
        pitch: -0.06,
        yaw: 0,
        jitterX: jitter[0],
        jitterY: jitter[1],
      };
    }
  }
}

export function applyEvidencePose(
  camera: THREE.PerspectiveCamera,
  name: SequenceName | 'static-jitter',
  frame: number,
  dimensions: EvidenceDimensions,
): void {
  const pose = sequencePose(name, frame);
  camera.position.set(pose.x, pose.y, pose.z);
  if (pose.target) {
    camera.lookAt(pose.target);
  } else {
    camera.rotation.set(pose.pitch ?? 0, pose.yaw ?? 0, 0, 'YXZ');
  }
  camera.clearViewOffset();
  camera.aspect = dimensions.width / dimensions.height;
  camera.updateProjectionMatrix();
  if (pose.jitterX !== undefined || pose.jitterY !== undefined) {
    camera.projectionMatrix.elements[8] +=
      (2 * (pose.jitterX ?? 0)) / dimensions.width;
    camera.projectionMatrix.elements[9] +=
      (2 * (pose.jitterY ?? 0)) / dimensions.height;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  camera.updateMatrixWorld(true);
}

export class TemporalCameraSystem implements System {
  readonly name = 'temporal-camera';
  private frame = 0;

  constructor(private readonly sequence: SequenceName) {}

  update(_update: UpdateContext, ctx: Parameters<NonNullable<System['update']>>[1]): void {
    applyEvidencePose(
      ctx.camera,
      this.sequence,
      this.frame++ % EVIDENCE_FRAMES,
      {
        width: ctx.renderer.domElement.width,
        height: ctx.renderer.domElement.height,
      },
    );
  }
}

export class TemporalEvidenceCapture {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly dimensions: EvidenceDimensions;

  constructor(
    private readonly engine: Engine,
    private readonly renderSystem: RenderSystem,
  ) {
    this.canvas = engine.renderer.domElement;
    this.gl = engine.renderer.getContext() as WebGL2RenderingContext;
    this.dimensions = {
      width: this.canvas.width,
      height: this.canvas.height,
    };
    if (this.dimensions.width <= 0 || this.dimensions.height <= 0) {
      throw new Error('Temporal evidence requires a non-empty drawing buffer.');
    }
  }

  async capture(includeControls: boolean): Promise<TemporalCaptureResult> {
    const sheets = createSheets(
      includeControls,
      this.dimensions.width,
      this.dimensions.height,
    );
    const sequenceResults = {} as Record<SequenceName, SequenceEvidence>;
    const captures = new Map<SequenceName, SequenceCapture>();

    for (let row = 0; row < SEQUENCES.length; row++) {
      const name = SEQUENCES[row];
      const captured = await this.captureSequence(name, row, sheets, includeControls);
      captures.set(name, captured);
      sequenceResults[name] = {
        analysis: captured.analysis,
        wrongCompensation: captured.wrongAnalysis,
        ...(captured.ghost ? { ghostTrail: captured.ghost } : {}),
      };
    }

    let controls: NegativeControlEvidence | undefined;
    if (includeControls) {
      const jitter = await this.captureJitterControl(sheets);
      const staticCapture = requiredCapture(captures, 'static');
      const slowCapture = requiredCapture(captures, 'slow-yaw');
      const fastCapture = requiredCapture(captures, 'fast-yaw');
      const hardStopCapture = requiredCapture(captures, 'hard-stop');
      const revealCapture = requiredCapture(captures, 'reveal');
      controls = evaluateControls(
        staticCapture,
        slowCapture,
        fastCapture,
        hardStopCapture,
        revealCapture,
        jitter,
      );
    }

    const motionNames: SequenceName[] = ['slow-yaw', 'fast-yaw', 'lateral'];
    const worstMotionSequence = motionNames.reduce((worst, name) => {
      const current = sequenceResults[name].analysis.all.coverageNoise.p95;
      const previous = sequenceResults[worst].analysis.all.coverageNoise.p95;
      return current > previous ? name : worst;
    });
    const jitterP95 = controls?.subpixelJitter.jitterP95 ?? null;
    const worstMotionP95 =
      sequenceResults[worstMotionSequence].analysis.all.coverageNoise.p95;

    return {
      methodology: {
        frameCount: EVIDENCE_FRAMES,
        viewport: `${this.dimensions.width}x${this.dimensions.height}`,
        primaryMetric:
          'p95 absolute temporal second difference at edge pixels, scaled by 1000',
        motionCompensation:
          'world-anchored bar and specular ROIs are reprojected into canonical patches each frame',
        roiDescription:
          'nine thin metallic bars plus three smooth-metal sphere highlight/silhouette patches',
        ghostMetric:
          'changed-pixel residual against the settled final pose after hard stop/reveal',
        sharpnessMetric:
          'median canonical-patch spatial gradient magnitude, scaled by 1000',
      },
      sequences: sequenceResults,
      summary: {
        staticCoverageNoiseP95:
          sequenceResults.static.analysis.all.coverageNoise.p95,
        staticEdgeEnergy: sequenceResults.static.analysis.all.edgeEnergy.median,
        worstMotionCoverageNoiseP95: worstMotionP95,
        worstMotionSequence,
        hardStopGhostTrailP95:
          sequenceResults['hard-stop'].ghostTrail?.trail.p95 ?? 0,
        revealGhostTrailP95:
          sequenceResults.reveal.ghostTrail?.trail.p95 ?? 0,
        motionNoiseToJitterRatio:
          jitterP95 !== null && jitterP95 > 0
            ? rounded(worstMotionP95 / jitterP95)
            : null,
      },
      ...(controls ? { controls } : {}),
      images: {
        contactSheet: sheets.contact.toDataURL('image/png'),
        roiSheet: sheets.roi.toDataURL('image/png'),
        ...(sheets.controls
          ? { negativeControls: sheets.controls.toDataURL('image/png') }
          : {}),
        ...(sheets.ghosts
          ? { ghostStrips: sheets.ghosts.toDataURL('image/png') }
          : {}),
      },
    };
  }

  private async captureSequence(
    name: SequenceName,
    row: number,
    sheets: CaptureSheets,
    includeControls: boolean,
  ): Promise<SequenceCapture> {
    resetTemporalHistory(this.renderSystem);
    applyEvidencePose(this.engine.camera, name, 0, this.dimensions);
    await this.warmUp(name);
    const fixedMaps = createPatchMaps(this.engine.camera, this.dimensions);
    const frames: Float32Array[][] = [];
    const wrongFrames: Float32Array[][] = [];
    const historyCanvas = name === 'hard-stop' || name === 'reveal'
      ? document.createElement('canvas')
      : undefined;
    const historyContext = historyCanvas?.getContext('2d', { alpha: false });
    if (historyCanvas) {
      historyCanvas.width = this.dimensions.width;
      historyCanvas.height = this.dimensions.height;
    }
    const selectedGhostFrames = name === 'hard-stop'
      ? HARD_STOP_FRAMES
      : name === 'reveal'
        ? REVEAL_FRAMES
        : [];

    for (let frame = 0; frame < EVIDENCE_FRAMES; frame++) {
      applyEvidencePose(this.engine.camera, name, frame, this.dimensions);
      this.render(frame);
      const maps = createPatchMaps(this.engine.camera, this.dimensions);
      const region = this.readMaps([...maps, ...fixedMaps]);
      frames.push(extractPatches(maps, region));
      wrongFrames.push(extractPatches(fixedMaps, region));

      const contactColumn = CONTACT_FRAMES.indexOf(frame);
      if (contactColumn >= 0) {
        drawFullFrameTile(
          sheets.contactContext,
          this.canvas,
          contactColumn,
          row,
          CONTACT_TILE.width,
          CONTACT_TILE.height,
          `${name.toUpperCase()} F${String(frame).padStart(3, '0')}`,
        );
        drawRoiTile(
          sheets.roiContext,
          this.canvas,
          maps,
          this.dimensions,
          contactColumn,
          row,
          ROI_TILE.width,
          ROI_TILE.height,
          `${name.toUpperCase()} F${String(frame).padStart(3, '0')}`,
        );
        if (includeControls && name === 'static' && sheets.controlsContext) {
          drawFullFrameTile(
            sheets.controlsContext,
            this.canvas,
            contactColumn,
            0,
            CONTACT_TILE.width,
            CONTACT_TILE.height,
            `STATIC RAW F${String(frame).padStart(3, '0')}`,
          );
        }
        if (
          includeControls
          && name === 'slow-yaw'
          && sheets.controlsContext
          && sheets.blur
          && sheets.blurContext
        ) {
          sheets.blurContext.clearRect(
            0,
            0,
            this.dimensions.width,
            this.dimensions.height,
          );
          sheets.blurContext.filter = 'blur(2px)';
          sheets.blurContext.drawImage(this.canvas, 0, 0);
          sheets.blurContext.filter = 'none';
          drawFullFrameTile(
            sheets.controlsContext,
            sheets.blur,
            contactColumn,
            2,
            CONTACT_TILE.width,
            CONTACT_TILE.height,
            `DELIBERATE BLUR F${String(frame).padStart(3, '0')}`,
          );
        }
      }

      if (historyCanvas && historyContext) {
        if (frame === 0) {
          historyContext.globalAlpha = 1;
          historyContext.drawImage(this.canvas, 0, 0);
        } else {
          historyContext.globalAlpha = 0.12;
          historyContext.drawImage(this.canvas, 0, 0);
          historyContext.globalAlpha = 1;
        }
        const ghostColumn = selectedGhostFrames.indexOf(frame);
        if (ghostColumn >= 0 && sheets.ghostsContext) {
          const rawRow = name === 'hard-stop' ? 0 : 2;
          drawRoiTile(
            sheets.ghostsContext,
            this.canvas,
            maps,
            this.dimensions,
            ghostColumn,
            rawRow,
            ROI_TILE.width,
            ROI_TILE.height,
            `${name.toUpperCase()} RAW F${String(frame).padStart(3, '0')}`,
          );
          drawRoiTile(
            sheets.ghostsContext,
            historyCanvas,
            maps,
            this.dimensions,
            ghostColumn,
            rawRow + 1,
            ROI_TILE.width,
            ROI_TILE.height,
            `${name.toUpperCase()} HISTORY F${String(frame).padStart(3, '0')}`,
          );
          if (
            includeControls
            && name === 'hard-stop'
            && sheets.controlsContext
          ) {
            drawFullFrameTile(
              sheets.controlsContext,
              historyCanvas,
              ghostColumn,
              3,
              CONTACT_TILE.width,
              CONTACT_TILE.height,
              `NAIVE HISTORY F${String(frame).padStart(3, '0')}`,
            );
          }
        }
      }
      await nextFrame();
    }

    const analysis = analyzeGroups(frames);
    const wrongAnalysis = analyzeGroups(wrongFrames);
    const blurredFrames = blurFrames(frames);
    const blurredAnalysis = analyzeGroups(blurredFrames);
    const holdFrame = name === 'hard-stop' ? 60 : name === 'reveal' ? 80 : null;
    const historyFrames = holdFrame === null ? undefined : blendHistory(frames, 0.88);
    const ghost = holdFrame === null ? undefined : analyzeGhost(frames, holdFrame);
    const historyGhost = holdFrame === null || !historyFrames
      ? undefined
      : analyzeGhost(historyFrames, holdFrame, frames);

    return {
      frames,
      wrongFrames,
      ...(historyFrames ? { historyFrames } : {}),
      analysis,
      wrongAnalysis,
      ...(ghost ? { ghost } : {}),
      ...(historyGhost ? { historyGhost } : {}),
      blurredAnalysis,
    };
  }

  private async captureJitterControl(sheets: CaptureSheets): Promise<SequenceCapture> {
    resetTemporalHistory(this.renderSystem);
    applyEvidencePose(
      this.engine.camera,
      'static-jitter',
      0,
      this.dimensions,
    );
    await this.warmUp('static-jitter');
    const fixedMaps = createPatchMaps(this.engine.camera, this.dimensions);
    const frames: Float32Array[][] = [];
    const wrongFrames: Float32Array[][] = [];

    for (let frame = 0; frame < EVIDENCE_FRAMES; frame++) {
      applyEvidencePose(
        this.engine.camera,
        'static-jitter',
        frame,
        this.dimensions,
      );
      this.render(frame);
      const maps = createPatchMaps(this.engine.camera, this.dimensions);
      const region = this.readMaps([...maps, ...fixedMaps]);
      frames.push(extractPatches(maps, region));
      wrongFrames.push(extractPatches(fixedMaps, region));
      const column = CONTACT_FRAMES.indexOf(frame);
      if (column >= 0 && sheets.controlsContext) {
        drawFullFrameTile(
          sheets.controlsContext,
          this.canvas,
          column,
          1,
          CONTACT_TILE.width,
          CONTACT_TILE.height,
          `SUBPIXEL JITTER F${String(frame).padStart(3, '0')}`,
        );
      }
      await nextFrame();
    }

    return {
      frames,
      wrongFrames,
      analysis: analyzeGroups(frames),
      wrongAnalysis: analyzeGroups(wrongFrames),
      blurredAnalysis: analyzeGroups(blurFrames(frames)),
    };
  }

  private async warmUp(name: SequenceName | 'static-jitter'): Promise<void> {
    for (let frame = 0; frame < 12; frame++) {
      applyEvidencePose(this.engine.camera, name, 0, this.dimensions);
      this.render(-12 + frame);
      await nextFrame();
    }
  }

  private render(frame: number): void {
    const update: UpdateContext = {
      dt: 1 / 60,
      elapsed: frame / 60,
      frame,
      alpha: 0,
    };
    this.renderSystem.update(update, this.engine.context);
    this.renderSystem.render();
  }

  private readMaps(maps: readonly PatchMap[]): ReadRegion {
    const bounds = mapBounds(maps, 3, this.dimensions);
    const glX = bounds.x;
    const glY = this.dimensions.height - bounds.y - bounds.height;
    const pixels = new Uint8Array(bounds.width * bounds.height * 4);
    this.gl.readPixels(
      glX,
      glY,
      bounds.width,
      bounds.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      pixels,
    );
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) {
      throw new Error(`WebGL readPixels failed with error 0x${error.toString(16)}.`);
    }
    return { ...bounds, pixels };
  }
}

function requiredCapture(
  captures: ReadonlyMap<SequenceName, SequenceCapture>,
  name: SequenceName,
): SequenceCapture {
  const capture = captures.get(name);
  if (!capture) throw new Error(`Missing sequence capture: ${name}`);
  return capture;
}

function evaluateControls(
  staticCapture: SequenceCapture,
  slowCapture: SequenceCapture,
  fastCapture: SequenceCapture,
  hardStopCapture: SequenceCapture,
  revealCapture: SequenceCapture,
  jitterCapture: SequenceCapture,
): NegativeControlEvidence {
  const staticP95 = staticCapture.analysis.all.coverageNoise.p95;
  const jitterP95 = jitterCapture.analysis.all.coverageNoise.p95;
  const jitterRatio = jitterP95 / Math.max(staticP95, 0.001);
  const rawFlicker = slowCapture.analysis.all.coverageNoise.p95;
  const blurredFlicker =
    slowCapture.blurredAnalysis?.all.coverageNoise.p95 ?? rawFlicker;
  const rawSharpness = staticCapture.analysis.all.edgeEnergy.median;
  const blurredSharpness =
    staticCapture.blurredAnalysis?.all.edgeEnergy.median ?? rawSharpness;
  const flickerReduction = rawFlicker > 0
    ? 1 - blurredFlicker / rawFlicker
    : 0;
  const sharpnessLoss = rawSharpness > 0
    ? 1 - blurredSharpness / rawSharpness
    : 0;
  const rawHardStopTrail = hardStopCapture.ghost?.trail.p95 ?? 0;
  const historyHardStopTrail = hardStopCapture.historyGhost?.trail.p95 ?? 0;
  const rawRevealTrail = revealCapture.ghost?.trail.p95 ?? 0;
  const historyRevealTrail = revealCapture.historyGhost?.trail.p95 ?? 0;
  const correctP95 = fastCapture.analysis.all.coverageNoise.p95;
  const wrongP95 = fastCapture.wrongAnalysis.all.coverageNoise.p95;
  const wrongRatio = wrongP95 / Math.max(correctP95, 0.001);

  const staticFalsePositive = {
    threshold: STATIC_FALSE_POSITIVE_MAX,
    actual: staticP95,
    passes: staticP95 <= STATIC_FALSE_POSITIVE_MAX,
  };
  const subpixelJitter = {
    requiredRatio: 4,
    actualRatio: rounded(jitterRatio),
    staticP95,
    jitterP95,
    passes: jitterP95 >= Math.max(0.25, staticP95 * 4),
  };
  const deliberateBlur = {
    requiredFlickerReduction: 0.08,
    requiredSharpnessLoss: 0.08,
    flickerReduction: rounded(flickerReduction),
    sharpnessLoss: rounded(sharpnessLoss),
    unblurredFlickerP95: rawFlicker,
    blurredFlickerP95: blurredFlicker,
    unblurredEdgeEnergy: rawSharpness,
    blurredEdgeEnergy: blurredSharpness,
    passes: flickerReduction >= 0.08 && sharpnessLoss >= 0.08,
  };
  const historyWithoutRejection = {
    requiredMinimumTrail: 0.5,
    rawHardStopTrailP95: rawHardStopTrail,
    historyHardStopTrailP95: historyHardStopTrail,
    rawRevealTrailP95: rawRevealTrail,
    historyRevealTrailP95: historyRevealTrail,
    passes:
      Math.max(historyHardStopTrail, historyRevealTrail)
        >= Math.max(0.5, Math.max(rawHardStopTrail, rawRevealTrail) * 3),
  };
  const wrongMotionCompensation = {
    requiredRatio: 1.2,
    correctP95,
    wrongP95,
    actualRatio: rounded(wrongRatio),
    passes: wrongP95 >= correctP95 * 1.2,
  };
  return {
    staticFalsePositive,
    subpixelJitter,
    deliberateBlur,
    historyWithoutRejection,
    wrongMotionCompensation,
    allPass:
      staticFalsePositive.passes
      && subpixelJitter.passes
      && deliberateBlur.passes
      && historyWithoutRejection.passes
      && wrongMotionCompensation.passes,
  };
}

function createPatchMaps(
  camera: THREE.PerspectiveCamera,
  dimensions: EvidenceDimensions,
): PatchMap[] {
  const maps: PatchMap[] = [];
  for (let index = 0; index < BAR_COUNT; index++) {
    const layout = PATCH_LAYOUTS[index];
    const x = -3 + index * 0.55;
    const z = -8 - index * 1.1;
    const bottom = project(camera, new THREE.Vector3(x, 0.15, z), dimensions);
    const top = project(camera, new THREE.Vector3(x, 2.25, z), dimensions);
    const middle = project(camera, new THREE.Vector3(x, 1.2, z), dimensions);
    const right = project(
      camera,
      new THREE.Vector3(x + 0.06, 1.2, z),
      dimensions,
    );
    const tangent = top.clone().sub(bottom);
    const tangentLength = tangent.length();
    const tangentDirection = tangentLength > 0
      ? tangent.clone().multiplyScalar(1 / tangentLength)
      : new THREE.Vector2(0, -1);
    const halfWidth = right.clone().sub(middle);
    halfWidth.addScaledVector(
      tangentDirection,
      -halfWidth.dot(tangentDirection),
    );
    if (halfWidth.length() < 0.25) {
      halfWidth.set(-tangentDirection.y, tangentDirection.x).multiplyScalar(0.25);
    }
    const coordinates = new Float32Array(layout.width * layout.height * 2);
    let offset = 0;
    for (let row = 0; row < layout.height; row++) {
      const v = (row + 0.5) / layout.height;
      const center = bottom.clone().lerp(top, v);
      for (let column = 0; column < layout.width; column++) {
        const u = interpolate(-3.2, 3.2, (column + 0.5) / layout.width);
        coordinates[offset++] = center.x + halfWidth.x * u;
        coordinates[offset++] = center.y + halfWidth.y * u;
      }
    }
    maps.push({ ...layout, coordinates });
  }

  for (let index = 0; index < SPECULAR_CENTERS.length; index++) {
    const layout = PATCH_LAYOUTS[BAR_COUNT + index];
    const centerWorld = SPECULAR_CENTERS[index];
    const center = project(camera, centerWorld, dimensions);
    const right = project(
      camera,
      centerWorld.clone().add(new THREE.Vector3(0.45, 0, 0)),
      dimensions,
    ).sub(center);
    const up = project(
      camera,
      centerWorld.clone().add(new THREE.Vector3(0, 0.45, 0)),
      dimensions,
    ).sub(center);
    const coordinates = new Float32Array(layout.width * layout.height * 2);
    let offset = 0;
    for (let row = 0; row < layout.height; row++) {
      const v = interpolate(1.25, -1.25, (row + 0.5) / layout.height);
      for (let column = 0; column < layout.width; column++) {
        const u = interpolate(-1.25, 1.25, (column + 0.5) / layout.width);
        coordinates[offset++] = center.x + right.x * u + up.x * v;
        coordinates[offset++] = center.y + right.y * u + up.y * v;
      }
    }
    maps.push({ ...layout, coordinates });
  }
  return maps;
}

function project(
  camera: THREE.PerspectiveCamera,
  point: THREE.Vector3,
  dimensions: EvidenceDimensions,
): THREE.Vector2 {
  const projected = point.clone().project(camera);
  return new THREE.Vector2(
    (projected.x * 0.5 + 0.5) * dimensions.width,
    (0.5 - projected.y * 0.5) * dimensions.height,
  );
}

function mapBounds(
  maps: readonly PatchMap[],
  margin: number,
  dimensions: EvidenceDimensions,
): { x: number; y: number; width: number; height: number } {
  let minimumX = dimensions.width - 1;
  let minimumY = dimensions.height - 1;
  let maximumX = 0;
  let maximumY = 0;
  for (const map of maps) {
    for (let index = 0; index < map.coordinates.length; index += 2) {
      const x = map.coordinates[index];
      const y = map.coordinates[index + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  const x = Math.max(0, Math.floor(minimumX - margin));
  const y = Math.max(0, Math.floor(minimumY - margin));
  const right = Math.min(dimensions.width, Math.ceil(maximumX + margin));
  const bottom = Math.min(dimensions.height, Math.ceil(maximumY + margin));
  if (right <= x || bottom <= y) {
    throw new Error('Temporal ROI projection produced an empty read region.');
  }
  return { x, y, width: right - x, height: bottom - y };
}

function extractPatches(
  maps: readonly PatchMap[],
  region: ReadRegion,
): Float32Array[] {
  return maps.map((map) => {
    const patch = new Float32Array(map.width * map.height);
    for (let index = 0; index < patch.length; index++) {
      patch[index] = sampleLuminance(
        region,
        map.coordinates[index * 2],
        map.coordinates[index * 2 + 1],
      );
    }
    return patch;
  });
}

function sampleLuminance(region: ReadRegion, screenX: number, screenY: number): number {
  const x = THREE.MathUtils.clamp(screenX - region.x, 0, region.width - 1);
  const topY = THREE.MathUtils.clamp(screenY - region.y, 0, region.height - 1);
  const bottomY = region.height - 1 - topY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(bottomY);
  const x1 = Math.min(region.width - 1, x0 + 1);
  const y1 = Math.min(region.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = bottomY - y0;
  const a = pixelLuminance(region, x0, y0);
  const b = pixelLuminance(region, x1, y0);
  const c = pixelLuminance(region, x0, y1);
  const d = pixelLuminance(region, x1, y1);
  return interpolate(interpolate(a, b, tx), interpolate(c, d, tx), ty);
}

function pixelLuminance(region: ReadRegion, x: number, y: number): number {
  const offset = (y * region.width + x) * 4;
  return (
    region.pixels[offset] * 0.2126
    + region.pixels[offset + 1] * 0.7152
    + region.pixels[offset + 2] * 0.0722
  ) / 255;
}

function analyzeGroups(frames: readonly Float32Array[][]): AnalysisGroups {
  return {
    all: analyzeFrames(frames, () => true),
    bars: analyzeFrames(frames, (layout) => layout.kind === 'bar'),
    specular: analyzeFrames(frames, (layout) => layout.kind === 'specular'),
  };
}

function analyzeFrames(
  frames: readonly Float32Array[][],
  include: (layout: PatchLayout) => boolean,
): TemporalAnalysis {
  const edgeEnergy: number[] = [];
  const coverageNoise: number[] = [];
  const frameDifference: number[] = [];
  let temporalEdgeSamples = 0;
  let temporalSamples = 0;

  for (const frame of frames) {
    let energy = 0;
    let count = 0;
    for (let patchIndex = 0; patchIndex < PATCH_LAYOUTS.length; patchIndex++) {
      const layout = PATCH_LAYOUTS[patchIndex];
      if (!include(layout)) continue;
      const patch = frame[patchIndex];
      for (let y = 1; y < layout.height - 1; y++) {
        for (let x = 1; x < layout.width - 1; x++) {
          energy += gradientAt(patch, layout.width, x, y);
          count++;
        }
      }
    }
    edgeEnergy.push(count > 0 ? (energy / count) * 1000 : 0);
  }

  for (let frameIndex = 1; frameIndex < frames.length - 1; frameIndex++) {
    let secondDifference = 0;
    let firstDifference = 0;
    let edgeCount = 0;
    let sampleCount = 0;
    const previous = frames[frameIndex - 1];
    const current = frames[frameIndex];
    const next = frames[frameIndex + 1];
    for (let patchIndex = 0; patchIndex < PATCH_LAYOUTS.length; patchIndex++) {
      const layout = PATCH_LAYOUTS[patchIndex];
      if (!include(layout)) continue;
      const previousPatch = previous[patchIndex];
      const currentPatch = current[patchIndex];
      const nextPatch = next[patchIndex];
      for (let y = 1; y < layout.height - 1; y++) {
        for (let x = 1; x < layout.width - 1; x++) {
          const index = y * layout.width + x;
          const edge = Math.max(
            gradientAt(previousPatch, layout.width, x, y),
            gradientAt(currentPatch, layout.width, x, y),
            gradientAt(nextPatch, layout.width, x, y),
          );
          sampleCount++;
          if (edge < EDGE_THRESHOLD) continue;
          secondDifference += Math.abs(
            currentPatch[index] - (previousPatch[index] + nextPatch[index]) * 0.5,
          );
          firstDifference += Math.abs(currentPatch[index] - previousPatch[index]);
          edgeCount++;
        }
      }
    }
    temporalEdgeSamples += edgeCount;
    temporalSamples += sampleCount;
    coverageNoise.push(edgeCount > 0 ? (secondDifference / edgeCount) * 1000 : 0);
    frameDifference.push(edgeCount > 0 ? (firstDifference / edgeCount) * 1000 : 0);
  }

  return {
    coverageNoise: distribution(coverageNoise),
    compensatedFrameDifference: distribution(frameDifference),
    edgeEnergy: distribution(edgeEnergy),
    edgeSampleFraction:
      temporalSamples > 0 ? rounded(temporalEdgeSamples / temporalSamples) : 0,
  };
}

function gradientAt(
  patch: Float32Array,
  width: number,
  x: number,
  y: number,
): number {
  const horizontal = Math.abs(
    patch[y * width + x + 1] - patch[y * width + x - 1],
  ) * 0.5;
  const vertical = Math.abs(
    patch[(y + 1) * width + x] - patch[(y - 1) * width + x],
  ) * 0.5;
  return Math.hypot(horizontal, vertical);
}

function blurFrames(frames: readonly Float32Array[][]): Float32Array[][] {
  return frames.map((frame) => frame.map((patch, patchIndex) => {
    const layout = PATCH_LAYOUTS[patchIndex];
    return blurPatch(patch, layout.width, layout.height);
  }));
}

function blurPatch(
  patch: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const kernel = [1, 4, 6, 4, 1];
  const horizontal = new Float32Array(patch.length);
  const result = new Float32Array(patch.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let offset = -2; offset <= 2; offset++) {
        const sampleX = THREE.MathUtils.clamp(x + offset, 0, width - 1);
        sum += patch[y * width + sampleX] * kernel[offset + 2];
      }
      horizontal[y * width + x] = sum / 16;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let offset = -2; offset <= 2; offset++) {
        const sampleY = THREE.MathUtils.clamp(y + offset, 0, height - 1);
        sum += horizontal[sampleY * width + x] * kernel[offset + 2];
      }
      result[y * width + x] = sum / 16;
    }
  }
  return result;
}

function blendHistory(
  frames: readonly Float32Array[][],
  historyWeight: number,
): Float32Array[][] {
  const output: Float32Array[][] = [];
  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const current = frames[frameIndex];
    if (frameIndex === 0) {
      output.push(current.map((patch) => new Float32Array(patch)));
      continue;
    }
    const previous = output[frameIndex - 1];
    output.push(current.map((patch, patchIndex) => {
      const blended = new Float32Array(patch.length);
      const previousPatch = previous[patchIndex];
      for (let index = 0; index < patch.length; index++) {
        blended[index] =
          previousPatch[index] * historyWeight + patch[index] * (1 - historyWeight);
      }
      return blended;
    }));
  }
  return output;
}

function analyzeGhost(
  frames: readonly Float32Array[][],
  holdFrame: number,
  referenceFrames: readonly Float32Array[][] = frames,
): GhostAnalysis {
  const settledStart = Math.max(holdFrame, referenceFrames.length - 10);
  const references = PATCH_LAYOUTS.map((layout, patchIndex) => {
    const reference = new Float32Array(layout.width * layout.height);
    for (let frame = settledStart; frame < referenceFrames.length; frame++) {
      const patch = referenceFrames[frame][patchIndex];
      for (let index = 0; index < patch.length; index++) reference[index] += patch[index];
    }
    const count = referenceFrames.length - settledStart;
    for (let index = 0; index < reference.length; index++) reference[index] /= count;
    return reference;
  });

  const before = referenceFrames[Math.max(0, holdFrame - 1)];
  const masks = PATCH_LAYOUTS.map((layout, patchIndex) => {
    const mask = new Uint8Array(layout.width * layout.height);
    const reference = references[patchIndex];
    const previous = before[patchIndex];
    for (let y = 1; y < layout.height - 1; y++) {
      for (let x = 1; x < layout.width - 1; x++) {
        const index = y * layout.width + x;
        if (
          Math.abs(previous[index] - reference[index]) >= 0.012
          || gradientAt(reference, layout.width, x, y) >= EDGE_THRESHOLD
        ) {
          mask[index] = 1;
        }
      }
    }
    return mask;
  });

  const trails: number[] = [];
  let changed = 0;
  let total = 0;
  for (const mask of masks) {
    for (const value of mask) {
      changed += value;
      total++;
    }
  }
  const lastFrame = Math.min(frames.length, holdFrame + 24);
  for (let frameIndex = holdFrame; frameIndex < lastFrame; frameIndex++) {
    let error = 0;
    let count = 0;
    for (let patchIndex = 0; patchIndex < PATCH_LAYOUTS.length; patchIndex++) {
      const patch = frames[frameIndex][patchIndex];
      const reference = references[patchIndex];
      const mask = masks[patchIndex];
      for (let index = 0; index < patch.length; index++) {
        if (!mask[index]) continue;
        error += Math.abs(patch[index] - reference[index]);
        count++;
      }
    }
    trails.push(count > 0 ? (error / count) * 1000 : 0);
  }
  return {
    holdFrame,
    changedSampleFraction: total > 0 ? rounded(changed / total) : 0,
    trail: distribution(trails),
    firstFrame: rounded(trails[0] ?? 0),
    fourthFrame: rounded(trails[3] ?? trails.at(-1) ?? 0),
    twelfthFrame: rounded(trails[11] ?? trails.at(-1) ?? 0),
  };
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { samples: 0, median: 0, p95: 0, worst: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    worst: quantile(sorted, 1),
  };
}

function quantile(sorted: readonly number[], percentile: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.floor((sorted.length - 1) * percentile),
  );
  return rounded(sorted[index]);
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function createSheets(
  includeControls: boolean,
  sourceWidth: number,
  sourceHeight: number,
): CaptureSheets {
  const contact = document.createElement('canvas');
  contact.width = CONTACT_FRAMES.length * CONTACT_TILE.width;
  contact.height = SEQUENCES.length * CONTACT_TILE.height;
  const contactContext = required2d(contact);
  contactContext.fillStyle = '#000';
  contactContext.fillRect(0, 0, contact.width, contact.height);

  const roi = document.createElement('canvas');
  roi.width = CONTACT_FRAMES.length * ROI_TILE.width;
  roi.height = SEQUENCES.length * ROI_TILE.height;
  const roiContext = required2d(roi);
  roiContext.fillStyle = '#000';
  roiContext.fillRect(0, 0, roi.width, roi.height);

  if (!includeControls) return { contact, contactContext, roi, roiContext };

  const controls = document.createElement('canvas');
  controls.width = CONTACT_FRAMES.length * CONTACT_TILE.width;
  controls.height = 4 * CONTACT_TILE.height;
  const controlsContext = required2d(controls);
  controlsContext.fillStyle = '#000';
  controlsContext.fillRect(0, 0, controls.width, controls.height);

  const ghosts = document.createElement('canvas');
  ghosts.width = HARD_STOP_FRAMES.length * ROI_TILE.width;
  ghosts.height = 4 * ROI_TILE.height;
  const ghostsContext = required2d(ghosts);
  ghostsContext.fillStyle = '#000';
  ghostsContext.fillRect(0, 0, ghosts.width, ghosts.height);

  const blur = document.createElement('canvas');
  blur.width = sourceWidth;
  blur.height = sourceHeight;
  const blurContext = required2d(blur);

  return {
    contact,
    contactContext,
    roi,
    roiContext,
    controls,
    controlsContext,
    ghosts,
    ghostsContext,
    blur,
    blurContext,
  };
}

function required2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('2D canvas is unavailable.');
  return context;
}

function drawFullFrameTile(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  column: number,
  row: number,
  width: number,
  height: number,
  label: string,
): void {
  const x = column * width;
  const y = row * height;
  context.drawImage(source, x, y, width, height);
  drawLabel(context, x, y, width, label);
}

function drawRoiTile(
  context: CanvasRenderingContext2D,
  source: CanvasImageSource,
  maps: readonly PatchMap[],
  dimensions: EvidenceDimensions,
  column: number,
  row: number,
  width: number,
  height: number,
  label: string,
): void {
  const bounds = fitBoundsToAspect(
    mapBounds(maps, 24, dimensions),
    width / height,
    dimensions,
  );
  const x = column * width;
  const y = row * height;
  context.drawImage(
    source,
    bounds.x,
    bounds.y,
    bounds.width,
    bounds.height,
    x,
    y,
    width,
    height,
  );
  drawLabel(context, x, y, width, label);
}

function fitBoundsToAspect(
  bounds: { x: number; y: number; width: number; height: number },
  aspect: number,
  dimensions: EvidenceDimensions,
): { x: number; y: number; width: number; height: number } {
  let { x, y, width, height } = bounds;
  const currentAspect = width / height;
  if (currentAspect < aspect) {
    const expanded = height * aspect;
    x -= (expanded - width) * 0.5;
    width = expanded;
  } else {
    const expanded = width / aspect;
    y -= (expanded - height) * 0.5;
    height = expanded;
  }
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + width > dimensions.width) x = dimensions.width - width;
  if (y + height > dimensions.height) y = dimensions.height - height;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.min(dimensions.width, Math.round(width)),
    height: Math.min(dimensions.height, Math.round(height)),
  };
}

function drawLabel(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  label: string,
): void {
  context.save();
  context.fillStyle = 'rgba(0, 0, 0, 0.72)';
  context.fillRect(x, y, width, 20);
  context.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
  context.textBaseline = 'middle';
  context.fillStyle = '#fff';
  context.fillText(label, x + 6, y + 10);
  context.restore();
}

function resetTemporalHistory(renderSystem: RenderSystem): void {
  const resettable = renderSystem as RenderSystem & {
    resetTemporalHistory?: () => void;
  };
  resettable.resetTemporalHistory?.();
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
