import * as Tone from 'tone'
import { encodeWav } from '@renderer/core/wav'
import { BeatKit } from './beat-kit'
import type { Soundboard } from './body'
import { loadDsp } from './dsp'
import { MorinKhuur } from './morin-khuur'
import { softClipper } from './offline'
import { getRoom, Room, type RoomId } from './room'

/**
 * Process-wide audio graph:
 *   instruments → bus → room → master volume → limiter → speakers
 *                                                     ↘ meter / waveform / recorder
 * Created lazily on first use; nothing touches Tone before `init()`.
 */
class AudioEngine {
  private graph: {
    bus: Tone.Gain
    room: Room
    master: Tone.Volume
    limiter: Tone.Limiter
    meter: Tone.Meter
    waveform: Tone.Waveform
    recorder: Tone.Recorder
  } | null = null
  private instrument: MorinKhuur | null = null
  private soundboard: Soundboard = 'wood'
  private kit: BeatKit | null = null
  private listeners = new Set<() => void>()

  get initialised(): boolean {
    return this.graph !== null
  }

  /** Builds the graph (idempotent). Safe to call before a user gesture; `resume()` unlocks output. */
  init(): void {
    if (this.graph) return
    // Every oscillator started before the context resumes repeats the same "suspended" warning;
    // one is informative, dozens are noise.
    let warnedSuspended = false
    Tone.debug.setLogger({
      log: (...args: unknown[]) => console.log(...args),
      warn: (...args: unknown[]) => {
        if (String(args[0]).includes('"suspended"')) {
          if (warnedSuspended) return
          warnedSuspended = true
        }
        console.warn(...args)
      }
    })
    Tone.setContext(new Tone.Context({ latencyHint: 'interactive', lookAhead: 0.05 }))
    // Voices created before the worklet module finishes loading attach themselves when it does.
    void loadDsp()
    const clip = softClipper().toDestination()
    const limiter = new Tone.Limiter(-1).connect(clip)
    const master = new Tone.Volume(0).connect(limiter)
    const room = new Room(master)
    const bus = new Tone.Gain(1).connect(room.input)
    const meter = new Tone.Meter({ channelCount: 2, smoothing: 0.75 })
    const waveform = new Tone.Waveform(1024)
    const recorder = new Tone.Recorder()
    limiter.fan(meter, waveform, recorder)
    this.graph = { bus, room, master, limiter, meter, waveform, recorder }
    for (const l of this.listeners) l()
  }

  async resume(): Promise<void> {
    this.init()
    if (Tone.getContext().state !== 'running') await Tone.start()
    for (const l of this.listeners) l()
  }

  get running(): boolean {
    return this.graph !== null && Tone.getContext().state === 'running'
  }

  onStateChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private get g() {
    this.init()
    return this.graph!
  }

  get bus(): Tone.Gain {
    return this.g.bus
  }

  /** Shared live instrument for the Playground and Song Tester (with string meters for visuals). */
  morinKhuur(): MorinKhuur {
    if (!this.instrument) {
      this.instrument = new MorinKhuur(this.g.bus, { meters: true })
      this.instrument.soundboard = this.soundboard
    }
    return this.instrument
  }

  beatKit(): BeatKit {
    this.kit ??= new BeatKit(this.g.bus)
    return this.kit
  }

  setRoom(id: RoomId): void {
    this.g.room.apply(getRoom(id))
  }

  /** Soundboard of the shared live instrument (Playground / Song Tester). */
  setSoundboard(soundboard: Soundboard): void {
    this.soundboard = soundboard
    if (this.instrument) this.instrument.soundboard = soundboard
  }

  setRoomSends(sends: { long?: number; short?: number }): void {
    this.g.room.setSends(sends)
  }

  setMasterDb(db: number): void {
    this.g.master.volume.rampTo(db, 0.05)
  }

  /** Stereo RMS in dBFS. */
  levels(): [number, number] {
    if (!this.graph) return [-Infinity, -Infinity]
    const v = this.graph.meter.getValue()
    return Array.isArray(v) ? [v[0] ?? -Infinity, v[1] ?? -Infinity] : [v, v]
  }

  waveform(): Float32Array | null {
    return this.graph ? (this.graph.waveform.getValue() as Float32Array) : null
  }

  /** Stops the transport and clears everything scheduled on it. */
  resetTransport(): void {
    // Nothing has played before the graph exists (and nothing touches Tone before `init()`).
    if (!this.graph) return
    // The live context's transport and clock, even while another view's offline render holds
    // Tone's global slot: a stop or view switch during a render must still stop playback.
    const live = this.graph.bus.context
    const transport = live.transport
    transport.stop()
    transport.cancel(0)
    transport.position = 0
    this.instrument?.silence(live.immediate())
  }

  async startRecording(): Promise<void> {
    await this.resume()
    if (this.g.recorder.state !== 'started') await this.g.recorder.start()
  }

  get recording(): boolean {
    return this.graph?.recorder.state === 'started'
  }

  /** Stops the master recorder and returns the take as 16-bit WAV bytes. */
  async stopRecording(): Promise<Uint8Array | null> {
    if (!this.graph || this.graph.recorder.state !== 'started') return null
    const blob = await this.graph.recorder.stop()
    const audio = await Tone.getContext().decodeAudioData(await blob.arrayBuffer())
    const channels = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c))
    return encodeWav({ sampleRate: audio.sampleRate, channels })
  }
}

export const engine = new AudioEngine()
