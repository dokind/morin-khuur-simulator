/**
 * Legato slides for listening: a slurred change of pitch on one string glides, and a wider
 * interval takes longer. Used by the performed styles (audio/song-events.ts); verification, the
 * acoustic pitch test and 'as-written' playback always use the notes as written. Every other
 * ornament comes from the style-aware planner in ./performance.
 */

export const EXPRESSION = {
  /** Legato slides: base time plus time per semitone, capped. */
  glideBase: 0.035,
  glidePerSemitone: 0.012,
  glideMax: 0.16
}

/** Glide time for a slurred (legato) change of pitch on the same string. */
export function legatoGlideSeconds(fromMidi: number, toMidi: number): number {
  return Math.min(EXPRESSION.glideMax, EXPRESSION.glideBase + EXPRESSION.glidePerSemitone * Math.abs(toMidi - fromMidi))
}
