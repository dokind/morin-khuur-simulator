/**
 * Deterministic random draws for performance plans (plan F3): every decision about a note is
 * seeded from the song title, the note's index and what is being decided, so the same song always
 * gets the same ornaments and renders can be regression-compared. Separate streams per decision
 * keep one rule's draws from shifting another's when a preset changes.
 */

/** FNV-1a, 32 bit. */
export function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a small 32-bit generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number
  uniform(lo: number, hi: number): number
  /** True with probability `p` (clamped to 0–1). */
  chance(p: number): boolean
  /** Standard normal (Box–Muller). */
  gaussian(): number
  /** Unsigned 32-bit integer, e.g. to seed another generator. */
  int(): number
}

export function makeRng(seed: number): Rng {
  const next = mulberry32(seed)
  return {
    next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    chance: (p) => next() < Math.min(1, Math.max(0, p)),
    gaussian: () => {
      const u = 1 - next()
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next())
    },
    int: () => Math.floor(next() * 4294967296) >>> 0
  }
}

/**
 * The generator for one decision (`purpose`) about one note: mulberry32 seeded from
 * hash(title) ^ noteIndex, with the index spread by the golden-ratio constant and the purpose mixed in.
 */
export function noteRng(title: string, noteIndex: number, purpose: string): Rng {
  return makeRng(hashString(title) ^ Math.imul(noteIndex + 1, 0x9e3779b1) ^ hashString(purpose))
}
