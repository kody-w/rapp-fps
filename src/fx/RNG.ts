let seed = 12345;
export function setSeed(s: number) { seed = s; }
export function random() {
  seed = (seed * 1664525 + 1013904223) | 0;
  return (seed >>> 0) / 4294967296;
}
