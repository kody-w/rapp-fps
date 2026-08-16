/**
 * Co-op render coordinator/adapter. — Refs #71
 *
 * Draws ONE shared scene through two independent cameras into a horizontal
 * split, and — this is the part that is easy to get wrong — leaves the renderer
 * and both cameras exactly as it found them.
 *
 * What it deliberately does NOT do: it runs no simulation, no fixed step, no
 * input, no per-view update. It takes a scene whose world matrices were already
 * computed once for the frame and issues, per slot, only presentation calls:
 * set viewport, set scissor, enable the scissor test, clear inside the scissor,
 * and one `render(scene, camera)`. "No duplicated simulation per view" is
 * therefore a property of the type, not a promise: there is nowhere for a
 * caller to hang a second update, and the same `scene` reference is handed to
 * every camera.
 *
 * State restoration mirrors `RenderSystem.render`: everything mutated is saved
 * up front and restored in a `finally`, so a throwing draw cannot leak a slot
 * viewport, a live scissor test, a slot clear colour, or a slot aspect ratio
 * into the rest of the engine. Cameras are restored before the renderer so no
 * observer ever sees a camera at its slot aspect under a slot viewport.
 *
 * The renderer is accepted through the structural {@link CoopRendererLike}
 * interface — exactly the surface `THREE.WebGLRenderer` already exposes — so the
 * same coordinator drives the real renderer in the WebGL harness and a
 * call-recording fake in the browser-free fixtures.
 */

import * as THREE from 'three';
import type { CoopViewportPlan } from './viewport.js';

/**
 * The minimal renderer surface the coordinator uses. `THREE.WebGLRenderer`
 * satisfies this structurally; nothing here is co-op specific.
 */
export interface CoopRendererLike {
  autoClear: boolean;
  getViewport(target: THREE.Vector4): THREE.Vector4;
  setViewport(x: number, y: number, width: number, height: number): void;
  getScissor(target: THREE.Vector4): THREE.Vector4;
  setScissor(x: number, y: number, width: number, height: number): void;
  getScissorTest(): boolean;
  setScissorTest(enabled: boolean): void;
  getClearColor(target: THREE.Color): THREE.Color;
  getClearAlpha(): number;
  setClearColor(color: THREE.Color, alpha?: number): void;
  clear(color?: boolean, depth?: boolean, stencil?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
}

export interface CoopRenderOptions {
  /**
   * Optional per-slot clear colour (presentation only — never simulation).
   * Length must equal the slot count. Restored to the renderer's prior clear
   * colour in the `finally`. Handy for letterboxing or, in the harness, for
   * painting each slot a known colour so the seam can be read back exactly.
   */
  readonly slotClearColors?: readonly THREE.Color[];
  /** Alpha used with `slotClearColors`. Defaults to 1. */
  readonly slotClearAlpha?: number;
  /** Whether to clear the depth buffer per slot. Defaults to true. */
  readonly clearDepth?: boolean;
  /** Per-slot presentation hook after aspect projection and before draw. */
  readonly prepareSlot?: (
    index: number,
    camera: THREE.PerspectiveCamera,
  ) => void;
}

export type CoopRenderResult =
  | { readonly rendered: true; readonly slots: number }
  | { readonly rendered: false; readonly reason: string };

interface CameraSnapshot {
  aspect: number;
  readonly projection: THREE.Matrix4;
  readonly projectionInverse: THREE.Matrix4;
}

export class CoopRenderCoordinator {
  private readonly savedViewport = new THREE.Vector4();
  private readonly savedScissor = new THREE.Vector4();
  private readonly savedClearColor = new THREE.Color();
  private readonly cameraScratch: CameraSnapshot[] = [];

  private ensureCameraScratch(count: number): void {
    while (this.cameraScratch.length < count) {
      this.cameraScratch.push({
        aspect: 1,
        projection: new THREE.Matrix4(),
        projectionInverse: new THREE.Matrix4(),
      });
    }
  }

  /**
   * Render the shared scene through the plan's slots.
   *
   * Returns a refusal (without touching any GL or camera state) when the plan
   * is unrenderable — a zero/degenerate size — or when the camera or clear-colour
   * counts do not match the plan. A genuine failure thrown by `renderer.render`
   * propagates AFTER the `finally` has restored every saved value, exactly like
   * the shake path in `RenderSystem.render`.
   *
   * @param plan Output of {@link planCoopViewports}.
   * @param scene The one shared scene; the same reference is drawn per camera.
   * @param cameras Player-ordered cameras; `cameras.length` must equal the slot count.
   */
  renderCoop(
    plan: CoopViewportPlan,
    scene: THREE.Scene,
    cameras: readonly THREE.PerspectiveCamera[],
    renderer: CoopRendererLike,
    options?: CoopRenderOptions,
  ): CoopRenderResult {
    if (!plan.renderable) return { rendered: false, reason: plan.reason };

    const { slots } = plan;
    if (cameras.length !== slots.length) {
      return {
        rendered: false,
        reason: `expected ${slots.length} camera(s) for ${plan.players}-player plan, got ${cameras.length}`,
      };
    }
    const clearColors = options?.slotClearColors;
    if (clearColors && clearColors.length !== slots.length) {
      return {
        rendered: false,
        reason: `expected ${slots.length} slotClearColors, got ${clearColors.length}`,
      };
    }

    this.ensureCameraScratch(cameras.length);

    // ── Save everything this call will mutate ────────────────────────────
    renderer.getViewport(this.savedViewport);
    renderer.getScissor(this.savedScissor);
    const savedScissorTest = renderer.getScissorTest();
    const savedAutoClear = renderer.autoClear;
    renderer.getClearColor(this.savedClearColor);
    const savedClearAlpha = renderer.getClearAlpha();
    for (let i = 0; i < cameras.length; i++) {
      const camera = cameras[i];
      const snapshot = this.cameraScratch[i];
      snapshot.aspect = camera.aspect;
      snapshot.projection.copy(camera.projectionMatrix);
      snapshot.projectionInverse.copy(camera.projectionMatrixInverse);
    }

    const clearDepth = options?.clearDepth ?? true;
    const clearAlpha = options?.slotClearAlpha ?? 1;

    try {
      // The scissor test confines each slot's clear and draw to its own band, so
      // slot 1's clear cannot erase slot 0's pixels.
      renderer.setScissorTest(true);
      renderer.autoClear = false;

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const camera = cameras[i];

        // Project for this slot's true pixel aspect, so the image is not
        // stretched by the half-height band.
        camera.aspect = slot.aspect;
        camera.updateProjectionMatrix();
        options?.prepareSlot?.(i, camera);

        const { x, y, width, height } = slot.css;
        renderer.setViewport(x, y, width, height);
        renderer.setScissor(x, y, width, height);
        if (clearColors) renderer.setClearColor(clearColors[i], clearAlpha);
        renderer.clear(true, clearDepth, false);
        renderer.render(scene, camera);
      }

      return { rendered: true, slots: slots.length };
    } finally {
      // Restore cameras first (so no observer sees a slot-aspect camera under a
      // slot viewport), then the renderer, in reverse of the mutation order.
      for (let i = 0; i < cameras.length; i++) {
        const camera = cameras[i];
        const snapshot = this.cameraScratch[i];
        camera.aspect = snapshot.aspect;
        camera.projectionMatrix.copy(snapshot.projection);
        camera.projectionMatrixInverse.copy(snapshot.projectionInverse);
      }
      renderer.setClearColor(this.savedClearColor, savedClearAlpha);
      renderer.setViewport(
        this.savedViewport.x,
        this.savedViewport.y,
        this.savedViewport.z,
        this.savedViewport.w,
      );
      renderer.setScissor(
        this.savedScissor.x,
        this.savedScissor.y,
        this.savedScissor.z,
        this.savedScissor.w,
      );
      renderer.setScissorTest(savedScissorTest);
      renderer.autoClear = savedAutoClear;
    }
  }
}
