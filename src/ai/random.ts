/**
 * Deterministic pseudo-random source (mulberry32).
 *
 * Every stochastic decision the enemy makes — aim scatter, cover tie-breaks,
 * where it wanders while searching — draws from one of these. It has to be
 * deterministic and portable: the same seed and the same sequence of draws
 * produce byte-identical numbers in a browser and in a Node fixture, which is
 * the whole basis of the determinism evidence. `Math.random` cannot be
 * evidenced and is banned from the AI core for that reason.
 *
 * mulberry32 is a 32-bit state generator: cheap, no allocation, and good enough
 * for gameplay jitter (it is not, and is not used as, a cryptographic source).
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // A zero seed collapses the generator; fall back to a fixed odd constant.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /**
   * Approximately standard-normal sample (mean 0, unit variance) by summing
   * four uniforms. Used for aim scatter: a bell curve reads as "human wobble",
   * whereas a flat uniform reads as "randomly teleporting reticle".
   */
  gaussian(): number {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += this.next();
    // Mean of 4 uniforms is 2 with variance 4/12; rescale to ~unit variance.
    return (sum - 2) * Math.sqrt(3);
  }
}
