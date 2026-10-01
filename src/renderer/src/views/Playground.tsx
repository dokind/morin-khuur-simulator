import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getPerformer } from '@renderer/audio/live'
import { SOUNDBOARDS } from '@renderer/audio/body'
import { engine } from '@renderer/audio/engine'
import { BowPad } from '@renderer/components/BowPad'
import { Kbd, Select, Slider, ToggleButton } from '@renderer/components/controls'
import { InstrumentView } from '@renderer/components/InstrumentView'
import { Knob } from '@renderer/components/Knob'
import { StereoMeter } from '@renderer/components/Meters'
import { QuickRecordButton } from '@renderer/components/RecordButton'
import { RoomSelector } from '@renderer/components/RoomSelector'
import { chooseString, getTuning, keyboardLayout, MAX_STOP, SCALES, scaleStops, TUNINGS, type ScaleId } from '@renderer/core/instrument'
import { midiToName, prettyNoteName } from '@renderer/core/pitch'
import { SCREEN_DIRECTION, type BowDirection } from '@renderer/core/techniques'
import { useKeyboard } from '@renderer/hooks'
import { useSettings } from '@renderer/state/settings'

/** Home-row keys, left to right, for the ascending playable notes. */
const NOTE_KEYS = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote']
const NOTE_KEY_LABELS = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"]
const VISIBLE_STOPS = 12
const LEFT_DIR: BowDirection = SCREEN_DIRECTION.tatakh < 0 ? 'tatakh' : 'tülekhe'
const RIGHT_DIR: BowDirection = LEFT_DIR === 'tatakh' ? 'tülekhe' : 'tatakh'

export function Playground() {
  const performer = getPerformer()
  const state = useSyncExternalStore(performer.subscribe, performer.getState)
  const { tuningId, setTuning, soundboard, setSoundboard, roomId, setRoom, scale, setScale, vibratoDepth, setVibratoDepth } = useSettings()
  const tuning = getTuning(tuningId)
  const [bowPosition, setBowPosition] = useState(0)
  const [midiStatus, setMidiStatus] = useState<string | null>(null)

  const layout = useMemo(() => keyboardLayout(tuning, scale, NOTE_KEYS.length), [tuning, scale])
  const pads = useMemo(
    () => ({
      male: scaleStops(tuning.male, tuning.scaleTonic, scale, VISIBLE_STOPS),
      female: scaleStops(tuning.female, tuning.scaleTonic, scale, VISIBLE_STOPS)
    }),
    [tuning, scale]
  )

  useEffect(() => performer.setTuning(tuning), [performer, tuning])
  useEffect(() => performer.setVibratoDepth(vibratoDepth), [performer, vibratoDepth])
  useEffect(() => performer.setBowPosition(bowPosition), [performer, bowPosition])
  useEffect(() => () => performer.allNotesOff(), [performer])

  // Web MIDI: play from a MIDI keyboard; the mod wheel controls vibrato depth.
  useEffect(() => {
    if (!navigator.requestMIDIAccess) return
    let access: MIDIAccess | null = null
    const onMessage = (msg: MIDIMessageEvent) => {
      const [status = 0, a = 0, b = 0] = msg.data ?? []
      const kind = status & 0xf0
      if (kind === 0x90 && b > 0) {
        const pos = chooseString(a, tuning)
        if (pos) performer.noteOn(`midi-${a}`, pos.string, pos.stop, { velocity: b / 127 })
      } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
        performer.noteOff(`midi-${a}`)
      } else if (kind === 0xb0 && a === 1) {
        setVibratoDepth(Math.round((b / 127) * 60))
      }
    }
    const bind = () => {
      if (!access) return
      const inputs = [...access.inputs.values()]
      inputs.forEach((i) => (i.onmidimessage = onMessage))
      setMidiStatus(inputs.length ? `MIDI · ${inputs.length} device${inputs.length > 1 ? 's' : ''}` : null)
    }
    navigator
      .requestMIDIAccess()
      .then((a) => {
        access = a
        a.onstatechange = bind
        bind()
      })
      .catch(() => setMidiStatus(null))
    return () => {
      if (access) [...access.inputs.values()].forEach((i) => (i.onmidimessage = null))
    }
  }, [performer, tuning, setVibratoDepth])

  useKeyboard({
    down: (e) => {
      void engine.resume()
      const i = NOTE_KEYS.indexOf(e.code)
      if (i >= 0 && layout[i]) {
        const n = layout[i]!
        performer.noteOn(e.code, n.string, n.stop, { harmonic: e.shiftKey })
        return true
      }
      switch (e.code) {
        case 'ArrowLeft':
        case 'ArrowRight':
          performer.bowPad({ speed: 0.6, pressure: performer.bowPressure, position: bowPosition }, e.code === 'ArrowLeft' ? LEFT_DIR : RIGHT_DIR)
          return true
        case 'ArrowUp':
          setBowPosition((p) => Math.min(1, p + 0.25))
          return true
        case 'ArrowDown':
          setBowPosition((p) => Math.max(-1, p - 0.25))
          return true
        case 'Space':
          performer.setTremolo(true)
          return true
        case 'KeyV':
          performer.setVibratoBoost(true)
          return true
        case 'KeyB':
          performer.setWavy(true)
          return true
        case 'KeyC':
          performer.colLegno()
          return true
        case 'KeyT':
          performer.bodyTap()
          return true
        case 'KeyX':
          performer.slap()
          return true
        case 'KeyW':
          performer.whinny()
          return true
        case 'KeyP':
          performer.pluck()
          return true
        case 'KeyR':
          performer.fingerStrike()
          return true
        case 'KeyY':
          performer.setThumb(!performer.getState().thumb)
          return true
        case 'KeyZ':
          performer.setDrone(!performer.getState().drone)
          return true
        case 'KeyQ':
          performer.setPizzicato(!performer.getState().pizzicato)
          return true
      }
      return false
    },
    up: (e) => {
      if (NOTE_KEYS.includes(e.code)) {
        performer.noteOff(e.code)
        return true
      }
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') performer.bowPadEnd()
      else if (e.code === 'Space') performer.setTremolo(false)
      else if (e.code === 'KeyV') performer.setVibratoBoost(false)
      else if (e.code === 'KeyB') performer.setWavy(false)
      return false
    }
  })

  const levels = () => engine.morinKhuur().levels()
  const scaleOptions = (Object.keys(SCALES) as ScaleId[]).map((id) => ({ value: id, label: SCALES[id].name }))

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Top bar, as in design_references/morin_khuur_playground_ui.jpg */}
      <div className="panel grid grid-cols-[1.15fr_1fr_0.9fr_1fr_1.1fr] divide-x divide-line [&>*]:min-w-0">
        <div className="flex items-center justify-center px-3 py-3">
          <QuickRecordButton />
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-3">
          <span className="panel-title">Tuning</span>
          <Select label="Tuning" value={tuningId} options={TUNINGS.map((t) => ({ value: t.id, label: t.name }))} onChange={setTuning} className="w-full max-w-52" />
          <Select label="Soundboard" value={soundboard} options={SOUNDBOARDS.map((b) => ({ value: b.id, label: b.name }))} onChange={setSoundboard} className="h-7 w-full max-w-52 text-xs" />
        </div>
        <div className="flex items-center justify-center gap-4 px-4 py-3">
          <label className="flex flex-col gap-1">
            <span className="panel-title">Scale</span>
            <Select label="Scale" value={scale} options={scaleOptions} onChange={setScale} className="w-40 narrow:w-32" />
          </label>
          <Knob label="Vibrato" value={vibratoDepth} min={0} max={60} step={1} defaultValue={18} onChange={setVibratoDepth} format={(v) => `${v.toFixed(0)}¢`} size={44} />
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-3">
          <span className="panel-title">Room Selector</span>
          <RoomSelector value={roomId} onChange={setRoom} />
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-3">
          <span className="panel-title">Stereo Volume</span>
          <StereoMeter />
          {midiStatus && <span className="text-[10px] text-teal">{midiStatus}</span>}
        </div>
      </div>

      {/* Instrument */}
      <div className="relative min-h-0 flex-1 rounded-2xl" style={{ background: 'radial-gradient(ellipse at 50% 45%, #2a2019 0%, #15110e 60%, #0e0c0a 100%)' }}>
        <InstrumentView
          className="h-full"
          tuning={tuning}
          pads={pads}
          showHarmonics
          activity={state}
          levels={levels}
          onPress={(string, stop, harmonic) => {
            void engine.resume()
            performer.noteOn('pointer', string, Math.min(MAX_STOP, stop), { harmonic })
          }}
          onSlide={(string, stop) => performer.noteOn('pointer', string, Math.min(MAX_STOP, stop))}
          onRelease={() => performer.noteOff('pointer')}
        />
        <div className="pointer-events-none absolute bottom-3 left-5 text-xs text-muted">
          <div>
            <span className="text-arga">■</span> Arga — male string · <span className="text-bilag">■</span> Bilag — female string
          </div>
          <div className="mt-1 text-faint">Side-stop pads sit where the finger touches the hovering string · ◇ tsatsal nodes</div>
        </div>
      </div>

      {/* Techniques */}
      <div className="panel flex items-center gap-1.5 px-3 py-2">
        <ToggleButton className="btn-sm" on={state.pizzicato} onClick={() => performer.setPizzicato(!state.pizzicato)} title="Pizzicato mode (Q)">
          Pizzicato <Kbd hideWhenNarrow>Q</Kbd>
        </ToggleButton>
        <ToggleButton className="btn-sm" on={state.drone} onClick={() => performer.setDrone(!state.drone)} title="Double-stop drone: bow both strings (Z)">
          Drone <Kbd hideWhenNarrow>Z</Kbd>
        </ToggleButton>
        <button type="button" className="btn btn-sm" onClick={() => performer.colLegno()} title="Col legno — bow stick hit (C)">
          Col legno <Kbd hideWhenNarrow>C</Kbd>
        </button>
        <button type="button" className="btn btn-sm" onClick={() => performer.bodyTap()} title="Knuckle tap on the soundbox (T)">
          Body tap <Kbd hideWhenNarrow>T</Kbd>
        </button>
        <button type="button" className="btn btn-sm" onClick={() => performer.slap()} title="String slap (X)">
          Slap <Kbd hideWhenNarrow>X</Kbd>
        </button>
        <button type="button" className="btn btn-sm" onClick={() => performer.pluck()} title="Pluck the current note (P)">
          Pluck <Kbd hideWhenNarrow>P</Kbd>
        </button>
        <button type="button" className="btn btn-sm" onClick={() => performer.fingerStrike()} title="Finger strike — tsokhilgo (R)">
          Tsokhilgo <Kbd hideWhenNarrow>R</Kbd>
        </button>
        <ToggleButton className="btn-sm" on={state.thumb} onClick={() => performer.setThumb(!state.thumb)} title="Thumb playing — erkhii darakh: stop the string with the thumb pad (Y)">
          Thumb <Kbd hideWhenNarrow>Y</Kbd>
        </ToggleButton>
        <button type="button" className="btn btn-sm" onClick={() => performer.whinny()} title="Horse whinny — moriin insee (W)">
          Whinny <Kbd hideWhenNarrow>W</Kbd>
        </button>
        <button
          type="button"
          className="btn btn-sm"
          data-on={state.tremolo}
          onPointerDown={() => performer.setTremolo(true)}
          onPointerUp={() => performer.setTremolo(false)}
          onPointerLeave={() => state.tremolo && performer.setTremolo(false)}
          title="Hold for tremolo — dalallaga (Space)"
        >
          Tremolo <Kbd hideWhenNarrow>Space</Kbd>
        </button>
        <div className="ml-auto flex shrink-0 items-center">
          <Slider label="Bow point" value={bowPosition} min={-1} max={1} onChange={setBowPosition} left="Sul tasto" right="Ponticello" className="w-36" />
        </div>
      </div>

      <BowPad
        position={bowPosition}
        autoBowing={state.bowed.male || state.bowed.female}
        direction={state.direction}
        onBow={(input, dir) => {
          void engine.resume()
          performer.bowPad(input, dir)
        }}
        onBowEnd={() => performer.bowPadEnd()}
      />

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          {layout.map((n, i) => (
            <span key={NOTE_KEYS[i]} className="flex flex-col items-center gap-0.5">
              <Kbd>{NOTE_KEY_LABELS[i]}</Kbd>
              <span className={n.string === 'male' ? 'text-arga' : 'text-bilag'}>{prettyNoteName(midiToName(n.midi))}</span>
            </span>
          ))}
        </span>
        <span>
          <Kbd>Shift</Kbd> + note = tsatsal
        </span>
        <span>
          <Kbd>←</Kbd>
          <Kbd>→</Kbd> bow
        </span>
        <span>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> bow point
        </span>
        <span>
          <Kbd>V</Kbd> vibrato
        </span>
        <span>
          <Kbd>B</Kbd> wavy bow
        </span>
        <span>Hold keys legato to slur in one bow</span>
      </div>
    </div>
  )
}
