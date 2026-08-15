import type { MutableVec3, Vec3Like } from './types.js';

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function copyVec3(out: MutableVec3, value: Vec3Like): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

export function setVec3(out: MutableVec3, x: number, y: number, z: number): void {
  out.x = x;
  out.y = y;
  out.z = z;
}

export function distanceSquared(a: Vec3Like, b: Vec3Like): number {
  const x = b.x - a.x;
  const y = b.y - a.y;
  const z = b.z - a.z;
  return x * x + y * y + z * z;
}

export function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.sqrt(distanceSquared(a, b));
}

export function normalizeHorizontal(out: MutableVec3, value: Vec3Like): void {
  const length = Math.hypot(value.x, value.z);
  if (length <= 1e-9) {
    setVec3(out, 0, 0, 1);
    return;
  }
  setVec3(out, value.x / length, 0, value.z / length);
}

export function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
