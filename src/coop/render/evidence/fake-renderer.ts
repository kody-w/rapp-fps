/**
 * A call-recording renderer for the browser-free coordinator fixtures. — Refs #71
 *
 * It implements exactly {@link CoopRendererLike} — the same surface the real
 * `THREE.WebGLRenderer` satisfies — and records, in order, every op the
 * coordinator performs plus the GL state that was live at each `render`/`clear`.
 * That lets the fixtures prove slot isolation (which scissor each draw ran
 * under), state restoration (the values left behind), and that no simulation
 * path exists (the op vocabulary is a small closed set), all with pure numbers
 * and no GPU.
 */

import * as THREE from 'three';
import type { CoopRendererLike } from '../coordinator.js';

/** GL state captured at the instant of a `render` or `clear`. */
export interface StateSnapshot {
  readonly viewport: readonly [number, number, number, number];
  readonly scissor: readonly [number, number, number, number];
  readonly scissorTest: boolean;
  readonly autoClear: boolean;
  readonly clearColor: string;
  readonly clearAlpha: number;
}

export interface RenderRecord extends StateSnapshot {
  /** Reference identity of the drawn scene; the fixture checks it is the shared one. */
  readonly scene: THREE.Object3D;
  readonly camera: THREE.Camera;
  readonly cameraName: string;
  /** `camera.aspect` at the moment of the draw. */
  readonly cameraAspect: number;
}

export interface ClearRecord extends StateSnapshot {
  readonly color: boolean;
  readonly depth: boolean;
  readonly stencil: boolean;
}

export class FakeRenderer implements CoopRendererLike {
  autoClear = true;

  private readonly viewport: THREE.Vector4;
  private readonly scissor: THREE.Vector4;
  private scissorTest = false;
  private readonly clearColor = new THREE.Color(0, 0, 0);
  private clearAlpha = 1;

  /** Ordered op names, e.g. 'setScissorTest:true', 'setViewport', 'render'. */
  readonly ops: string[] = [];
  readonly renders: RenderRecord[] = [];
  readonly clears: ClearRecord[] = [];

  /**
   * When set, `render` throws on the draw with this 0-based index — used to
   * prove the coordinator's `finally` still restores state on a failed draw.
   */
  throwOnRender: number | null = null;

  constructor(cssWidth: number, cssHeight: number) {
    this.viewport = new THREE.Vector4(0, 0, cssWidth, cssHeight);
    this.scissor = new THREE.Vector4(0, 0, cssWidth, cssHeight);
  }

  private snapshot(): StateSnapshot {
    return {
      viewport: [this.viewport.x, this.viewport.y, this.viewport.z, this.viewport.w],
      scissor: [this.scissor.x, this.scissor.y, this.scissor.z, this.scissor.w],
      scissorTest: this.scissorTest,
      autoClear: this.autoClear,
      clearColor: this.clearColor.getHexString(),
      clearAlpha: this.clearAlpha,
    };
  }

  getViewport(target: THREE.Vector4): THREE.Vector4 {
    return target.copy(this.viewport);
  }

  setViewport(x: number, y: number, width: number, height: number): void {
    this.viewport.set(x, y, width, height);
    this.ops.push('setViewport');
  }

  getScissor(target: THREE.Vector4): THREE.Vector4 {
    return target.copy(this.scissor);
  }

  setScissor(x: number, y: number, width: number, height: number): void {
    this.scissor.set(x, y, width, height);
    this.ops.push('setScissor');
  }

  getScissorTest(): boolean {
    return this.scissorTest;
  }

  setScissorTest(enabled: boolean): void {
    this.scissorTest = enabled;
    this.ops.push(`setScissorTest:${enabled}`);
  }

  getClearColor(target: THREE.Color): THREE.Color {
    return target.copy(this.clearColor);
  }

  getClearAlpha(): number {
    return this.clearAlpha;
  }

  setClearColor(color: THREE.Color, alpha = 1): void {
    this.clearColor.copy(color);
    this.clearAlpha = alpha;
    this.ops.push('setClearColor');
  }

  clear(color = true, depth = true, stencil = true): void {
    this.clears.push({ ...this.snapshot(), color, depth, stencil });
    this.ops.push('clear');
  }

  render(scene: THREE.Object3D, camera: THREE.Camera): void {
    const index = this.renders.length;
    const perspective = camera as THREE.PerspectiveCamera;
    this.renders.push({
      ...this.snapshot(),
      scene,
      camera,
      cameraName: camera.name,
      cameraAspect: perspective.aspect,
    });
    this.ops.push('render');
    if (this.throwOnRender === index) {
      throw new Error(`FakeRenderer forced failure on draw ${index}`);
    }
  }
}
