/**
 * Renderer-free procedural geometry for the DUSKLINE A7 first-person viewmodel.
 *
 * This module owns the *art*: it builds finished, chamfered, functionally
 * detailed rifle geometry as plain BufferGeometry and merges it into exactly
 * three material groups (metal / polymer / accent) so the rifle stays at three
 * draw calls. It never touches THREE.Material, the renderer, or per-frame state,
 * which makes it unit-testable in Node against the muzzle / ejection anchors.
 *
 * Design intent (original, not modelled on any real firearm):
 *   - Every primary silhouette form (upper/lower receiver, handguard, stock,
 *     cheek riser, butt pad, pistol grip, magazine) is a RoundedBoxGeometry, so
 *     the blockout's hard 90 degree edges are gone and lighting produces edge
 *     highlights on the chamfers.
 *   - A layered rear aperture housing with protective wings replaces the raw
 *     torus; a front post between two ears sits on a gas-block base. Both sight
 *     features are centred on x=0 at the same local height so the ADS sight
 *     picture is preserved exactly.
 *   - Functional cues readable in first person: upper/lower receiver seam, a
 *     stepped muzzle device with a barrel collar, handguard vents and ribs, a
 *     trigger guard, an ejection-port recess with brass deflector, a charging
 *     handle, a selector, fasteners, magazine segmentation and a floor plate.
 *   - Material hierarchy comes from baked vertex colours: a per-part tint plus a
 *     subtle hemisphere term (up faces lighter, down faces darker). No textures,
 *     no random confetti.
 *
 * The muzzle and ejection anchors are the single source of truth shared with the
 * viewmodel and the anchor fixture; the geometry is authored so those points sit
 * on / inside the barrel crown and the ejection port respectively.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type MaterialGroup = 'metal' | 'polymer' | 'accent';

/** World-forward is -Z. Barrel and sight lines are held on x=0. */
const BARREL_Y = 0.022;
const SIGHT_Y = 0.104;

/** Front crown of the muzzle device; the muzzle anchor sits on this face. */
export const MUZZLE_ANCHOR = new THREE.Vector3(0, 0.018, -0.91);
/** Ejection-port mouth on the right of the upper receiver. */
export const EJECTION_ANCHOR = new THREE.Vector3(0.073, 0.025, -0.13);

export interface RifleGeometrySet {
  readonly metal: THREE.BufferGeometry;
  readonly polymer: THREE.BufferGeometry;
  readonly accent: THREE.BufferGeometry;
  readonly triangleCount: number;
}

type Vec3 = [number, number, number];

interface PaintOptions {
  /** Ambient floor before the hemisphere term is applied. */
  readonly base?: number;
  /** Hemisphere strength: how much an up/down normal brightens/darkens. */
  readonly hemi?: number;
}

/** Compose a TRS transform in-place on a geometry. */
function place(
  geometry: THREE.BufferGeometry,
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(1, 1, 1),
  );
  geometry.applyMatrix4(matrix);
  return geometry;
}

/** A chamfered primary form. */
function rbox(
  width: number, height: number, depth: number,
  radius = 0.008, segments = 2,
): THREE.BufferGeometry {
  const safeRadius = Math.min(radius, width / 2 - 1e-4, height / 2 - 1e-4, depth / 2 - 1e-4);
  return new RoundedBoxGeometry(width, height, depth, segments, Math.max(1e-3, safeRadius));
}

/** A cylinder whose axis runs along local Z (barrel / muzzle direction). */
function cylZ(
  radiusTop: number, radiusBottom: number, length: number, radial = 20,
): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, radial, 1);
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

/** A small greeble box; bevel would be invisible at this scale, so keep it cheap. */
function greeble(width: number, height: number, depth: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(width, height, depth);
}

/**
 * Bake a per-part tint and a hemisphere shade into a colour attribute. The tint
 * multiplies the material base colour, giving sub-material hierarchy inside a
 * single draw; the hemisphere term lifts up-facing surfaces and drops
 * down-facing ones so chamfers and cylinders read as form, not flat mass.
 */
function paint(
  geometry: THREE.BufferGeometry,
  tint: Vec3,
  options: PaintOptions = {},
): THREE.BufferGeometry {
  const base = options.base ?? 0.9;
  const hemi = options.hemi ?? 0.14;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const ny = normal ? normal.getY(i) : 0;
    const shade = THREE.MathUtils.clamp(base + hemi * ny, 0, 2);
    colors[i * 3 + 0] = tint[0] * shade;
    colors[i * 3 + 1] = tint[1] * shade;
    colors[i * 3 + 2] = tint[2] * shade;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Reduce any geometry to a mergeable {position, normal, color} non-indexed form. */
function normalize(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  let geo = geometry;
  if (geo.index) {
    const expanded = geo.toNonIndexed();
    geo.dispose();
    geo = expanded;
  }
  for (const key of Object.keys(geo.attributes)) {
    if (key !== 'position' && key !== 'normal' && key !== 'color') geo.deleteAttribute(key);
  }
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  return geo;
}

class GroupBuilder {
  readonly metal: THREE.BufferGeometry[] = [];
  readonly polymer: THREE.BufferGeometry[] = [];
  readonly accent: THREE.BufferGeometry[] = [];

  add(
    group: MaterialGroup,
    geometry: THREE.BufferGeometry,
    tint: Vec3,
    options: PaintOptions = {},
  ): void {
    const painted = paint(normalize(geometry), tint, options);
    this[group].push(painted);
  }
}

const TINT = {
  upper: [1.05, 1.06, 1.10] as Vec3,
  lower: [0.82, 0.83, 0.87] as Vec3,
  barrel: [0.9, 0.91, 0.94] as Vec3,
  rail: [1.12, 1.13, 1.17] as Vec3,
  muzzle: [0.76, 0.77, 0.81] as Vec3,
  sightMetal: [0.96, 0.97, 1.02] as Vec3,
  hardware: [1.0, 1.01, 1.06] as Vec3,
  handguard: [1.03, 1.04, 1.0] as Vec3,
  handguardRib: [0.72, 0.73, 0.71] as Vec3,
  stock: [0.92, 0.94, 0.91] as Vec3,
  grip: [0.85, 0.87, 0.85] as Vec3,
  gripPanel: [0.66, 0.68, 0.66] as Vec3,
  magazine: [0.8, 0.82, 0.8] as Vec3,
  magazineRib: [0.66, 0.68, 0.66] as Vec3,
  buttpad: [0.6, 0.62, 0.6] as Vec3,
  bronze: [1.02, 1.0, 0.96] as Vec3,
  bronzeDark: [0.82, 0.8, 0.77] as Vec3,
};

// ── Barrel, gas block and muzzle device ─────────────────────────────────────
function buildBarrelAndMuzzle(b: GroupBuilder): void {
  // Exposed barrel forward of the handguard.
  b.add('metal', place(cylZ(0.0155, 0.0165, 0.26, 20), 0, BARREL_Y, -0.66), TINT.barrel);
  // Barrel collar / gas block where the front sight is anchored.
  b.add('metal', place(rbox(0.05, 0.052, 0.06, 0.01, 2), 0, BARREL_Y + 0.006, -0.585), TINT.muzzle);
  // Stepped muzzle device: knurled collar, main body, chamfered crown.
  b.add('metal', place(cylZ(0.021, 0.021, 0.03, 18), 0, BARREL_Y, -0.815), TINT.muzzle);
  b.add('metal', place(cylZ(0.023, 0.022, 0.06, 18), 0, BARREL_Y, -0.86), TINT.muzzle);
  b.add('metal', place(cylZ(0.017, 0.023, 0.022, 18), 0, BARREL_Y, -0.901), TINT.muzzle);
  // Compensator ports cut into the top of the muzzle body.
  for (let i = 0; i < 3; i++) {
    b.add('metal', place(greeble(0.03, 0.012, 0.006), 0, BARREL_Y + 0.016, -0.85 + i * 0.016), TINT.hardware, { hemi: 0.05, base: 0.6 });
  }
}

// ── Upper and lower receiver, ejection port, charging handle ─────────────────
function buildReceiver(b: GroupBuilder): void {
  // Upper receiver.
  b.add('metal', place(rbox(0.112, 0.06, 0.30, 0.011, 2), 0, 0.04, -0.095), TINT.upper);
  // Lower receiver, narrower and dropped so the seam reads.
  b.add('metal', place(rbox(0.094, 0.05, 0.24, 0.011, 2), 0, -0.012, -0.08), TINT.lower);
  // Magazine-well housing forming the front of the lower receiver.
  b.add('metal', place(rbox(0.074, 0.06, 0.08, 0.01, 1), 0, -0.028, -0.15), TINT.lower);

  // Flat-top rail spanning receiver and handguard.
  b.add('metal', place(rbox(0.05, 0.016, 0.63, 0.004, 1), 0, 0.077, -0.245), TINT.rail);
  // Rail slots.
  for (let i = 0; i < 12; i++) {
    b.add('metal', place(greeble(0.052, 0.007, 0.006), 0, 0.086, -0.545 + i * 0.052), TINT.hardware, { hemi: 0.04, base: 0.55 });
  }

  // Ejection-port recess, framing lip and brass deflector (shared with the proof).
  addEjectionPort(b);
  // Forward assist / port fastener.
  b.add('accent', place(cylZ(0.006, 0.006, 0.014, 12), 0.06, 0.006, -0.06), TINT.bronze);

  // Charging handle across the rear top of the upper receiver.
  b.add('metal', place(rbox(0.03, 0.02, 0.05, 0.006, 1), 0.02, 0.052, -0.01), TINT.hardware);
  b.add('metal', place(greeble(0.05, 0.012, 0.016), 0.0, 0.052, -0.006), TINT.hardware);

  // Take-down pins.
  b.add('accent', place(cylZ(0.007, 0.007, 0.014, 12), 0.05, -0.008, -0.05), TINT.bronzeDark);
  b.add('accent', place(cylZ(0.007, 0.007, 0.014, 12), 0.05, -0.008, 0.0), TINT.bronzeDark);
}

// ── Ejection port (shared by the receiver and the anchor proof) ──────────────
function addEjectionPort(b: GroupBuilder): void {
  // Darkened pocket recessed into the receiver flank.
  b.add('metal', place(greeble(0.02, 0.034, 0.10), 0.05, 0.03, -0.13), TINT.hardware, { hemi: 0.03, base: 0.45 });
  // Raised framing lip around the port mouth; its outer face reaches the anchor.
  b.add('metal', place(rbox(0.02, 0.05, 0.12, 0.004, 1), 0.062, 0.03, -0.13), TINT.upper);
  // Brass deflector bump at the rear-top of the port.
  b.add('metal', place(rbox(0.022, 0.03, 0.032, 0.008, 1), 0.064, 0.03, -0.086), TINT.sightMetal);
}

// ── Handguard with vents and side ribs ──────────────────────────────────────
function buildHandguard(b: GroupBuilder): void {
  b.add('polymer', place(rbox(0.07, 0.072, 0.31, 0.014, 2), 0, BARREL_Y - 0.006, -0.40), TINT.handguard);
  // Side cooling ports.
  for (let side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      b.add('polymer', place(cylZ(0.009, 0.009, 0.012, 12).rotateY(Math.PI / 2), side * 0.036, BARREL_Y, -0.32 - i * 0.07), TINT.handguardRib, { hemi: 0.04, base: 0.5 });
    }
  }
  // Longitudinal grip ribs along the lower flanks.
  for (let side of [-1, 1]) {
    b.add('polymer', place(rbox(0.008, 0.03, 0.26, 0.003, 1), side * 0.038, BARREL_Y - 0.02, -0.40, 0, 0, 0), TINT.handguardRib);
  }
  // Bottom accessory rib.
  b.add('polymer', place(rbox(0.03, 0.01, 0.24, 0.003, 1), 0, BARREL_Y - 0.04, -0.40), TINT.handguardRib);
  // Handguard cap where it meets the receiver.
  b.add('metal', place(rbox(0.076, 0.078, 0.03, 0.012, 1), 0, BARREL_Y - 0.006, -0.245), TINT.barrel);
}

// ── Layered rear aperture and front post ────────────────────────────────────
function buildSights(b: GroupBuilder): void {
  // Rear aperture housing: a chamfered tower on the rail.
  b.add('metal', place(rbox(0.032, 0.03, 0.03, 0.006, 2), 0, SIGHT_Y - 0.012, 0.055), TINT.sightMetal);
  // Protective wings on either side of the aperture.
  b.add('metal', place(rbox(0.006, 0.026, 0.016, 0.002, 1), -0.017, SIGHT_Y + 0.004, 0.055), TINT.sightMetal);
  b.add('metal', place(rbox(0.006, 0.026, 0.016, 0.002, 1), 0.017, SIGHT_Y + 0.004, 0.055), TINT.sightMetal);
  // Aperture ring recessed between the wings; bronze so the peep reads in ADS.
  b.add('accent', place(new THREE.TorusGeometry(0.011, 0.0035, 8, 16), 0, SIGHT_Y + 0.004, 0.05), TINT.bronze);
  // Dark peep backing so the hole reads as an aperture, not a bright disc.
  b.add('metal', place(cylZ(0.008, 0.008, 0.006, 14), 0, SIGHT_Y + 0.004, 0.062), TINT.hardware, { hemi: 0.02, base: 0.35 });

  // Front sight base on the gas block.
  b.add('metal', place(rbox(0.03, 0.03, 0.03, 0.006, 1), 0, SIGHT_Y - 0.02, -0.57), TINT.sightMetal);
  // Front post.
  b.add('metal', place(greeble(0.006, 0.05, 0.006), 0, SIGHT_Y - 0.004, -0.57), TINT.hardware);
  b.add('accent', place(greeble(0.007, 0.008, 0.007), 0, SIGHT_Y + 0.018, -0.57), TINT.bronze);
  // Front protective ears.
  b.add('metal', place(rbox(0.005, 0.05, 0.008, 0.002, 1), -0.017, SIGHT_Y - 0.002, -0.57), TINT.sightMetal);
  b.add('metal', place(rbox(0.005, 0.05, 0.008, 0.002, 1), 0.017, SIGHT_Y - 0.002, -0.57), TINT.sightMetal);
}

// ── Stock, cheek riser and butt pad ─────────────────────────────────────────
function buildStock(b: GroupBuilder): void {
  // Stock neck bridging receiver to butt.
  b.add('polymer', place(rbox(0.05, 0.055, 0.1, 0.012, 2), 0, 0.012, 0.095), TINT.stock);
  // Main stock body.
  b.add('polymer', place(rbox(0.07, 0.085, 0.13, 0.016, 2), 0, 0.0, 0.145), TINT.stock);
  // Cheek riser.
  b.add('polymer', place(rbox(0.055, 0.03, 0.12, 0.012, 1), 0, 0.06, 0.125), TINT.stock);
  // Rubber butt pad.
  b.add('polymer', place(rbox(0.072, 0.11, 0.028, 0.014, 2), 0, -0.005, 0.195), TINT.buttpad, { hemi: 0.16, base: 0.82 });
  // Pad ridges.
  for (let i = 0; i < 3; i++) {
    b.add('polymer', place(greeble(0.06, 0.008, 0.006), 0, 0.03 - i * 0.03, 0.205), TINT.magazineRib, { hemi: 0.04, base: 0.5 });
  }
  // Sling loop.
  b.add('accent', place(new THREE.TorusGeometry(0.01, 0.003, 6, 12), 0.03, -0.02, 0.16, 0, Math.PI / 2, 0), TINT.bronzeDark);
}

// ── Pistol grip with finger grooves ─────────────────────────────────────────
function buildGrip(b: GroupBuilder): void {
  const tilt = -0.34;
  b.add('polymer', place(rbox(0.05, 0.14, 0.06, 0.014, 2), 0, -0.1, -0.02, tilt, 0, 0), TINT.grip);
  // Grip texture panels on both faces.
  b.add('polymer', place(rbox(0.036, 0.09, 0.01, 0.004, 1), 0, -0.1, 0.012, tilt, 0, 0), TINT.gripPanel);
  b.add('polymer', place(rbox(0.036, 0.09, 0.01, 0.004, 1), 0, -0.1, -0.052, tilt, 0, 0), TINT.gripPanel);
  // Grip cap.
  b.add('polymer', place(rbox(0.05, 0.02, 0.06, 0.012, 1), 0.005, -0.168, -0.03, tilt, 0, 0), TINT.grip);
}

// ── Trigger guard and trigger ───────────────────────────────────────────────
function buildTrigger(b: GroupBuilder): void {
  // Trigger guard loop: a partial torus lying in the vertical-longitudinal plane.
  const guard = new THREE.TorusGeometry(0.03, 0.006, 8, 20, Math.PI * 1.15);
  guard.rotateY(Math.PI / 2);
  b.add('metal', place(guard, 0, -0.03, -0.085, 0, 0, -0.35), TINT.hardware);
  // Trigger blade.
  b.add('accent', place(greeble(0.008, 0.028, 0.01), 0, -0.03, -0.09), TINT.bronzeDark);
  // Selector switch on the left of the lower receiver.
  b.add('accent', place(cylZ(0.008, 0.008, 0.02, 12).rotateY(Math.PI / 2), -0.05, 0.0, -0.05), TINT.bronze);
  b.add('accent', place(greeble(0.024, 0.008, 0.01), -0.06, 0.0, -0.05), TINT.bronze);
  // Magazine release button.
  b.add('accent', place(cylZ(0.007, 0.007, 0.012, 12).rotateY(Math.PI / 2), 0.05, -0.02, -0.13), TINT.bronze);
}

// ── Segmented magazine ──────────────────────────────────────────────────────
function buildMagazine(b: GroupBuilder): void {
  // Two angled body segments suggest a gently curved magazine.
  b.add('polymer', place(rbox(0.05, 0.11, 0.066, 0.01, 2), 0, -0.1, -0.15, 0.06, 0, 0), TINT.magazine);
  b.add('polymer', place(rbox(0.05, 0.10, 0.062, 0.01, 2), 0.0, -0.16, -0.135, 0.14, 0, 0), TINT.magazine);
  // Segmentation / witness ribs.
  for (let i = 0; i < 5; i++) {
    const t = i / 4;
    b.add('polymer', place(greeble(0.054, 0.006, 0.05), 0, -0.08 - t * 0.10, -0.152 + t * 0.02), TINT.magazineRib, { hemi: 0.05, base: 0.5 });
  }
  // Floor plate.
  b.add('polymer', place(rbox(0.056, 0.02, 0.07, 0.008, 1), 0, -0.216, -0.117), TINT.grip);
  b.add('accent', place(greeble(0.05, 0.006, 0.05), 0, -0.227, -0.117), TINT.bronzeDark);
}

function collect(builder: GroupBuilder): RifleGeometrySet {
  const mergeGroup = (parts: THREE.BufferGeometry[], name: string): THREE.BufferGeometry => {
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) throw new Error(`Could not merge DUSKLINE ${name} geometry.`);
    merged.computeBoundingSphere();
    return merged;
  };
  const metal = mergeGroup(builder.metal, 'metal');
  const polymer = mergeGroup(builder.polymer, 'polymer');
  const accent = mergeGroup(builder.accent, 'accent');
  const triangleCount = [metal, polymer, accent].reduce((sum, geometry) => {
    const position = geometry.getAttribute('position');
    return sum + (geometry.index ? geometry.index.count : position.count) / 3;
  }, 0);
  return { metal, polymer, accent, triangleCount };
}

/**
 * Build the three merged material-group geometries for the rifle. Each is a
 * single BufferGeometry with a baked vertex-colour attribute, ready to be wrapped
 * in one Mesh so the whole rifle renders in three draw calls.
 */
export function buildDusklineRifle(): RifleGeometrySet {
  const builder = new GroupBuilder();
  buildBarrelAndMuzzle(builder);
  buildReceiver(builder);
  buildHandguard(builder);
  buildSights(builder);
  buildStock(builder);
  buildGrip(builder);
  buildTrigger(builder);
  buildMagazine(builder);
  return collect(builder);
}

/**
 * The barrel + muzzle-device cluster, un-merged, for the anchor fixture. This is
 * the exact geometry the rifle ships (buildBarrelAndMuzzle above), so proving the
 * muzzle anchor sits on it proves it for the shipped weapon.
 */
export function buildMuzzleClusterForProof(): THREE.BufferGeometry {
  const builder = new GroupBuilder();
  buildBarrelAndMuzzle(builder);
  const merged = mergeGeometries(builder.metal, false);
  for (const part of builder.metal) part.dispose();
  if (!merged) throw new Error('Could not merge DUSKLINE muzzle cluster.');
  return merged;
}

/** The ejection-port cluster, un-merged, for the anchor fixture. */
export function buildEjectionClusterForProof(): THREE.BufferGeometry {
  const builder = new GroupBuilder();
  addEjectionPort(builder);
  const merged = mergeGeometries(builder.metal, false);
  for (const part of builder.metal) part.dispose();
  if (!merged) throw new Error('Could not merge DUSKLINE ejection cluster.');
  return merged;
}
