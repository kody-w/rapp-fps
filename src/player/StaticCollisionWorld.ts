import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  INTERSECTED,
  MeshBVH,
  type ExtendedTriangle,
} from 'three-mesh-bvh';
import type { SurfaceKind } from '../core/contracts.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const COLLISION_EPSILON = 1e-5;
const MAX_RESOLVE_ITERATIONS = 4;

interface SurfaceRange {
  startTriangle: number;
  endTriangle: number;
  surface: SurfaceKind;
}

export interface CapsuleContact {
  normal: THREE.Vector3;
  depth: number;
  surface: SurfaceKind;
}

export interface CapsuleMoveOptions {
  height: number;
  radius: number;
  displacement: THREE.Vector3;
  wasGrounded: boolean;
  maxStepHeight: number;
  groundSnapDistance: number;
  minGroundNormalY: number;
}

export interface CapsuleMoveResult {
  position: THREE.Vector3;
  actualDisplacement: THREE.Vector3;
  contacts: CapsuleContact[];
  grounded: boolean;
  hitCeiling: boolean;
  hitWall: boolean;
  steppedHeight: number;
  surface: SurfaceKind;
}

interface ResolveResult {
  contacts: CapsuleContact[];
}

interface GroundProbe {
  height: number;
  contact: CapsuleContact;
}

export class StaticCollisionWorld {
  private readonly geometry: THREE.BufferGeometry | null;
  private readonly bvh: MeshBVH | null;
  private readonly surfaceRanges: SurfaceRange[];

  private readonly capsuleSegment = new THREE.Line3();
  private readonly capsuleBounds = new THREE.Box3();
  private readonly trianglePoint = new THREE.Vector3();
  private readonly capsulePoint = new THREE.Vector3();
  private readonly correctionDirection = new THREE.Vector3();
  private readonly capsuleCenter = new THREE.Vector3();
  private readonly groundProbeOrigin = new THREE.Vector3();
  private readonly groundProbeRay = new THREE.Ray(this.groundProbeOrigin, DOWN);

  private constructor(
    geometry: THREE.BufferGeometry | null,
    surfaceRanges: SurfaceRange[],
  ) {
    this.geometry = geometry;
    this.surfaceRanges = surfaceRanges;
    this.bvh = geometry
      ? new MeshBVH(geometry, {
        indirect: true,
        targetLeafSize: 8,
        setBoundingBox: true,
        verbose: false,
      })
      : null;
  }

  static fromScene(scene: THREE.Object3D): StaticCollisionWorld {
    scene.updateMatrixWorld(true);
    const geometries: THREE.BufferGeometry[] = [];
    const surfaceRanges: SurfaceRange[] = [];
    let triangleOffset = 0;

    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.playerCollision === false) return;

      const source = mesh.geometry;
      if (!source?.getAttribute('position')) return;

      const geometry = source.index ? source.toNonIndexed() : source.clone();
      geometry.applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== 'position') geometry.deleteAttribute(name);
      }
      geometry.clearGroups();

      const triangleCount = geometry.getAttribute('position').count / 3;
      const surface = isSurfaceKind(mesh.userData.surface)
        ? mesh.userData.surface
        : 'concrete';
      surfaceRanges.push({
        startTriangle: triangleOffset,
        endTriangle: triangleOffset + triangleCount,
        surface,
      });
      triangleOffset += triangleCount;
      geometries.push(geometry);
    });

    if (geometries.length === 0) return new StaticCollisionWorld(null, []);
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    return new StaticCollisionWorld(merged, surfaceRanges);
  }

  moveCapsule(
    position: THREE.Vector3,
    options: CapsuleMoveOptions,
  ): CapsuleMoveResult {
    const start = position.clone();
    const verticalStart = position.clone();
    const allContacts: CapsuleContact[] = [];

    verticalStart.y += options.displacement.y;
    allContacts.push(...this.resolveAt(
      verticalStart,
      options.height,
      options.radius,
    ).contacts);

    const horizontal = new THREE.Vector3(
      options.displacement.x,
      0,
      options.displacement.z,
    );
    const horizontalLength = horizontal.length();
    const direct = verticalStart.clone().add(horizontal);
    const directContacts = this.resolveAt(
      direct,
      options.height,
      options.radius,
    ).contacts;

    let chosen = direct;
    let chosenContacts = directContacts;
    let steppedHeight = 0;

    const directProgress = horizontalLength > 0
      ? horizontalProgress(verticalStart, direct, horizontal)
      : 1;

    if (options.wasGrounded
      && options.maxStepHeight > 0
      && horizontalLength > 1e-8
      && directProgress < horizontalLength * 0.8) {
      const stepped = this.tryStep(
        verticalStart,
        horizontal,
        options,
      );
      if (stepped) {
        const steppedProgress = horizontalProgress(verticalStart, stepped.position, horizontal);
        if (steppedProgress > directProgress + 1e-4) {
          chosen = stepped.position;
          chosenContacts = stepped.contacts;
          steppedHeight = Math.max(0, chosen.y - verticalStart.y);
        }
      }
    }

    allContacts.push(...chosenContacts);

    let grounded = hasWalkableContact(allContacts, options.minGroundNormalY);
    if (options.displacement.y <= 0 && options.groundSnapDistance > 0) {
      const snapped = chosen.clone();
      snapped.y -= options.groundSnapDistance;
      const snapContacts = this.resolveAt(
        snapped,
        options.height,
        options.radius,
      ).contacts;

      if (hasWalkableContact(snapContacts, options.minGroundNormalY)
        && snapped.y <= chosen.y + COLLISION_EPSILON) {
        chosen = snapped;
        allContacts.push(...snapContacts);
        grounded = true;
      }

      if (!grounded) {
        const probe = this.probeGround(
          chosen,
          options.radius,
          options.groundSnapDistance,
          options.minGroundNormalY,
        );
        if (probe) {
          const supported = chosen.clone();
          supported.y = probe.height;
          if (this.canFit(supported, options.height, options.radius)) {
            chosen = supported;
            allContacts.push(probe.contact);
            grounded = true;
          }
        }
      }
    }

    const hitCeiling = allContacts.some((contact) => contact.normal.y < -0.5);
    const hitWall = allContacts.some(
      (contact) => Math.abs(contact.normal.y) < options.minGroundNormalY,
    );
    const groundContact = allContacts
      .filter((contact) => contact.normal.y >= options.minGroundNormalY)
      .sort((a, b) => b.normal.y - a.normal.y)[0];

    return {
      position: chosen,
      actualDisplacement: chosen.clone().sub(start),
      contacts: allContacts,
      grounded,
      hitCeiling,
      hitWall,
      steppedHeight,
      surface: groundContact?.surface ?? 'concrete',
    };
  }

  canFit(position: THREE.Vector3, height: number, radius: number): boolean {
    if (!this.bvh) return true;
    this.setCapsule(position, height, radius);
    let overlaps = false;

    this.bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(this.capsuleBounds)
        ? INTERSECTED
        : false,
      intersectsTriangle: (triangle) => {
        if (triangle.closestPointToSegment(
          this.capsuleSegment,
          this.trianglePoint,
          this.capsulePoint,
        ) < radius - COLLISION_EPSILON) {
          overlaps = true;
          return true;
        }
        return false;
      },
    });

    return !overlaps;
  }

  dispose(): void {
    this.geometry?.dispose();
  }

  private tryStep(
    start: THREE.Vector3,
    horizontal: THREE.Vector3,
    options: CapsuleMoveOptions,
  ): { position: THREE.Vector3; contacts: CapsuleContact[] } | null {
    const raised = start.clone();
    raised.y += options.maxStepHeight + COLLISION_EPSILON;
    if (!this.canFit(raised, options.height, options.radius)) return null;

    raised.add(horizontal);
    const horizontalContacts = this.resolveAt(
      raised,
      options.height,
      options.radius,
    ).contacts;

    const direction = horizontal.clone().normalize();
    const probe = raised.clone().addScaledVector(direction, options.radius * 0.95);
    probe.y += 0.02;
    const hit = this.bvh?.raycastFirst(
      new THREE.Ray(probe, DOWN),
      THREE.DoubleSide,
      0,
      options.maxStepHeight + options.groundSnapDistance + 0.04,
    );
    if (!hit?.face) return null;

    const normal = hit.face.normal.clone();
    if (normal.y < 0) normal.negate();
    if (normal.y < options.minGroundNormalY) return null;

    const landingHeight = hit.point.y;
    if (landingHeight <= start.y + 0.02
      || landingHeight > start.y + options.maxStepHeight + COLLISION_EPSILON) {
      return null;
    }

    raised.y = landingHeight;
    if (!this.canFit(raised, options.height, options.radius)) return null;
    const downContacts: CapsuleContact[] = [{
      normal,
      depth: 0,
      surface: this.surfaceForTriangle(hit.faceIndex ?? -1),
    }];

    return {
      position: raised,
      contacts: [...horizontalContacts, ...downContacts],
    };
  }

  private resolveAt(
    position: THREE.Vector3,
    height: number,
    radius: number,
  ): ResolveResult {
    if (!this.bvh) return { contacts: [] };

    this.setCapsule(position, height, radius);
    const contacts: CapsuleContact[] = [];

    for (let iteration = 0; iteration < MAX_RESOLVE_ITERATIONS; iteration++) {
      let corrected = false;
      this.updateCapsuleBounds(radius);

      this.bvh.shapecast({
        intersectsBounds: (box) => box.intersectsBox(this.capsuleBounds)
          ? INTERSECTED
          : false,
        intersectsTriangle: (triangle, triangleIndex) => {
          const distance = triangle.closestPointToSegment(
            this.capsuleSegment,
            this.trianglePoint,
            this.capsulePoint,
          );
          if (distance >= radius - COLLISION_EPSILON) return false;

          this.contactDirection(triangle, distance);
          const depth = radius - distance;
          this.capsuleSegment.start.addScaledVector(this.correctionDirection, depth);
          this.capsuleSegment.end.addScaledVector(this.correctionDirection, depth);
          contacts.push({
            normal: this.correctionDirection.clone(),
            depth,
            surface: this.surfaceForTriangle(triangleIndex),
          });
          corrected = true;
          return false;
        },
      });

      if (!corrected) break;
    }

    position.copy(this.capsuleSegment.start);
    position.y -= radius;
    return { contacts };
  }

  private probeGround(
    position: THREE.Vector3,
    radius: number,
    distance: number,
    minGroundNormalY: number,
  ): GroundProbe | null {
    if (!this.bvh) return null;
    let best: GroundProbe | null = null;

    for (const [offsetX, offsetZ] of GROUND_PROBE_OFFSETS) {
      this.groundProbeOrigin.set(
        position.x + offsetX * radius,
        position.y + 0.03,
        position.z + offsetZ * radius,
      );
      const hit = this.bvh.raycastFirst(
        this.groundProbeRay,
        THREE.DoubleSide,
        0,
        distance + 0.06,
      );
      if (!hit?.face || hit.point.y > position.y + 0.031) continue;

      const normal = hit.face.normal.clone();
      if (normal.y < 0) normal.negate();
      if (normal.y < minGroundNormalY) continue;
      if (best && hit.point.y <= best.height) continue;

      best = {
        height: hit.point.y,
        contact: {
          normal,
          depth: 0,
          surface: this.surfaceForTriangle(hit.faceIndex ?? -1),
        },
      };
    }

    return best;
  }

  private setCapsule(position: THREE.Vector3, height: number, radius: number): void {
    this.capsuleSegment.start.set(position.x, position.y + radius, position.z);
    this.capsuleSegment.end.set(
      position.x,
      position.y + Math.max(radius, height - radius),
      position.z,
    );
    this.updateCapsuleBounds(radius);
  }

  private updateCapsuleBounds(radius: number): void {
    this.capsuleBounds.makeEmpty();
    this.capsuleBounds.expandByPoint(this.capsuleSegment.start);
    this.capsuleBounds.expandByPoint(this.capsuleSegment.end);
    this.capsuleBounds.min.addScalar(-radius);
    this.capsuleBounds.max.addScalar(radius);
  }

  private contactDirection(triangle: ExtendedTriangle, distance: number): void {
    if (distance > 1e-8) {
      this.correctionDirection
        .subVectors(this.capsulePoint, this.trianglePoint)
        .multiplyScalar(1 / distance);
      return;
    }

    triangle.getNormal(this.correctionDirection);
    this.capsuleCenter
      .addVectors(this.capsuleSegment.start, this.capsuleSegment.end)
      .multiplyScalar(0.5)
      .sub(this.trianglePoint);
    if (this.correctionDirection.dot(this.capsuleCenter) < 0) {
      this.correctionDirection.negate();
    }
  }

  private surfaceForTriangle(triangleIndex: number): SurfaceKind {
    for (const range of this.surfaceRanges) {
      if (triangleIndex >= range.startTriangle && triangleIndex < range.endTriangle) {
        return range.surface;
      }
    }
    return 'concrete';
  }
}

const GROUND_PROBE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.85, 0],
  [-0.85, 0],
  [0, 0.85],
  [0, -0.85],
];

function hasWalkableContact(contacts: CapsuleContact[], minNormalY: number): boolean {
  return contacts.some((contact) => contact.normal.y >= minNormalY);
}

function horizontalProgress(
  start: THREE.Vector3,
  end: THREE.Vector3,
  desired: THREE.Vector3,
): number {
  const desiredLength = desired.length();
  if (desiredLength <= 1e-8) return 0;
  return ((end.x - start.x) * desired.x + (end.z - start.z) * desired.z)
    / desiredLength;
}

function isSurfaceKind(value: unknown): value is SurfaceKind {
  return value === 'concrete'
    || value === 'metal'
    || value === 'wood'
    || value === 'sand'
    || value === 'glass'
    || value === 'flesh'
    || value === 'foliage'
    || value === 'water'
    || value === 'dirt'
    || value === 'fabric';
}
