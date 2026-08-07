/**
 * n8ao ships no types. Declaring only the surface actually used, rather than
 * `any`, so a typo in a configuration key is still a compile error — the whole
 * point of having types at all.
 */
declare module 'n8ao' {
  import type { Pass } from 'postprocessing';
  import type { Camera, Color, Scene } from 'three';

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width: number, height: number);
    configuration: {
      aoRadius: number;
      distanceFalloff: number;
      intensity: number;
      color: Color;
      halfRes: boolean;
      screenSpaceRadius?: boolean;
      aoSamples?: number;
      denoiseSamples?: number;
      denoiseRadius?: number;
    };
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
    setSize(width: number, height: number): void;
  }
}
