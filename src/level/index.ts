/**
 * Public surface of the level subsystem.
 *
 * The boot path mounts `ArenaLevel` after `RenderSystem`. Everything else is
 * exported for the correspondence proof, a future player/AI motor (which needs
 * the `StaticWorld` and spawns), and tests.
 */

export { ArenaLevel } from './ArenaLevel.js';
export { buildArena } from './arena.js';
export type {
  ArenaDefinition,
  Solid,
  LightSpec,
  ShotSpec,
  MaterialKey,
  SurfaceMaterial,
  Vec3,
} from './arena.js';
export { buildStaticWorld, collidableSolids } from './staticWorld.js';
export { mergeSolidsByMaterial, type MergedGroup } from './geometry.js';
export { createArenaMaterials, type ArenaMaterials } from './materials.js';
export {
  checkCorrespondence,
  formatReport,
  type CorrespondenceReport,
  type CheckResult,
} from './correspondence.js';
