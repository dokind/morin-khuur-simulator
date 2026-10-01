import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, FileUp, Info, Loader2, Play, Square, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { engine } from '@renderer/audio/engine'
import { isPitchTestable, measurePitch, whenOfflineIdle, type PitchMeasurement } from '@renderer/audio/offline'
import { SongPlayer, songEvents, songPerformance, type SongPerformance } from '@renderer/audio/song-player'
import { AccuracyGauge } from '@renderer/components/AccuracyGauge'
import { InstrumentView, type FingerMarker, type InstrumentActivity } from '@renderer/components/InstrumentView'
import { JianpuView } from '@renderer/components/Jianpu'
import { StaffView } from '@renderer/components/StaffView'
import { otherString, type Tuning } from '@renderer/core/instrument'
import { jianpuMeasures, type Issue, type NoteCheck, type Song, type VerificationReport } from '@renderer/core/notation'
import { resolveStyle, STYLES, type StyleId } from '@renderer/core/performance'
import { centsBetween, midiToName, pitchClassName, prettyNoteName } from '@renderer/core/pitch'
import { BOW_INFO, SCREEN_DIRECTION, TECHNIQUES } from '@renderer/core/techniques'
import { importSongFile, SONG_FILE_FILTERS } from '@renderer/importing'
import { openFile } from '@renderer/platform'
import { memoLast } from '@renderer/memo'
import { loadSong } from '@renderer/songs'
import { allSongs, isStyleChoice, ORNAMENT_AMOUNT, useSongs, type NotationMode, type StyleChoice } from '@renderer/state/songs'

/** Spec §5.3: synthesized pitch must be within 5 cents of the expected frequency. */
export const PITCH_TOLERANCE_CENTS = 5

type Acoustic = { status: 'pass' | 'fail'; measured: number | null; cents: number | null } | { status: 'n/a' }
type Phase = 'idle' | 'testing' | 'playing' | 'done'

const player = new SongPlayer()
/** Bumped by every stop and every new playback or test: one still waiting to start, or testing, ends when it changes. */
let run = 0
const nextRun = () => ++run
function stopPlayback(): void {
  run++
  player.stop()
}
/** What Listen plays: the song performed in the chosen style. */
const performanceFor = memoLast((song: Song | null, report: VerificationReport | null, bpm: number, style: StyleChoice, amount: number): SongPerformance | null =>
  song && report ? songPerformance(song, report, bpm, { ...(style === 'auto' ? {} : { style }), amount }) : null
)
/** What the auto-test measures: always the notes as written. */
const writtenEventsFor = memoLast((song: Song | null, report: VerificationReport | null, bpm: number) => (song && report ? songEvents(song, report, bpm, { style: 'as-written' }) : []))
const measuresFor = memoLast((song: Song | null) => (song ? jianpuMeasures(song) : []))
const styleName = (id: StyleId) => STYLES.find((s) => s.id === id)?.name ?? id

export function SongTester() {
  const { imported, selectedId, select, importSong, removeImported, bpm: bpmOverride, setBpm, notation, setNotation, style: storedStyle, setStyle, ornamentAmount, setOrnamentAmount } =
    useSongs()
  const entries = allSongs(imported)
  const entry = entries.find((e) => e.id === selectedId) ?? entries[0]
  const loaded = entry ? loadSong(entry.raw) : null
  const song = loaded?.song ?? null
  const report = loaded?.report ?? null
  const bpm = bpmOverride ?? song?.tempoBpm ?? 90
  const style = isStyleChoice(storedStyle) ? storedStyle : 'auto'
  const listening = performanceFor(song, report, bpm, style, ornamentAmount)
  const writtenEvents = writtenEventsFor(song, report, bpm)
  const measures = measuresFor(song)
  const tuning: Tuning | null = song ? { id: 'song', name: '', male: song.tuning.male, female: song.tuning.female, scaleTonic: 0 } : null

  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [acoustic, setAcoustic] = useState<Map<number, Acoustic> | null>(null)
  const [current, setCurrent] = useState<number | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  /** What the arranger changed when a MIDI / MusicXML score was imported. */
  const [importNotes, setImportNotes] = useState<{ title: string; messages: string[] } | null>(null)

  useEffect(() => () => stopPlayback(), [])

  /** Switching songs discards the previous song's results and import banners. */
  const resetFor = <T,>(action: () => T): T => {
    stopPlayback()
    setAcoustic(null)
    setCurrent(null)
    setPhase('idle')
    setImportError(null)
    setImportNotes(null)
    return action()
  }

  const play = async () => {
    if (!song || !tuning || !listening) return
    const token = nextRun()
    setPhase('playing')
    // While another view's offline render builds, Tone's global context and transport are the
    // render's: nothing is created or scheduled until it has finished.
    await whenOfflineIdle()
    if (token !== run) return
    const kh = engine.morinKhuur()
    kh.tuning = tuning
    // Some styles repeat the tune until stopped (bii dance tunes end when the dancer stops).
    player.play(
      listening.events,
      kh,
      {
        onNote: setCurrent,
        onEnd: () => {
          setPhase('done')
          setCurrent(null)
        }
      },
      { loop: listening.loop }
    )
  }

  const autoTest = async () => {
    if (!report) return
    const token = nextRun()
    setPhase('testing')
    setProgress(0)
    await engine.resume()
    if (token !== run) return
    player.stop()
    const results = new Map<number, Acoustic>()
    const cache = new Map<string, PitchMeasurement>()
    // The notes as written, whatever style Listen uses: ornaments are not part of the test.
    for (const [i, e] of writtenEvents.entries()) {
      const check = report.checks[e.order]
      if (!check) continue
      if (!check.passed || !isPitchTestable(e.event)) {
        results.set(e.order, { status: 'n/a' })
      } else {
        const key = `${e.event.technique}|${e.event.string}|${e.event.freq!.toFixed(3)}`
        let m = cache.get(key)
        if (!m) {
          m = await measurePitch(e.event)
          // Stopped (or the view closed) while testing: the results are dropped.
          if (token !== run) return
          cache.set(key, m)
        }
        const cents = m.freq ? centsBetween(e.event.freq!, m.freq) : null
        const pass = cents !== null && Math.abs(cents) < PITCH_TOLERANCE_CENTS && m.confidence > 0.8
        results.set(e.order, { status: pass ? 'pass' : 'fail', measured: m.freq, cents })
      }
      setProgress((i + 1) / writtenEvents.length)
    }
    if (token !== run) return
    setAcoustic(results)
    await play()
  }

  const stop = () => {
    stopPlayback()
    setPhase('idle')
    setCurrent(null)
  }

  const importFromFile = async () => {
    setImportError(null)
    setImportNotes(null)
    let name: string | null = null
    try {
      const file = await openFile({ title: 'Import song or score', filters: SONG_FILE_FILTERS })
      if (!file) return
      name = file.name
      const { entry: imported, messages } = await importSongFile(file)
      // resetFor clears the previous song's banners; this import's are set after it.
      const saved = resetFor(() => importSong(imported))
      if (messages.length) setImportNotes({ title: imported.title, messages })
      if (!saved) setImportError(`“${imported.title}” is open for this session only: there is no room left to save it (remove imported songs you no longer need).`)
    } catch (e) {
      // Electron prefixes errors from the main process (e.g. a locked or unreadable file).
      const detail = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') : ''
      setImportError(name === null ? `Could not open the file${detail ? `: ${detail}` : '.'}` : detail || `Could not import ${name}.`)
    }
  }

  // Scores: static checks always; acoustic results once the auto-test has run.
  const noteOk = (c: NoteCheck, order: number) => c.passed && (acoustic ? acoustic.get(order)?.status !== 'fail' : true)
  const score = report && acoustic ? report.checks.filter((c, i) => noteOk(c, i)).length / Math.max(1, report.total) : null
  const measuredCents = acoustic ? [...acoustic.values()].flatMap((a) => (a.status !== 'n/a' && a.cents !== null ? [Math.abs(a.cents)] : [])) : []
  const meanCents = measuredCents.length ? measuredCents.reduce((a, b) => a + b, 0) / measuredCents.length : null
  const failed = new Set(report?.checks.filter((c, i) => !noteOk(c, i)).map((c) => c.note.index) ?? [])

  const currentCheck = current !== null ? (report?.checks[current] ?? null) : null
  const nextCheck = current !== null ? (report?.checks[current + 1] ?? null) : null
  const markers: FingerMarker[] = []
  const pushMarker = (c: NoteCheck | null, emphasis: FingerMarker['emphasis']) => {
    if (!c?.note.string || c.stop === null) return
    markers.push({ string: c.note.string, stop: c.stop, finger: c.note.finger, partial: c.note.technique === 'tsatsal_harmonic' ? c.partial : null, emphasis })
    if (c.note.technique === 'double_stop' && tuning) {
      const other = otherString(c.note.string)
      const drone = c.note.drone ?? (other === 'male' ? tuning.male : tuning.female)
      markers.push({ string: other, stop: drone - (other === 'male' ? tuning.male : tuning.female), finger: null, emphasis })
    }
  }
  pushMarker(currentCheck, 'now')
  pushMarker(nextCheck, 'next')

  const activity: InstrumentActivity | undefined = currentCheck?.note.string
    ? {
        stops: { male: 0, female: 0, [currentCheck.note.string]: currentCheck.stop ?? 0 },
        bowed: { male: false, female: false, [currentCheck.note.string]: currentCheck.note.bow !== null },
        activeString: currentCheck.note.string,
        direction: currentCheck.note.bow ?? 'tatakh'
      }
    : undefined

  const busy = phase === 'testing' || phase === 'playing'

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Top bar */}
      <div className="panel flex items-center gap-4 px-5 py-2">
        <div className="flex items-center gap-2">
          <select aria-label="Song" className="field h-11 w-80 text-[15px] narrow:w-64" value={entry?.id ?? ''} onChange={(e) => resetFor(() => select(e.target.value))} disabled={busy}>
            <optgroup label="Library">
              {entries
                .filter((e) => e.builtIn)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
            </optgroup>
            {imported.length > 0 && (
              <optgroup label="Imported">
                {imported.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <button type="button" className="btn btn-sm" onClick={() => void importFromFile()} disabled={busy} title="Import a song: .mkhuur.json, MIDI (.mid) or MusicXML (.musicxml / .mxl, e.g. exported from MuseScore) — scores are arranged for the morin khuur automatically">
            <FileUp className="h-4 w-4" /> Import
          </button>
          {entry && !entry.builtIn && (
            <button type="button" className="btn btn-sm" onClick={() => resetFor(() => removeImported(entry.id))} disabled={busy} aria-label="Remove imported song">
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => (busy ? stop() : void autoTest())}
          disabled={!song}
          className="ml-6 h-12 whitespace-nowrap rounded-xl border-2 border-bilag px-8 text-lg font-semibold narrow:ml-2 narrow:px-5 text-bilag shadow-[0_0_24px_rgb(246_169_48/0.35)] transition hover:bg-bilag/10 disabled:opacity-40"
        >
          {phase === 'testing' ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-5 w-5 animate-spin" /> Testing {Math.round(progress * 100)}%
            </span>
          ) : phase === 'playing' ? (
            <span className="flex items-center gap-2">
              <Square className="h-4 w-4 fill-current" /> Stop
            </span>
          ) : (
            'Auto-Test Play'
          )}
        </button>
        <button type="button" className="btn" onClick={() => (phase === 'playing' ? stop() : void play())} disabled={!song || phase === 'testing'} title="Play without testing">
          {phase === 'playing' ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />} Listen
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="text-muted hover:text-text disabled:opacity-40" onClick={() => setBpm(bpm - 2)} disabled={busy} aria-label="Slower">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="text-center">
            <div className="text-[11px] text-muted">BPM</div>
            <div className="text-2xl font-semibold tabular-nums">{bpm}</div>
          </div>
          <button type="button" className="text-muted hover:text-text disabled:opacity-40" onClick={() => setBpm(bpm + 2)} disabled={busy} aria-label="Faster">
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
        <AccuracyGauge value={score} label="Accuracy" sub={meanCents !== null ? `±${meanCents.toFixed(1)}¢ mean pitch error` : 'run Auto-Test'} />
      </div>

      {importError && <div className="rounded-lg border border-rec/60 bg-rec/10 px-4 py-2 text-sm text-rec">{importError}</div>}
      {importNotes && (
        <div className="flex items-start gap-3 rounded-lg border border-line-2 bg-panel-2 px-4 py-2 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">Arranged “{importNotes.title}” for the morin khuur</div>
            <ul className="mt-1 max-h-24 list-disc overflow-auto pl-5 text-muted">
              {importNotes.messages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
          <button type="button" className="text-muted hover:text-text" onClick={() => setImportNotes(null)} aria-label="Dismiss import notes">
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Notation */}
      <div className="panel max-h-[34%] overflow-auto px-5 py-3">
        {song ? (
          <>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3">
              <h2 className="text-lg font-semibold">{song.title}</h2>
              {song.composer && <span className="text-sm text-muted">{song.composer}</span>}
              <span className="text-xs text-faint">
                {song.timeSignature.beats}/{song.timeSignature.unit} · tuning {prettyNoteName(midiToName(song.tuning.male))}–{prettyNoteName(midiToName(song.tuning.female))}
                {song.keyPc !== null ? ` · 1 = ${prettyNoteName(pitchClassName(song.keyPc))}` : ''}
              </span>
              <NotationToggle value={notation} onChange={setNotation} />
            </div>
            {notation !== 'staff' && <JianpuView measures={measures} current={currentCheck?.note.index ?? null} failed={failed} />}
            {notation !== 'jianpu' && (
              <div className={notation === 'both' ? 'mt-4' : ''}>
                <StaffView song={song} current={currentCheck?.note.index ?? null} failed={failed} />
              </div>
            )}
            {song.source && <p className="mt-3 text-[11px] text-faint">{song.source}</p>}
          </>
        ) : (
          <p className="text-sm text-rec">This file could not be read as a song.</p>
        )}
      </div>

      {/* Instrument + report */}
      <div className="grid min-h-0 flex-1 grid-cols-[1fr_380px] gap-3">
        <div className="relative flex min-h-0 flex-col rounded-2xl" style={{ background: 'radial-gradient(ellipse at 50% 45%, #2a2019 0%, #15110e 60%, #0e0c0a 100%)' }}>
          {tuning && (
            <InstrumentView className="min-h-0 flex-1" tuning={tuning} markers={markers} activity={activity} levels={() => engine.morinKhuur().levels()} />
          )}
          <div className="flex items-center justify-center gap-8 px-4 pb-3 narrow:gap-5">
            <BowIndicator check={currentCheck} />
            <StyleControls song={song} style={style} amount={ornamentAmount} disabled={busy} onStyle={setStyle} onAmount={setOrnamentAmount} />
          </div>
        </div>
        <ReportPanel
          parseIssues={loaded?.parseIssues ?? []}
          checks={report?.checks ?? []}
          songIssues={report?.songIssues ?? []}
          acoustic={acoustic}
          current={current}
          onSelect={setCurrent}
        />
      </div>
    </div>
  )
}

const NOTATION_MODES: readonly { value: NotationMode; label: string }[] = [
  { value: 'jianpu', label: 'Jianpu' },
  { value: 'staff', label: 'Staff' },
  { value: 'both', label: 'Both' }
]

function NotationToggle({ value, onChange }: { value: NotationMode; onChange(mode: NotationMode): void }) {
  return (
    <div role="group" aria-label="Notation" className="ml-auto flex self-center rounded-lg border border-line-2 bg-panel p-0.5 text-[11px] font-semibold">
      {NOTATION_MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          aria-pressed={value === m.value}
          onClick={() => onChange(m.value)}
          className={`rounded-md px-2.5 py-1 transition-colors ${value === m.value ? 'bg-panel-3 text-text' : 'text-muted hover:text-text'}`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/**
 * Playing style for Listen: "Auto" follows the song (its `style`, else its genre); "As written"
 * adds nothing. The ornament amount scales how often the style ornaments (1 = its own density).
 */
function StyleControls({
  song,
  style,
  amount,
  disabled,
  onStyle,
  onAmount
}: {
  song: Song | null
  style: StyleChoice
  amount: number
  disabled: boolean
  onStyle(style: StyleChoice): void
  onAmount(amount: number): void
}) {
  const resolved = song ? resolveStyle(song) : null
  const effective = style === 'auto' ? resolved : style
  const description = effective ? STYLES.find((s) => s.id === effective)?.description : undefined
  return (
    <div className="flex w-56 shrink-0 flex-col gap-1 narrow:w-48">
      <select
        aria-label="Playing style"
        title={description ? `Playing style: ${description} The auto-test always plays the notes as written.` : 'Playing style'}
        className="field h-8 pr-7 text-xs short:h-7"
        value={style}
        onChange={(e) => onStyle(e.target.value as StyleChoice)}
        disabled={disabled}
      >
        <option value="auto">Auto ({resolved ? styleName(resolved) : '—'})</option>
        {STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-[11px] text-muted" title="How often the style adds ornaments (1× = its own density)">
        Ornaments
        <input
          type="range"
          min={ORNAMENT_AMOUNT.min}
          max={ORNAMENT_AMOUNT.max}
          step={ORNAMENT_AMOUNT.step}
          value={amount}
          onChange={(e) => onAmount(Number(e.target.value))}
          disabled={disabled || effective === 'as-written'}
          aria-label="Ornament amount"
          className="min-w-0 flex-1 accent-[var(--color-bilag)] disabled:opacity-40"
        />
        <span className="w-8 text-right tabular-nums">{amount.toFixed(1)}×</span>
      </label>
    </div>
  )
}

function BowIndicator({ check }: { check: NoteCheck | null }) {
  const bow = check?.note.bow ?? null
  const technique = check ? TECHNIQUES[check.note.technique] : null
  const color = bow === 'tatakh' ? 'var(--color-arga)' : 'var(--color-bilag)'
  const flip = bow ? SCREEN_DIRECTION[bow] < 0 : false
  return (
    <div className="flex items-center text-sm">
      <div className="flex items-center gap-3">
        <svg width="220" height="34" viewBox="0 0 220 34" aria-hidden>
          <path d="M10 18 Q110 6 205 16" fill="none" stroke="#6b3a1c" strokeWidth="5" strokeLinecap="round" />
          <line x1="12" y1="25" x2="200" y2="25" stroke="#efe6d2" strokeWidth="2" />
          <rect x="182" y="12" width="26" height="16" rx="3" fill="#22150c" stroke="#caa77a" />
          {bow && (
            <path
              d={flip ? 'M150 8 L70 8 M82 1 L70 8 L82 15' : 'M70 8 L150 8 M138 1 L150 8 L138 15'}
              fill="none"
              stroke={color}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
        <div className="w-40">
          <div className="font-semibold" style={{ color: bow ? color : 'var(--color-muted)' }}>
            {bow ? `${BOW_INFO[bow].name} (${BOW_INFO[bow].english.toLowerCase()})` : technique ? 'No bow' : 'Bow visualizer'}
          </div>
          <div className="text-xs text-muted">
            {technique ? `${technique.name}${technique.mongolian ? ` · ${technique.mongolian}` : ''}` : 'Press Auto-Test Play'}
          </div>
        </div>
      </div>
    </div>
  )
}

function IssueIcon({ severity }: { severity: Issue['severity'] }) {
  if (severity === 'error') return <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rec" />
  if (severity === 'warning') return <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f6c945]" />
  return <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
}

function ReportPanel({
  parseIssues,
  songIssues,
  checks,
  acoustic,
  current,
  onSelect
}: {
  parseIssues: Issue[]
  songIssues: Issue[]
  checks: NoteCheck[]
  acoustic: Map<number, Acoustic> | null
  current: number | null
  onSelect(order: number): void
}) {
  const errors = [...parseIssues, ...songIssues, ...checks.flatMap((c) => c.issues)].filter((i) => i.severity === 'error').length
  const warnings = [...parseIssues, ...songIssues, ...checks.flatMap((c) => c.issues)].filter((i) => i.severity === 'warning').length
  return (
    <div className="panel flex min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="panel-title">Verification report</span>
        <span className="text-xs text-muted">
          <span className={errors ? 'text-rec' : ''}>{errors} errors</span> · <span className={warnings ? 'text-[#f6c945]' : ''}>{warnings} warnings</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2 text-xs">
        {[...parseIssues, ...songIssues].map((i, k) => (
          <div key={`s${k}`} className="flex gap-2 px-2 py-1">
            <IssueIcon severity={i.severity} />
            <span>{i.message}</span>
          </div>
        ))}
        {checks.map((c, order) => {
          const a = acoustic?.get(order)
          const ok = c.passed && a?.status !== 'fail'
          const pitch = c.note.pitch !== null ? prettyNoteName(midiToName(c.note.pitch)) : '—'
          return (
            <button
              key={c.note.index}
              type="button"
              onClick={() => onSelect(order)}
              className={`block w-full rounded-md px-2 py-1.5 text-left hover:bg-panel-3 ${current === order ? 'bg-panel-3' : ''}`}
            >
              <div className="flex items-center gap-2">
                {ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-go" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-rec" />}
                <span className="w-7 tabular-nums text-faint">#{c.note.index + 1}</span>
                <span className="w-10 font-semibold">{pitch}</span>
                <span className="flex-1 truncate text-muted">
                  {TECHNIQUES[c.note.technique].name}
                  {c.contactMm !== null ? ` · ${c.contactMm.toFixed(0)} mm` : ''}
                </span>
                {a && a.status !== 'n/a' && (
                  <span className={`tabular-nums ${a.status === 'pass' ? 'text-go' : 'text-rec'}`}>
                    {a.cents === null ? 'no pitch' : `${a.cents >= 0 ? '+' : ''}${a.cents.toFixed(1)}¢`}
                  </span>
                )}
              </div>
              {c.issues.map((i, k) => (
                <div key={k} className="ml-6 mt-0.5 flex gap-1.5 text-muted">
                  <IssueIcon severity={i.severity} />
                  <span>{i.message}</span>
                </div>
              ))}
            </button>
          )
        })}
      </div>
    </div>
  )
}
