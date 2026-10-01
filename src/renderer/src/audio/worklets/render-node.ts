/// <reference types="vite/client" />
// (the reference types `?raw` for the tests' Node config, which reaches this module)
import bowedStringSource from './bowed-string.worklet.js?raw'
import { TECHNIQUES } from '@renderer/core/techniques'
import { midiToFreq } from '@renderer/core/pitch'
import type { Song, VerificationReport } from '@renderer/core/notation'
import type { StringId } from '@renderer/core/instrument'
import type { StyleId } from '@renderer/core/performance'
import { eventsDuration, songEvents, type TimedEvent } from '../song-events'

// Renders a song in Node through the same bowed-string AudioWorklet the app plays, with the worklet
// globals stubbed exactly as bowed-string.test.ts does. It is the DRY STRING only: no soundbox
// convolution, no room, no limiter (those are Web Audio nodes), no plucks or percussion, and the
// bow is driven per note rather than by BowedVoice's full automation (no vibrato or ornament
// curves). It exists so a song can leave the simulator as a file without a browser
// (scripts/render-song.mjs), and so its pitch can be tested in CI.

const BLOCK = 128
type Params = Record<string, Float32Array>
interface Processor {
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Params): boolean
}

/** The worklet's processor class, compiled for one sample rate. */
export function loadBowedString(sampleRate: number): new () => Processor {
  const source = bowedStringSource
  let registered: (new () => Processor) | null = null
  const register = (_name: string, cls: new () => Processor) => {
    registered = cls
  }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', source)(class {}, register, sampleRate)
  if (!registered) throw new Error('bowed-string.worklet.js registered no processor')
  return registered
}

export interface NodeRenderOptions {
  sampleRate?: number
  /** Playing style (default 'as-written': the notes and nothing else). */
  style?: StyleId
  /** Peak level of the output, linear (default 0.89, about −1 dBFS). */
  peak?: number
  /** Seconds of bow rise and release at a bow change (defaults 0.03 / 0.06). */
  rise?: number
  release?: number
}

export interface NodeRender {
  sampleRate: number
  samples: Float32Array
  /** The pitched, bowed events that were rendered. */
  events: TimedEvent[]
  /** Events skipped because the dry string cannot play them (plucks, percussion, gestures). */
  skipped: TimedEvent[]
  /** Gain applied to reach `peak`. */
  gain: number
}

/** Bow speed and force for a note velocity: BowedVoice.stroke's mapping (bowTimbre, pressure 0.4 + 0.4 v). */
export function bowFor(velocity: number, freq: number, openFreq: number, harmonic: boolean): { speed: number; force: number } {
  const speed = 0.4 + 0.6 * velocity
  const p = 0.4 + 0.4 * velocity
  const base = harmonic ? 0.4 + 0.15 * p + 0.3 * speed : 0.3 + 0.3 * p + 0.4 * speed
  return { speed, force: Math.min(0.97, Math.min(0.95, base) + 0.08 * Math.log2(Math.max(1, freq / openFreq))) }
}

interface Lane {
  freq: Float32Array
  speed: Float32Array
  force: Float32Array
}

export function renderSongNode(song: Song, report: VerificationReport, opts: NodeRenderOptions = {}): NodeRender {
  const sampleRate = opts.sampleRate ?? 48000
  const rise = opts.rise ?? 0.03
  const release = opts.release ?? 0.06
  const all = songEvents(song, report, song.tempoBpm, { style: opts.style ?? 'as-written' })
  const playable = (e: TimedEvent) => {
    const kind = TECHNIQUES[e.event.technique]?.kind
    return e.event.freq !== null && e.event.string !== null && (kind === 'stopped' || kind === 'harmonic')
  }
  const events = all.filter(playable)
  const skipped = all.filter((e) => !playable(e))
  const length = Math.ceil((eventsDuration(all) + release + 0.5) * sampleRate)
  const open: Record<StringId, number> = { male: midiToFreq(song.tuning.male), female: midiToFreq(song.tuning.female) }
  const lane = (): Lane => ({ freq: new Float32Array(length).fill(open.male), speed: new Float32Array(length), force: new Float32Array(length).fill(0.5) })
  const lanes: Record<StringId, Lane> = { male: lane(), female: lane() }

  const stroke = (s: StringId, start: number, dur: number, freq: number, velocity: number, harmonic: boolean, slur: boolean) => {
    const { speed, force } = bowFor(velocity, freq, open[s], harmonic)
    const a = Math.max(0, Math.round(start * sampleRate))
    const b = Math.min(length, Math.round((start + dur) * sampleRate))
    const l = lanes[s]
    const riseN = slur ? 0 : Math.max(1, Math.round(rise * sampleRate))
    const relN = Math.max(1, Math.round(release * sampleRate))
    for (let i = a; i < b; i++) {
      l.freq[i] = freq
      // Force is pressed at once on landing (easing it in locks the male string onto its octave).
      l.force[i] = force
      const fromStart = i - a
      const toEnd = b - i
      l.speed[i] = speed * Math.min(1, riseN ? fromStart / riseN : 1, toEnd / relN)
    }
    // Keep the last pitch while the string rings out after the bow leaves it.
    for (let i = b; i < length && lanes[s].speed[i] === 0; i++) l.freq[i] = freq
  }

  for (const e of events) {
    const n = e.event
    const harmonic = TECHNIQUES[n.technique]?.kind === 'harmonic'
    stroke(n.string!, e.start, n.duration, n.freq!, n.velocity, harmonic, !!n.slur)
    if (n.droneFreq) {
      const other: StringId = n.string === 'male' ? 'female' : 'male'
      stroke(other, e.start, n.duration, n.droneFreq, n.velocity * 0.8, false, false)
    }
  }

  const Processor = loadBowedString(sampleRate)
  const mix = new Float32Array(length)
  for (const s of ['male', 'female'] as const) {
    const l = lanes[s]
    if (!l.speed.some((v) => v > 0)) continue
    const p = new Processor()
    const block = new Float32Array(BLOCK)
    const params: Params = {
      detune: new Float32Array([0]),
      beta: new Float32Array([0.13]),
      roughness: new Float32Array([s === 'male' ? 0.35 : 0.3]),
      damping: new Float32Array([0.94])
    }
    for (let i = 0; i + BLOCK <= length; i += BLOCK) {
      params.frequency = l.freq.subarray(i, i + BLOCK)
      params.velocity = l.speed.subarray(i, i + BLOCK)
      params.force = l.force.subarray(i, i + BLOCK)
      block.fill(0)
      p.process([], [[block]], params)
      for (let k = 0; k < BLOCK; k++) mix[i + k]! += block[k]!
    }
  }
  let max = 0
  for (const v of mix) max = Math.max(max, Math.abs(v))
  const gain = max > 0 ? (opts.peak ?? 0.89) / max : 1
  for (let i = 0; i < length; i++) mix[i]! *= gain
  return { sampleRate, samples: mix, events, skipped, gain }
}
