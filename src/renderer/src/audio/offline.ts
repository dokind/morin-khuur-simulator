import * as Tone from 'tone'
import { detectPitch, rms } from '@renderer/core/pitch-detect'
import { isGlissando } from '@renderer/core/techniques'
import { encodeWav } from '@renderer/core/wav'
import { loadDsp } from './dsp'
import { engine } from './engine'
import { MorinKhuur, type NoteEvent } from './morin-khuur'
import { getRoom, Room, type RoomId } from './room'

const SAMPLE_RATE = 44100

/**
 * Final safety stage after the limiter: Tone.Limiter is a fast compressor and lets transient peaks
 * through, so a gentle tanh curve rounds anything near full scale instead of hard-clipping.
 */
export function softClipper(): Tone.WaveShaper {
  const drive = 1.2
  return new Tone.WaveShaper((x) => Math.tanh(x * drive) / Math.tanh(drive), 4096)
}

/** The last render queued: each render starts once the one before it has settled. */
let renderLock: Promise<unknown> = Promise.resolve()
/** Renders queued or running. */
let rendersInFlight = 0
const idleWaiters = new Set<() => void>()

function renderSettled(): void {
  if (--rendersInFlight > 0) return
  for (const resolve of idleWaiters) resolve()
  idleWaiters.clear()
}

/**
 * Renders audio faster than real time. `build` runs with the offline context active, so any Tone
 * nodes it creates (instruments, kits) render into the result.
 *
 * Renders run one at a time, app-wide (Song Tester pitch test, Studio stems, Beat Maker export,
 * Playlist): Tone.Offline makes its context the global one while `build` runs and then restores
 * the one it found, so overlapping renders would build into each other's context and could leave
 * an offline context global. Never call it from inside a `build`: it would wait for itself.
 * `signal` drops a render that has not started yet (it rejects with the signal's reason); a
 * running render always finishes.
 */
export function renderOffline(
  duration: number,
  build: (input: Tone.InputNode) => void | Promise<void>,
  { room, channels = 2, signal }: { room?: RoomId; channels?: number; signal?: AbortSignal } = {}
): Promise<Tone.ToneAudioBuffer> {
  rendersInFlight++
  const render = renderLock
    .catch(() => {})
    .then(() => {
      signal?.throwIfAborted()
      return renderNow(duration, build, room, channels)
    })
  renderLock = render
  render.then(renderSettled, renderSettled)
  return render
}

async function renderNow(duration: number, build: (input: Tone.InputNode) => void | Promise<void>, room: RoomId | undefined, channels: number): Promise<Tone.ToneAudioBuffer> {
  // The live graph exists first: engine.init() replaces the global context, which would strand
  // the engine's context if it happened while a build holds the global slot.
  engine.init()
  const live = Tone.getContext()
  try {
    return await Tone.Offline(
      async () => {
        await loadDsp()
        const limiter = new Tone.Limiter(-1).connect(softClipper().toDestination())
        let input: Tone.InputNode = limiter
        if (room && room !== 'dry') {
          const r = new Room(limiter, getRoom(room))
          await r.ready
          input = r.input
        }
        await build(input)
      },
      duration,
      channels,
      SAMPLE_RATE
    )
  } finally {
    // Tone.Offline leaves its own context global when the build throws.
    if (Tone.getContext() !== live) Tone.setContext(live)
  }
}

/**
 * Resolves once no offline render is queued or running (at once when none is). Live playback that
 * creates nodes or uses the transport waits for it: while a render builds its graph, Tone's global
 * context (and transport) is the offline one.
 */
export function whenOfflineIdle(): Promise<void> {
  if (rendersInFlight === 0) return Promise.resolve()
  return new Promise((resolve) => idleWaiters.add(resolve))
}

export function bufferToWav(buffer: Tone.ToneAudioBuffer): Uint8Array {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  return encodeWav({ sampleRate: buffer.sampleRate, channels })
}

export interface PitchMeasurement {
  freq: number | null
  confidence: number
  level: number
}

/** Techniques whose sounding pitch is stable enough to verify acoustically. */
export function isPitchTestable(e: NoteEvent): boolean {
  return e.freq !== null && !['body_tap', 'col_legno', 'string_slap', 'horse_whinny'].includes(e.technique)
}

/**
 * Renders a single, dry, vibrato-free note of `event` and detects its pitch on the steady part.
 * Glissandi are measured at their starting pitch; double stops on their melody string only.
 */
export async function measurePitch(event: NoteEvent): Promise<PitchMeasurement> {
  // Articulations that move or shorten the note are measured as a sustained stroke at its pitch.
  const sustained = isGlissando(event.technique) || ['double_stop', 'vibrato', 'gallop'].includes(event.technique)
  const technique = sustained ? 'cuticle_side_stop' : event.technique
  const buffer = await renderOffline(
    0.9,
    (input) => {
      const kh = new MorinKhuur(input)
      kh.vibratoCents = 0
      // The note as written: a performed event's plan (ornaments, planned vibrato, bow shape,
      // drift, automatic drone) is dropped too.
      kh.play(
        {
          ...event,
          technique,
          duration: 0.75,
          vibrato: false,
          slur: false,
          glideTo: null,
          scoop: null,
          glide: null,
          velocity: 0.8,
          ornaments: undefined,
          vibratoPlan: null,
          bowProfile: undefined,
          positionRamp: null,
          shurankhai: false,
          droneLevel: null,
          frame: null
        },
        0.02
      )
    },
    { channels: 1 }
  )
  const data = buffer.getChannelData(0)
  // Plucks decay quickly, so measure them just after the attack; bowed notes once settled.
  const [from, to] = event.technique === 'pizzicato' || event.technique === 'tsokhilgo' ? [0.03, 0.18] : [0.3, 0.7]
  const segment = data.subarray(Math.floor(from * buffer.sampleRate), Math.floor(to * buffer.sampleRate))
  const estimate = detectPitch(segment, buffer.sampleRate, { minFreq: 60, maxFreq: 2500 })
  return { freq: estimate?.freq ?? null, confidence: estimate?.confidence ?? 0, level: rms(segment) }
}
