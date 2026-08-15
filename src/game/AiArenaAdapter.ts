import type { StaticWorld as CoreStaticWorld } from '../core/collision.js';
import type { ArenaDefinition, Solid } from '../level/arena.js';
import type {
  Arena as AiArena,
  ArenaCover,
} from '../ai/world.js';
import type {
  StaticBox as AiStaticBox,
  Vec3 as AiVec3,
} from '../ai/types.js';

export interface AiArenaBinding {
  arena: AiArena;
  spawn: AiVec3;
  yaw: number;
}

/**
 * Adapt the canonical level definition/world into the renderer-free AI shape.
 * The adapter validates declaration order and authored cover ids rather than
 * inventing a second collision world or guessing cover from dimensions.
 */
export function createAiArenaBinding(
  definition: ArenaDefinition,
  world: CoreStaticWorld,
): AiArenaBinding {
  const collidable = definition.solids.filter((solid) => solid.collide);
  if (collidable.length !== world.boxes.length) {
    throw new Error(
      `AI arena: ${collidable.length} collidable solids != ${world.boxes.length} world boxes`,
    );
  }

  const aiBoxes = collidable.map((solid, index) => adaptBox(solid, world, index));
  const byId = new Map(aiBoxes.map((box) => [box.id, box]));
  const cover: ArenaCover[] = definition.enemyCoverIds.map((id) => {
    const box = byId.get(id);
    if (!box) throw new Error(`AI arena: cover id "${id}" is absent or non-collidable`);
    return {
      id,
      center: {
        x: (box.min.x + box.max.x) * 0.5,
        y: (box.min.y + box.max.y) * 0.5,
        z: (box.min.z + box.max.z) * 0.5,
      },
      half: {
        x: (box.max.x - box.min.x) * 0.5,
        y: (box.max.y - box.min.y) * 0.5,
        z: (box.max.z - box.min.z) * 0.5,
      },
    };
  });
  if (cover.length < 2) {
    throw new Error('AI arena: at least two authored cover choices are required');
  }

  const [px, , pz] = definition.playerSpawn;
  const [ex, ey, ez] = definition.enemySpawn;
  const yaw = Math.atan2(px - ex, -(pz - ez));
  const halfExtent = Math.max(
    Math.abs(world.bounds.min[0]),
    Math.abs(world.bounds.max[0]),
    Math.abs(world.bounds.min[2]),
    Math.abs(world.bounds.max[2]),
  );
  return {
    arena: { world: { boxes: aiBoxes }, cover, halfExtent },
    spawn: { x: ex, y: ey, z: ez },
    yaw,
  };
}

function adaptBox(
  solid: Solid,
  world: CoreStaticWorld,
  index: number,
): AiStaticBox {
  const box = world.boxes[index];
  for (let axis = 0; axis < 3; axis++) {
    if (solid.min[axis] !== box.min[axis] || solid.max[axis] !== box.max[axis]) {
      throw new Error(`AI arena: solid/world order diverged at "${solid.id}" axis ${axis}`);
    }
  }
  return {
    id: solid.id,
    min: { x: box.min[0], y: box.min[1], z: box.min[2] },
    max: { x: box.max[0], y: box.max[1], z: box.max[2] },
  };
}
