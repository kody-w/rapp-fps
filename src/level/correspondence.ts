/**
 * The correspondence proof.
 *
 * #8 was blocked because its rendered rails were offset from the collision the
 * player hit, and a pipe-bank collider had no visible geometry at all. Both were
 * possible because collision was authored by hand, separately from the meshes.
 *
 * This module refuses to *assert* correspondence and instead *proves* it against
 * the real data: the merged `three` buffers that are uploaded to the GPU, and
 * the `StaticWorld` the motor collides against. It is pure and headless, so the
 * same proof runs at boot (Arena throws if it fails) and in CI via
 * `verify-correspondence.mjs`.
 *
 * What it proves:
 *   A. The world satisfies the core contract (`assertValidStaticWorld`).
 *   B. There is exactly one collision box per collidable solid.
 *   C. Each collision box matches its solid's bounds and surface (bijection).
 *   D. Each collision box is backed by rendered geometry with a vertex at all
 *      eight of its corners — so no collider is invisible and none is offset.
 */

import type { StaticWorld } from '../core/collision.js';
import { assertValidStaticWorld } from '../core/collision.js';
import type { ArenaDefinition } from './arena.js';
import { collidableSolids } from './staticWorld.js';
import { geometryCornerKeys, solidCornerKeys, type MergedGroup } from './geometry.js';

const EPS = 1e-4;

export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CorrespondenceReport {
  readonly ok: boolean;
  readonly results: readonly CheckResult[];
  readonly solidCount: number;
  readonly collidableCount: number;
  readonly boxCount: number;
  readonly renderVertexKeys: number;
}

function vecEq(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) < EPS;
}

export function checkCorrespondence(
  def: ArenaDefinition,
  world: StaticWorld,
  groups: readonly MergedGroup[],
): CorrespondenceReport {
  const results: CheckResult[] = [];
  const collidable = collidableSolids(def);

  // A. Core contract.
  let contractOk = true;
  let contractDetail = 'assertValidStaticWorld passed';
  try {
    assertValidStaticWorld(world);
  } catch (err) {
    contractOk = false;
    contractDetail = `assertValidStaticWorld threw: ${(err as Error).message}`;
  }
  results.push({ name: 'core-contract', ok: contractOk, detail: contractDetail });

  // B. One box per collidable solid.
  const countOk = world.boxes.length === collidable.length;
  results.push({
    name: 'box-count',
    ok: countOk,
    detail: `${world.boxes.length} boxes vs ${collidable.length} collidable solids`,
  });

  // C. Bijection: each collidable solid ↔ exactly one box (bounds + surface).
  const unmatchedBoxes = new Set(world.boxes.map((_, i) => i));
  const bijectionErrors: string[] = [];
  for (const solid of collidable) {
    const idx = world.boxes.findIndex(
      (b, i) => unmatchedBoxes.has(i)
        && vecEq(b.min, solid.min)
        && vecEq(b.max, solid.max)
        && b.material === solid.surface,
    );
    if (idx === -1) bijectionErrors.push(solid.id);
    else unmatchedBoxes.delete(idx);
  }
  for (const i of unmatchedBoxes) bijectionErrors.push(`box#${i}(no solid)`);
  results.push({
    name: 'bijection',
    ok: bijectionErrors.length === 0,
    detail: bijectionErrors.length === 0
      ? `${collidable.length} solids each matched one box on bounds + surface`
      : `unmatched: ${bijectionErrors.join(', ')}`,
  });

  // D. Every collider is backed by rendered geometry at all eight corners.
  const renderKeys = new Set<string>();
  for (const group of groups) {
    for (const key of geometryCornerKeys(group.geometry)) renderKeys.add(key);
  }
  const missing: string[] = [];
  for (const solid of collidable) {
    for (const key of solidCornerKeys(solid)) {
      if (!renderKeys.has(key)) {
        missing.push(`${solid.id}@${key}`);
        break;
      }
    }
  }
  results.push({
    name: 'render-backing',
    ok: missing.length === 0,
    detail: missing.length === 0
      ? `all ${collidable.length} colliders have rendered geometry at every corner`
      : `colliders with no matching render vertex: ${missing.join(', ')}`,
  });

  // Belt-and-braces: every collidable solid is actually present in a merged
  // render group (catches a solid dropped from rendering but kept in collision).
  const renderedIds = new Set<string>();
  for (const group of groups) for (const s of group.solids) renderedIds.add(s.id);
  const notRendered = collidable.filter((s) => !renderedIds.has(s.id)).map((s) => s.id);
  results.push({
    name: 'render-membership',
    ok: notRendered.length === 0,
    detail: notRendered.length === 0
      ? 'every collidable solid is in a rendered group'
      : `collidable but not rendered: ${notRendered.join(', ')}`,
  });

  return {
    ok: results.every((r) => r.ok),
    results,
    solidCount: def.solids.length,
    collidableCount: collidable.length,
    boxCount: world.boxes.length,
    renderVertexKeys: renderKeys.size,
  };
}

export function formatReport(report: CorrespondenceReport): string {
  const lines = report.results.map(
    (r) => `  [${r.ok ? 'PASS' : 'FAIL'}] ${r.name}: ${r.detail}`,
  );
  return [
    `correspondence: ${report.ok ? 'OK' : 'FAILED'}`,
    `  solids=${report.solidCount} collidable=${report.collidableCount} `
      + `boxes=${report.boxCount} renderVertexKeys=${report.renderVertexKeys}`,
    ...lines,
  ].join('\n');
}
