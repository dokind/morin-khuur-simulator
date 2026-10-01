import * as Tone from 'tone'
import { khoomiiPart, rhythmPart, tovshuurPart, type ArrangementSpec } from '@renderer/core/arrangement'
import type { Tuning } from '@renderer/core/instrument'
import type { Song, VerificationReport } from '@renderer/core/notation'
import type { StyleId } from '@renderer/core/performance'
import { midiToFreq } from '@renderer/core/pitch'
import { Khoomii, Tovshuur } from './accompaniment'
import type { Soundboard } from './body'
import { engine } from './engine'
import { MorinKhuur } from './morin-khuur'
import { bufferToWav, renderOffline } from './offline'
import type { RoomId } from './room'
import { songEvents, type TimedEvent } from './song-player'

export type TrackId = 'lead' | 'rhythm' | 'tovshuur' | 'khoomii'

export const TRACKS: readonly { id: TrackId; name: string; color: string }[] = [
  { id: 'lead', name: 'Morin Khuur Lead', color: '#46c46a' },
  { id: 'rhythm', name: 'Morin Khuur Rhythm', color: '#4aa3ff' },
  { id: 'tovshuur', name: 'Tovshuur Lute Accompaniment', color: '#f6a930' },
  { id: 'khoomii', name: 'Khöömii Drone', color: '#b36bff' }
]

export interface TrackMix {
  volume: number
  mute: boolean
  solo: boolean
}

export interface StudioProject {
  song: Song
  report: VerificationReport
  spec: ArrangementSpec
  tuning: Tuning
  vibratoCents: number
  soundboard: Soundboard
  /** Playing style of the lead; null for the song's own. */
  leadStyle: StyleId | null
  /** Ornament density of the lead's style, 0–2 (1 = the style's own). */
  ornamentAmount: number
}

/** Start offset so the first attack isn't clipped. */
const LEAD_IN = 0.05
const TAIL = 1.5

/**
 * The lead song performed in its style, locked to the accompaniment's bar grid: notes start and
 * last as written at the project's tempo (no rubato, breaths or held endings, and not the song's
 * own tempo map: the accompaniment keeps one tempo), with no framing strokes or lead-in, so every
 * bar of the song stays on its bar of the arrangement. Ornaments (at the chosen amount), vibrato
 * and bow shapes follow the style.
 */
export function leadEvents(p: StudioProject): TimedEvent[] {
  return songEvents(p.song, p.report, p.spec.bpm, { ...(p.leadStyle ? { style: p.leadStyle } : {}), amount: p.ornamentAmount, grid: true })
}

export function projectLength(p: StudioProject): number {
  const bar = ((p.spec.meter === '6/8' ? 3 : 4) * 60) / p.spec.bpm
  return p.spec.bars * bar
}

/** Renders each track to a dry mono stem. Room and mix are applied at playback / export. */
export async function renderStems(p: StudioProject, onProgress: (done: number) => void): Promise<Record<TrackId, Tone.ToneAudioBuffer>> {
  const length = projectLength(p) + TAIL
  const out = {} as Record<TrackId, Tone.ToneAudioBuffer>

  out.lead = await renderOffline(
    length,
    (input) => {
      const kh = new MorinKhuur(input)
      kh.tuning = p.tuning
      kh.soundboard = p.soundboard
      kh.vibratoCents = p.vibratoCents
      for (const e of leadEvents(p)) kh.play(e.event, LEAD_IN + e.start)
    },
    { channels: 1 }
  )
  onProgress(1)

  out.rhythm = await renderOffline(
    length,
    (input) => {
      const kh = new MorinKhuur(input)
      kh.tuning = p.tuning
      kh.soundboard = p.soundboard
      for (const n of rhythmPart(p.spec, p.tuning)) {
        kh.play(
          { technique: 'gallop', string: n.string, freq: midiToFreq(n.midi), duration: n.duration, velocity: n.velocity * 0.8, bow: n.bow, slur: n.slur },
          LEAD_IN + n.start
        )
      }
    },
    { channels: 1 }
  )
  onProgress(2)

  out.tovshuur = await renderOffline(
    length,
    (input) => {
      const lute = new Tovshuur(input)
      for (const n of tovshuurPart(p.spec)) lute.strum(midiToFreq(n.midi), LEAD_IN + n.start, n.velocity)
    },
    { channels: 1 }
  )
  onProgress(3)

  out.khoomii = await renderOffline(
    length,
    (input) => {
      const voice = new Khoomii(input)
      const { drone, overtones } = khoomiiPart(p.spec)
      voice.drone(midiToFreq(drone.midi), LEAD_IN + drone.start, drone.duration)
      for (const o of overtones) voice.overtone(o.partial, LEAD_IN + o.start, o.duration)
    },
    { channels: 1 }
  )
  onProgress(4)
  return out
}

/** Min/max peaks per column for waveform lanes. */
export function peaks(buffer: Tone.ToneAudioBuffer, columns: number): Float32Array {
  const data = buffer.getChannelData(0)
  const out = new Float32Array(columns * 2)
  const per = Math.max(1, Math.floor(data.length / columns))
  for (let c = 0; c < columns; c++) {
    let lo = 0
    let hi = 0
    for (let i = c * per, end = Math.min(data.length, i + per); i < end; i++) {
      const v = data[i]!
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    out[c * 2] = lo
    out[c * 2 + 1] = hi
  }
  return out
}

/**
 * Stem playback synced to the shared transport, one Tone.Channel per track. Load and play once no
 * offline render is building (`whenOfflineIdle`): nodes are created in the global context. The
 * transport is always the live one, even while another view's render holds the global slot.
 */
export class StudioMixer {
  private players: Partial<Record<TrackId, Tone.Player>> = {}
  private channels: Partial<Record<TrackId, Tone.Channel>> = {}

  /** The live context's transport (the one the synced players follow). */
  private get transport(): ReturnType<typeof Tone.getTransport> {
    return engine.bus.context.transport
  }

  load(stems: Record<TrackId, Tone.ToneAudioBuffer>, mix: Record<TrackId, TrackMix>): void {
    this.unload()
    for (const t of TRACKS) {
      const channel = new Tone.Channel({ volume: mix[t.id].volume, mute: mix[t.id].mute, solo: mix[t.id].solo }).connect(engine.bus)
      const player = new Tone.Player(stems[t.id]).connect(channel)
      player.sync().start(0)
      this.players[t.id] = player
      this.channels[t.id] = channel
    }
  }

  setMix(track: TrackId, mix: TrackMix): void {
    const ch = this.channels[track]
    if (!ch) return
    ch.volume.rampTo(mix.volume, 0.05)
    ch.mute = mix.mute
    ch.solo = mix.solo
  }

  /** Starts playback; returns the context time at which transport position 0 sounds. */
  play(length: number, loop: boolean): number {
    const transport = this.transport
    transport.loop = loop
    transport.loopStart = 0
    transport.loopEnd = length
    const at = transport.context.now() + 0.05
    transport.start(at)
    return at - transport.seconds
  }

  pause(): void {
    this.transport.pause()
  }

  stop(): void {
    const transport = this.transport
    transport.stop()
    transport.position = 0
  }

  seek(seconds: number): void {
    this.transport.seconds = Math.max(0, seconds)
  }

  get position(): number {
    return this.transport.seconds
  }

  get state(): 'started' | 'stopped' | 'paused' {
    return this.transport.state
  }

  unload(): void {
    for (const p of Object.values(this.players)) {
      p.unsync()
      p.dispose()
    }
    for (const c of Object.values(this.channels)) c.dispose()
    this.players = {}
    this.channels = {}
  }
}

/** Mixes stems with the current fader/mute/solo settings and room, to WAV bytes. */
export async function renderMixWav(
  stems: Record<TrackId, Tone.ToneAudioBuffer>,
  mix: Record<TrackId, TrackMix>,
  room: RoomId,
  length: number
): Promise<Uint8Array> {
  const anySolo = TRACKS.some((t) => mix[t.id].solo)
  const buffer = await renderOffline(
    length + TAIL,
    (input) => {
      for (const t of TRACKS) {
        const m = mix[t.id]
        if (m.mute || (anySolo && !m.solo)) continue
        const gain = new Tone.Gain(Tone.dbToGain(m.volume)).connect(input)
        new Tone.Player(stems[t.id]).connect(gain).start(0)
      }
    },
    { room }
  )
  return bufferToWav(buffer)
}

/**
 * Records a live take from the shared instrument (pre-room, so the room isn't printed twice)
 * and aligns it to transport position 0.
 */
export class TakeRecorder {
  private recorder: Tone.Recorder | null = null
  private startedAt = 0

  get recording(): boolean {
    return this.recorder !== null
  }

  async start(): Promise<void> {
    this.recorder = new Tone.Recorder()
    engine.morinKhuur().output.connect(this.recorder)
    await this.recorder.start()
    this.startedAt = Tone.immediate()
  }

  async stop(transportZeroAt: number): Promise<Tone.ToneAudioBuffer | null> {
    const rec = this.recorder
    if (!rec) return null
    this.recorder = null
    const blob = await rec.stop()
    engine.morinKhuur().output.disconnect(rec)
    rec.dispose()
    const audio = await Tone.getContext().decodeAudioData(await blob.arrayBuffer())
    const skip = Math.max(0, Math.round((transportZeroAt - this.startedAt) * audio.sampleRate))
    const data = audio.getChannelData(0).subarray(skip)
    const buffer = Tone.getContext().createBuffer(1, Math.max(1, data.length), audio.sampleRate)
    buffer.copyToChannel(data, 0)
    return new Tone.ToneAudioBuffer(buffer)
  }
}
