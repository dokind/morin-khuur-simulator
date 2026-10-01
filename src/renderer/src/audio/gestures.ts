import { bowTimbre, VIBRATO_HZ, type BowedVoice } from './bowed-voice'
import type { WhinnyVariant } from './song-events'

export type { WhinnyVariant } from './song-events'

/**
 * Horse whinny (moriin insee): a fast fingernail slide up an octave and a fourth with flutter
 * tremolo, then a stepped, neighing descent. Scripted on the voice's raw automation.
 */
export function whinnyGesture(v: BowedVoice, time: number, startFreq: number, duration = 1, variant: WhinnyVariant = 'khalkh'): void {
  if (variant === 'inner-mongolian') return shakingWhinny(v, time, startFreq, duration)
  const t = time
  const len = Math.max(0.6, duration)
  const peakFreq = startFreq * 2 ** (17 / 12)
  v.prepareGesture(t, bowTimbre({ speed: 0.9, pressure: 0.65, position: 0.35 }))
  v.setTremolo(0.75, 15, t)
  v.setVibrato(45, 7, t)

  const f = v.frequency
  f.setValueAtTime(startFreq, t)
  f.exponentialRampToValueAtTime(peakFreq, t + len * 0.22)
  const env = v.envelope
  env.setTargetAtTime(0.9, t, 0.015)
  const neighs = 5
  for (let i = 0; i < neighs; i++) {
    const tt = t + len * (0.22 + (i * 0.6) / neighs)
    const fi = peakFreq * 2 ** (-(i * 2.4) / 12)
    f.setValueAtTime(fi * 1.03, tt)
    f.exponentialRampToValueAtTime(fi, tt + len * 0.1)
    env.setTargetAtTime(0.35, tt, 0.01)
    env.setTargetAtTime(0.85 - i * 0.1, tt + 0.02, 0.02)
  }
  env.setTargetAtTime(0, t + len * 0.9, 0.05)
  v.setTremolo(0, 13, t + len)
  v.setVibrato(0, VIBRATO_HZ, t + len)
}

/** Shaking glissando up an octave, a stepped trill of a fifth at the top, and the shaking slide back down. */
function shakingWhinny(v: BowedVoice, t: number, startFreq: number, duration: number): void {
  const len = Math.max(0.8, duration)
  const peakFreq = startFreq * 2
  const lower = peakFreq * 2 ** (-7 / 12)
  v.prepareGesture(t, bowTimbre({ speed: 0.85, pressure: 0.6, position: 0.25 }))
  // A wide, fast shake (the "Mongolian trill" band) all the way; a lighter flutter than the Khalkh neigh.
  v.setVibrato(60, 7, t)
  v.setTremolo(0.3, 12, t)

  const f = v.frequency
  const env = v.envelope
  const up = t + len * 0.3
  f.setValueAtTime(startFreq, t)
  f.exponentialRampToValueAtTime(peakFreq, up)
  env.setTargetAtTime(0.85, t, 0.02)
  // Fifth trill: 8 alternations a second, each change a 15 ms finger glide.
  const trillEnd = t + len * 0.6
  const half = 1 / 16
  for (let ts = up; ts + 2 * half <= trillEnd; ts += 2 * half) {
    f.setValueAtTime(peakFreq, ts + half)
    f.exponentialRampToValueAtTime(lower, ts + half + 0.015)
    f.setValueAtTime(lower, ts + 2 * half)
    f.exponentialRampToValueAtTime(peakFreq, ts + 2 * half + 0.015)
  }
  f.setValueAtTime(peakFreq, trillEnd + 0.015)
  f.exponentialRampToValueAtTime(startFreq, t + len * 0.92)
  env.setTargetAtTime(0.6, trillEnd, len * 0.15)
  env.setTargetAtTime(0, t + len * 0.92, 0.05)
  v.setTremolo(0, 13, t + len)
  v.setVibrato(0, VIBRATO_HZ, t + len)
}
