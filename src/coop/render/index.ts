/**
 * Self-contained horizontal split-screen render library. — Refs #71
 *
 * A pure viewport/scissor planner ({@link planCoopViewports}, {@link checkExactTiling})
 * plus a stateless coordinator ({@link CoopRenderCoordinator}) that draws one
 * shared scene through one or two cameras and restores all renderer/camera state
 * it touched. Nothing here reads input, steps simulation, or mutates a shared
 * engine file; it is meant to be composed by an integration layer, not to be
 * that layer. See ./README.md for the integration seam and the measured perf.
 */

export {
  planCoopViewports,
  checkExactTiling,
  type CoopPlayerCount,
  type CoopSlotRole,
  type PixelRect,
  type CoopSlot,
  type CoopViewportInput,
  type CoopViewportPlan,
  type RenderableCoopPlan,
  type RefusedCoopPlan,
  type TilingReport,
} from './viewport.js';

export {
  CoopRenderCoordinator,
  type CoopRendererLike,
  type CoopRenderOptions,
  type CoopRenderResult,
} from './coordinator.js';
