import * as Tone from 'tone'
import { PAD_IDS, type PadId } from '@renderer/core/kit'
import { encodeMidi } from '@renderer/core/midi'
import {
  chainHits,
  chainMidi,
  exportParts,
  exportRepeats,
  getGroove,
  nextCursor,
  startCursor,
  stepAccent,
  stepOffset,
  stepSeconds,
  type Bank,
  type BankId,
  type Cursor
} from '@renderer/core/sequencer'
import { BeatKit, type PadParams } from './beat-kit'
import { engine } from './engine'
import { bufferToWav, renderOffline } from './offline'
import type { RoomId } from './room'

export interface SequencerSnapshot {
  banks: Record<BankId, Bank>
  /** The selected bank: where playback starts, and what is exported without chaining. */
  bank: BankId
  chain: boolean
  bpm: number
  loop: boolean
}

/**
 * Drives the Beat Maker on the shared transport. The snapshot is read on every step, so edits,
 * groove, tempo and chain changes apply while playing. Banks picked with `cue()` take over at
 * the next bar line.
 */
export class BeatSequencer {
  private eventId: number | null = null
  private snapshot: (() => SequencerSnapshot) | null = null
  private cursor: Cursor | null = null
  private cued: BankId | null = null
  /** The last few scheduled steps, to find the one under the playhead. */
  private recent: (Cursor & { time: number })[] = []
  /** Bumped by `stop()`: step callbacks of an earlier run still queued in Draw are dropped. */
  private run = 0

  get playing(): boolean {
    return this.eventId !== null
  }

  /** Bank waiting to take over at the next bar line. */
  get cuedBank(): BankId | null {
    return this.cued
  }

  start(snapshot: () => SequencerSnapshot, onStep: (bank: BankId, step: number) => void, onEnd: () => void): void {
    this.stop()
    const run = this.run
    const kit = engine.beatKit()
    const transport = Tone.getTransport()
    const draw = Tone.getDraw()
    this.snapshot = snapshot
    transport.bpm.value = snapshot().bpm
    this.eventId = transport.scheduleRepeat((time) => {
      const { banks, bank, chain, bpm, loop } = snapshot()
      if (transport.bpm.value !== bpm) transport.bpm.value = bpm
      const cursor = this.cursor ? nextCursor(this.cursor, banks, { chain, loop, cue: this.cued }) : startCursor(banks, bank, chain)
      if (!cursor) {
        // Called directly rather than via Draw, which drops callbacks while the window is hidden.
        onEnd()
        return
      }
      if (cursor.step === 0 && cursor.bank === this.cued) this.cued = null
      this.cursor = cursor
      const { pattern, grooveId } = banks[cursor.bank]
      const groove = getGroove(grooveId)
      const at = Math.max(time, time + stepOffset(groove, cursor.step) * stepSeconds(bpm))
      for (const pad of PAD_IDS) {
        const v = pattern.cells[pad][cursor.step]!
        if (v > 0) kit.trigger(pad, at, Math.min(1, v * stepAccent(groove, cursor.step)), pattern.pitch[pad][cursor.step])
      }
      this.recent.push({ ...cursor, time })
      if (this.recent.length > 8) this.recent.shift()
      draw.schedule(() => {
        if (this.run === run) onStep(cursor.bank, cursor.step)
      }, time)
    }, '16n')
    transport.start('+0.05')
  }

  /** Switches to `bank` at the next bar line (picking the playing bank cancels a pending switch). */
  cue(bank: BankId): void {
    if (!this.cursor) return
    this.cued = bank === this.cursor.bank ? null : bank
  }

  /** The bank and step under the playhead right now (nearest step), for quantised live recording. */
  position(): Cursor | null {
    const last = this.recent.at(-1)
    if (!last || !this.snapshot) return null
    const now = Tone.immediate()
    const { banks, chain, bpm, loop } = this.snapshot()
    // A step is scheduled only just before it sounds, so late in a step the nearer one isn't in `recent` yet.
    if (now - last.time > stepSeconds(bpm) / 2) return nextCursor(last, banks, { chain, loop, cue: this.cued }) ?? { bank: last.bank, step: last.step }
    let best = last
    for (const r of this.recent) if (Math.abs(r.time - now) < Math.abs(best.time - now)) best = r
    return { bank: best.bank, step: best.step }
  }

  stop(): void {
    if (this.eventId !== null) Tone.getTransport().clear(this.eventId)
    this.eventId = null
    this.snapshot = null
    this.cursor = null
    this.cued = null
    this.recent = []
    this.run++
    engine.resetTransport()
  }
}

/**
 * Renders the selected bank — or with chaining on, the whole chain from A — with the current pad
 * settings to WAV bytes, repeated to last at least `minBars` bars.
 */
export async function renderPatternWav(s: SequencerSnapshot, padParams: Record<PadId, PadParams>, room: RoomId, minBars = 4): Promise<Uint8Array> {
  const parts = exportParts(s.banks, s.bank, s.chain)
  const { hits, seconds } = chainHits(parts, s.bpm, exportRepeats(parts, minBars))
  const buffer = await renderOffline(
    seconds + 2,
    (input) => {
      const kit = new BeatKit(input)
      for (const pad of PAD_IDS) kit.setParams(pad, padParams[pad])
      for (const h of hits) kit.trigger(h.pad, 0.05 + h.time, h.velocity, h.pitch)
    },
    { room }
  )
  return bufferToWav(buffer)
}

/** The same content as `renderPatternWav` as a MIDI file (see `chainMidi` for the track layout). */
export function patternMidi(s: SequencerSnapshot, minBars = 4): Uint8Array {
  const parts = exportParts(s.banks, s.bank, s.chain)
  return encodeMidi(chainMidi(parts, s.bpm, exportRepeats(parts, minBars)))
}
