import * as THREE from 'three';

export const AA_MODES = [
  'ultra',
  'high',
  'medium',
  'low',
  'fxaa',
  'msaa2',
  'msaa4',
  'msaa2-smaa',
  'off',
] as const;

export const DPR_MODES = ['auto', '1', '1.25', '1.5', '2'] as const;

export type AaMode = typeof AA_MODES[number];
export type DprMode = typeof DPR_MODES[number];

export interface AaResolution {
  effective: AaMode;
  multisampling: number;
  fallbackReason: string | null;
}

export interface RenderDiagnostics {
  requestedAa: AaMode;
  effectiveAa: AaMode;
  requestedDpr: DprMode;
  deviceDpr: number;
  effectiveDpr: number;
  rgba16fSupportedSamples: number[];
  rgba16fEffectiveSamples: number[];
  forcedSampleCapability: boolean;
  aaFallbackReason: string | null;
  composerMultisampling: number;
  frameBufferType: 'RGBA16F';
  cssWidth: number;
  cssHeight: number;
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  drawingBufferPixels: number;
}

/**
 * The reviewed Retina profile is safe at about 3.34 megapixels with SMAA but
 * not at its native 5.94 megapixels. Auto DPR therefore preserves at most 1.5x
 * density and independently caps the drawing-buffer pixel count.
 */
export const AUTO_DPR_MAX = 1.5;
export const AUTO_DRAWING_BUFFER_PIXELS = 3_340_000;

export function parseAaMode(
  query: URLSearchParams,
  fallback: AaMode,
): AaMode {
  const value = query.get('aa');
  if (value === null) return fallback;
  if ((AA_MODES as readonly string[]).includes(value)) return value as AaMode;
  throw new Error(
    `Unsupported aa mode "${value}". Expected one of: ${AA_MODES.join(', ')}.`,
  );
}

export function parseDprMode(query: URLSearchParams): DprMode {
  const value = query.get('dpr');
  if (value === null) return 'auto';
  if ((DPR_MODES as readonly string[]).includes(value)) return value as DprMode;
  throw new Error(
    `Unsupported dpr mode "${value}". Expected one of: ${DPR_MODES.join(', ')}.`,
  );
}

export function probeRgba16fSamples(
  renderer: THREE.WebGLRenderer,
  query: URLSearchParams,
): {
  actual: number[];
  effective: number[];
  forced: boolean;
} {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
  const actual = colorBufferFloat
    ? normalizeSamples(
      gl.getInternalformatParameter(
        gl.RENDERBUFFER,
        gl.RGBA16F,
        gl.SAMPLES,
      ) as Int32Array | number[],
    )
    : [];

  const forcedValue = import.meta.env.DEV
    ? query.get('forceRgba16fSamples')
    : null;
  if (forcedValue === null) {
    return { actual, effective: actual, forced: false };
  }
  if (!/^(0|2|4)$/.test(forcedValue)) {
    throw new Error(
      'forceRgba16fSamples must be 0, 2, or 4 in a development harness.',
    );
  }
  const ceiling = Number(forcedValue);
  return {
    actual,
    effective: actual.filter((sample) => sample <= ceiling),
    forced: true,
  };
}

export function resolveAaMode(
  requested: AaMode,
  supportedSamples: readonly number[],
): AaResolution {
  if (requested === 'msaa4') {
    if (supportedSamples.includes(4)) {
      return { effective: 'msaa4', multisampling: 4, fallbackReason: null };
    }
    if (supportedSamples.includes(2)) {
      return {
        effective: 'msaa2',
        multisampling: 2,
        fallbackReason: 'RGBA16F does not support 4x MSAA; using 2x.',
      };
    }
    return {
      effective: 'ultra',
      multisampling: 0,
      fallbackReason: 'RGBA16F does not support multisampling; using SMAA Ultra.',
    };
  }
  if (requested === 'msaa2' || requested === 'msaa2-smaa') {
    if (supportedSamples.includes(2)) {
      return {
        effective: requested,
        multisampling: 2,
        fallbackReason: null,
      };
    }
    return {
      effective: 'ultra',
      multisampling: 0,
      fallbackReason: 'RGBA16F does not support 2x MSAA; using SMAA Ultra.',
    };
  }
  return { effective: requested, multisampling: 0, fallbackReason: null };
}

export function resolveDpr(
  requested: DprMode,
  deviceDpr: number,
  cssWidth: number,
  cssHeight: number,
): number {
  if (requested !== 'auto') return Number(requested);
  const cssPixels = Math.max(1, cssWidth * cssHeight);
  const pixelBudgetDpr = Math.sqrt(AUTO_DRAWING_BUFFER_PIXELS / cssPixels);
  return roundDpr(Math.min(deviceDpr, AUTO_DPR_MAX, pixelBudgetDpr));
}

export function updateDrawingBufferDiagnostics(
  diagnostics: RenderDiagnostics,
  renderer: THREE.WebGLRenderer,
  cssWidth: number,
  cssHeight: number,
  effectiveDpr: number,
): void {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  diagnostics.cssWidth = cssWidth;
  diagnostics.cssHeight = cssHeight;
  diagnostics.effectiveDpr = effectiveDpr;
  diagnostics.drawingBufferWidth = size.x;
  diagnostics.drawingBufferHeight = size.y;
  diagnostics.drawingBufferPixels = size.x * size.y;
}

function normalizeSamples(samples: Int32Array | number[]): number[] {
  return [...samples]
    .filter((sample) => Number.isInteger(sample) && sample > 0)
    .sort((left, right) => right - left)
    .filter((sample, index, values) => values.indexOf(sample) === index);
}

function roundDpr(value: number): number {
  return Math.max(0.5, Math.round(value * 1000) / 1000);
}
