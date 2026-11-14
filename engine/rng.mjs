// Small seeded random helpers, so every simulation and test run is repeatable.

/** mulberry32: a 32-bit seeded generator returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator for one named stream, so adding a new use never shifts the others. */
export function stream(seed, name) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return mulberry32(h >>> 0);
}

/** Standard normal via Box-Muller. */
export const normal = (rnd) => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());

export const uniform = (rnd, lo, hi) => lo + (hi - lo) * rnd();

export function shuffle(rnd, items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
