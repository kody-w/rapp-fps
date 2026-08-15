/**
 * Public surface of the level subsystem.
 *
 * The boot path mounts `ArenaLevel` after `RenderSystem`. Everything else is
 * exported for the correspondence proof, a future player/AI motor (which needs
 * the `StaticWorld` and spawns), and tests.
 */

export { ArenaLevel, type ArenaLevelOptions } from './ArenaLevel.js';
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
export { createArenaMaterials, type ArenaMaterials, type ArenaMaterialsOptions, CONTAINER_RIB_FREQUENCY, containerRibHeight } from './materials.js';
export {
  selectGroundContactSolids,
  describeGroundContact,
  classifyGroundContact,
  createContactShadowLayer,
  CONTACT_SHADOW_DEFAULTS,
  type ContactShadowLayer,
  type ContactShadowOptions,
  type ContactInstance,
  type ContactEligibility,
} from './contactShadows.js';
export {
  selectContainerSolids,
  describeContainerDressing,
  classifyContainerDressing,
  describeContainerAssembly,
  describeContainerAssemblies,
  createContainerDressingLayer,
  MAX_DRESSING_TRIANGLES,
  MAX_DRESSING_PROTRUSION,
  type ContainerDressingLayer,
  type ContainerAssembly,
  type DressingPart,
  type DressingEligibility,
} from './containerDressing.js';
export {
  checkCorrespondence,
  formatReport,
  type CorrespondenceReport,
  type CheckResult,
} from './correspondence.js';
