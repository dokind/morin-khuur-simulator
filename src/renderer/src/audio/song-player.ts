import * as Tone from 'tone'
import { engine } from './engine'
import type { MorinKhuur } from './morin-khuur'
import { eventsDuration, type TimedEvent } from './song-events'

export { eventsDuration, songEvents, songPerformance, type SongEventOptions, type SongPerformance, type TimedEvent } from './song-events'

/** Plays timed events on the shared transport, reporting the sounding score note for visuals. */
export class SongPlayer {
  play(events: TimedEvent[], instrument: MorinKhuur, handlers: { onNote(order: number): void; onEnd(): void }, { loop = false } = {}): void {
    engine.resetTransport()
    const transport = Tone.getTransport()
    const draw = Tone.getDraw()
    for (const e of events) {
      transport.schedule((time) => {
        instrument.play(e.event, time)
        // Framing strokes are not score notes: nothing to highlight.
        if (e.order >= 0) draw.schedule(() => handlers.onNote(e.order), time)
      }, e.start)
    }
    const length = eventsDuration(events) + 0.4
    if (loop) {
      transport.loop = true
      transport.loopStart = 0
      transport.loopEnd = length
    } else {
      transport.loop = false
      // Not via Draw: Draw drops callbacks while the window is hidden, and the end must always land.
      transport.schedule(() => handlers.onEnd(), length)
    }
    transport.start('+0.05')
  }

  /** Seconds since playback started (for smooth playheads). */
  get position(): number {
    return Tone.getTransport().seconds
  }

  stop(): void {
    Tone.getTransport().loop = false
    engine.resetTransport()
  }
}
