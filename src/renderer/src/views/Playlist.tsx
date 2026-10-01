import { ArrowLeftRight, AudioLines, Download, ExternalLink, FileAudio, FileUp, Info, ListMusic, Loader2, Play, SkipForward, Square, Star, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { engine } from '@renderer/audio/engine'
import {
  AbPlayer,
  cancelQueuedRenders,
  compareWithOriginal,
  excerptGain,
  firstNoteAt,
  melodySpan,
  ourEvents,
  REFERENCE_AUDIO_FILTERS,
  references,
  RENDER_LEAD_IN,
  renderOurVersion,
  STYLE_RENDERING,
  whenRendersIdle,
  type OurVersion,
  type ReferenceSlot,
  type RenderOptions
} from '@renderer/audio/reference'
import { eventsDuration, SongPlayer } from '@renderer/audio/song-player'
import { BlindTest } from '@renderer/components/BlindTest'
import { ComparisonReport } from '@renderer/components/ComparisonReport'
import { Kbd } from '@renderer/components/controls'
import { midiToName, prettyNoteName } from '@renderer/core/pitch'
import type { Song, VerificationReport } from '@renderer/core/notation'
import { STYLES } from '@renderer/core/performance'
import type { StyleId } from '@renderer/core/performance/types'
import {
  EMPTY_FEEDBACK,
  excerptWindow,
  KIND_INFO,
  mapAbPosition,
  parseSeconds,
  PLAYLIST,
  playableQueue,
  REFERENCE_KIND_INFO,
  REFERENCE_KINDS,
  resolveSong,
  RIGHTS_INFO,
  styleName,
  type BlindAnswer,
  type BlindMode,
  type BlindSource,
  type CompareRoom,
  type EntryFeedback,
  type PlaylistEntry,
  type PlaylistRights,
  type ReferenceKind,
  type SongSource
} from '@renderer/core/playlist'
import { isTechniqueId, TECHNIQUES } from '@renderer/core/techniques'
import { useKeyboard } from '@renderer/hooks'
import { importSongFile, SONG_FILE_FILTERS } from '@renderer/importing'
import { memoLast } from '@renderer/memo'
import { openExternal, openFile } from '@renderer/platform'
import { loadSong, type LibraryEntry } from '@renderer/songs'
import { exportFeedback, feedbackSaveFailed, onFeedbackSaveChange, usePlaylist } from '@renderer/state/playlist'
import { useSettings } from '@renderer/state/settings'
import { allSongs, useSongs } from '@renderer/state/songs'

const player = new SongPlayer()
const ab = new AbPlayer()
/** Pause between pieces in Play all (half of it between an original and ours). */
const GAP_MS = 1200
const NO_RECORDING: ReferenceSlot = { status: 'none' }
/** Blind excerpts fade in and out, so a cut does not give a version away. */
const BLIND_FADE = { in: 0.15, out: 0.3 }

/** Bumped by every stop and every new playback; async playback sequences end when it changes. */
let run = 0
let endLive: ((ended: boolean) => void) | null = null
/** The comparison in progress; aborted when the view closes. */
let comparison: AbortController | null = null

function stopPlayback(): void {
  run++
  endLive?.(false)
  endLive = null
  player.stop()
  ab.stop()
}

/** Stops a blind-test excerpt, and nothing else. */
function stopBlind(): void {
  if (ab.side() === 'blind') stopPlayback()
}

/** Starts tracking a new comparison, aborting any earlier one. */
function beginComparison(): AbortController {
  comparison?.abort()
  comparison = new AbortController()
  return comparison
}

function endComparison(controller: AbortController): void {
  if (comparison === controller) comparison = null
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const spanSeconds = ({ start, end }: { start: number; end: number }) => Math.max(0, end - start)

interface Playable {
  song: Song
  report: VerificationReport
}

const eventsFor = memoLast((song: Song, report: VerificationReport, style: StyleId | null) => ourEvents(song, report, style))

function playableOf(source: SongSource, library: readonly LibraryEntry[]): Playable | null {
  if (source.kind === 'missing') return null
  const raw = library.find((s) => s.id === source.songId)?.raw
  const loaded = raw === undefined ? null : loadSong(raw)
  return loaded?.song && loaded.report ? { song: loaded.song, report: loaded.report } : null
}

/** The entry's song from the stores' current state (for playback sequences that outlive a render). */
function latestPlayable(entry: PlaylistEntry): Playable | null {
  const library = allSongs(useSongs.getState().imported)
  return playableOf(resolveSong(entry, usePlaylist.getState().feedback[entry.id]?.link, library), library)
}

function latestQueue(): string[] {
  const library = allSongs(useSongs.getState().imported)
  const { feedback } = usePlaylist.getState()
  return playableQueue(PLAYLIST, (e) => resolveSong(e, feedback[e.id]?.link, library))
}

/** The style our version of `entry` plays in (null while renders cannot take a style). */
const styleOf = (entry: PlaylistEntry, f: Partial<EntryFeedback> | undefined): StyleId | null => (STYLE_RENDERING ? (f?.style ?? entry.style) : null)

/** Plays a song live on the shared instrument (tuning from the song); resolves true at its end, false when stopped. */
function playLive({ song, report }: Playable, style: StyleId | null, onProgress: (fraction: number) => void): Promise<boolean> {
  endLive?.(false)
  return new Promise((resolve) => {
    const events = ourEvents(song, report, style)
    const notes = events.filter((e) => e.order >= 0).length
    const kh = engine.morinKhuur()
    kh.tuning = { id: 'song', name: '', male: song.tuning.male, female: song.tuning.female, scaleTonic: 0 }
    const finish = (ended: boolean) => {
      if (endLive !== finish) return
      endLive = null
      resolve(ended)
    }
    endLive = finish
    player.play(events, kh, { onNote: (order) => order >= 0 && onProgress((order + 1) / Math.max(1, notes)), onEnd: () => finish(true) })
  })
}

const renderOptions = (room: CompareRoom, style: StyleId | null): RenderOptions => ({ room, soundboard: useSettings.getState().soundboard, vibratoCents: engine.morinKhuur().vibratoCents, style })

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const errorText = (e: unknown) => (e instanceof Error && e.message ? `: ${e.message}` : '.')

type NowPlaying = { entryId: string; what: 'original' | 'ours' | 'live' | 'preparing'; all: boolean }

export function Playlist() {
  const {
    feedback,
    selectedId,
    select,
    compareRoom,
    setCompareRoom,
    withOriginals,
    setWithOriginals,
    blindStyles,
    setBlindStyles,
    link,
    setRating,
    setNotes,
    saveComparison,
    setOriginalStart,
    setExcerptLength,
    setReferenceKind,
    setStyle,
    addBlindAnswer,
    clearBlindAnswers
  } = usePlaylist()
  const { imported, importSong } = useSongs()
  const library = allSongs(imported)
  const recordings = useSyncExternalStore(references.subscribe, references.snapshot)
  const abSide = useSyncExternalStore(ab.subscribe, ab.side)
  const saveFailed = useSyncExternalStore(onFeedbackSaveChange, feedbackSaveFailed)

  const entry = PLAYLIST.find((e) => e.id === selectedId) ?? PLAYLIST[0]
  const entryId = entry?.id ?? ''
  const sourceOf = (e: PlaylistEntry) => resolveSong(e, feedback[e.id]?.link, library)
  const source: SongSource = entry ? sourceOf(entry) : { kind: 'missing' }
  const playable = playableOf(source, library)
  const fb = { ...EMPTY_FEEDBACK, ...feedback[entryId] }
  const style = entry ? styleOf(entry, fb) : null
  const referenceKind: ReferenceKind = fb.referenceKind ?? entry?.referenceKind ?? 'fiddle'
  const slot = recordings.slots.get(entryId) ?? NO_RECORDING
  const result = recordings.results.get(entryId) ?? null
  const queue = playableQueue(PLAYLIST, sourceOf)
  const events = playable ? eventsFor(playable.song, playable.report, style) : null
  const ourSeconds = events ? eventsDuration(events) : null
  /** Seconds of our melody (without framing strokes): what a comparison sets against the original. */
  const melodyLength = events ? spanSeconds(melodySpan(events)) : null

  const [now, setNow] = useState<NowPlaying | null>(null)
  const [progress, setProgress] = useState(0)
  const [comparing, setComparing] = useState<{ entryId: string; label: string; fraction: number } | null>(null)
  const [message, setMessage] = useState<{ error: boolean; text: string; details?: string[] } | null>(null)

  useEffect(
    () => () => {
      // Leaving the view: nothing more is rendered for it (other views render offline too).
      stopPlayback()
      comparison?.abort()
      cancelQueuedRenders()
    },
    []
  )
  useEffect(() => void references.scan(), [])
  // A saved recording is decoded when its entry is selected (again, if it was evicted from memory).
  const needsRestore = slot.status === 'none' && recordings.stored.has(entryId)
  useEffect(() => void references.restore(entryId), [entryId, needsRestore])

  const stop = () => {
    stopPlayback()
    setNow(null)
  }

  const selectEntry = (id: string) => {
    stopBlind()
    select(id)
  }

  /** Plays one entry live, or every playable entry from the first (each original first, when loaded and enabled). */
  const playEntries = async (startId: string, all: boolean) => {
    stopPlayback()
    const token = run
    setMessage(null)
    await engine.resume()
    await whenRendersIdle()
    const ids = all ? latestQueue() : [startId]
    for (const id of ids.slice(Math.max(0, ids.indexOf(startId)))) {
      if (token !== run) return
      const e = PLAYLIST.find((p) => p.id === id)
      const piece = e ? latestPlayable(e) : null
      if (!e || !piece) continue
      if (all) usePlaylist.getState().select(id)
      const f = usePlaylist.getState().feedback[id]
      const pieceStyle = styleOf(e, f)
      let heardOriginal = false
      if (all && usePlaylist.getState().withOriginals) {
        await references.restore(id)
        const rec = references.get(id)
        if (token !== run) return
        // Both versions through the A/B path at the same loudness; ours is rendered first so
        // nothing is built while the original plays (live playback is the fallback).
        let ours: OurVersion | null = null
        if (rec.status === 'ready') {
          setNow({ entryId: id, what: 'preparing', all })
          ours = await renderOurVersion(piece.song, piece.report, renderOptions(usePlaylist.getState().compareRoom, pieceStyle)).catch(() => null)
          if (token !== run) return
        }
        if (rec.status === 'ready' && ours) {
          // The window a comparison uses: as long as our melody, from the original's melody start.
          const melody = spanSeconds(melodySpan(ourEvents(piece.song, piece.report, pieceStyle)))
          const excerpt = excerptWindow(rec.audio.buffer.duration, f?.originalStart ?? 0, melody, f?.excerptLength ?? null)
          const masterDb = useSettings.getState().masterDb
          await whenRendersIdle()
          if (token !== run) return
          setNow({ entryId: id, what: 'original', all })
          await ab.play('original', rec.audio.buffer, { gain: rec.audio.gain, offset: excerpt.start, duration: excerpt.duration, masterDb })
          if (token !== run) return
          await wait(GAP_MS / 2)
          // Another view may have started a render while the original played.
          await whenRendersIdle()
          if (token !== run) return
          setNow({ entryId: id, what: 'ours', all })
          await ab.play('ours', ours.buffer, { gain: ours.gain, masterDb })
          heardOriginal = true
        }
      }
      if (!heardOriginal) {
        await whenRendersIdle()
        if (token !== run) return
        setNow({ entryId: id, what: 'live', all })
        setProgress(0)
        await playLive(piece, pieceStyle, setProgress)
      }
      if (token !== run) return
      if (all) await wait(GAP_MS)
    }
    if (token === run) setNow(null)
  }

  /**
   * A/B: plays the original recording (it needs no score) or our rendered version (it does) from
   * `offset`, by default the melody's start.
   */
  const listen = async (side: 'original' | 'ours', offset?: number) => {
    if (!entry) return
    if (side === 'original' ? slot.status !== 'ready' : !playable) return
    stopPlayback()
    const token = run
    setMessage(null)
    await engine.resume()
    const masterDb = useSettings.getState().masterDb
    if (side === 'original') {
      if (slot.status !== 'ready') return
      await whenRendersIdle()
      if (token !== run) return
      setNow({ entryId, what: 'original', all: false })
      await ab.play('original', slot.audio.buffer, { gain: slot.audio.gain, offset: offset ?? fb.originalStart, masterDb })
    } else if (playable) {
      setNow({ entryId, what: 'preparing', all: false })
      try {
        const ours = await renderOurVersion(playable.song, playable.report, renderOptions(compareRoom, style))
        await whenRendersIdle()
        if (token !== run) return
        setNow({ entryId, what: 'ours', all: false })
        await ab.play('ours', ours.buffer, { gain: ours.gain, offset: offset ?? 0, masterDb })
      } catch (e) {
        if (token === run) setMessage({ error: true, text: `Could not render our version${errorText(e)}` })
      }
    }
    if (token === run) setNow(null)
  }

  /** Switches between the original and ours at the same point of the melody. */
  const switchAb = () => {
    const side = ab.side()
    if ((side !== 'original' && side !== 'ours') || !playable || !events || slot.status !== 'ready') return
    // Ours: where its first score note is scheduled (after any opening frame strokes). The
    // original: its detected first note when this session's comparison used the current score and
    // melody start; otherwise where the melody is meant to start.
    const measured = result?.song === playable.song && result.excerpt.start === fb.originalStart ? result : null
    const originalOnset = measured ? measured.excerpt.start + (measured.ref.notes[0]?.start ?? 0) : fb.originalStart
    const oursOnset = RENDER_LEAD_IN + firstNoteAt(events)
    const position = ab.position
    if (side === 'original') void listen('ours', mapAbPosition(position, originalOnset, oursOnset, Infinity))
    else void listen('original', mapAbPosition(position, oursOnset, originalOnset, slot.audio.buffer.duration))
  }

  const compare = async () => {
    if (!entry || !playable || slot.status !== 'ready') return
    stop()
    setMessage(null)
    const id = entry.id
    setComparing({ entryId: id, label: 'Starting…', fraction: 0 })
    const controller = beginComparison()
    try {
      const r = await compareWithOriginal(playable.song, playable.report, slot.audio, {
        ...renderOptions(compareRoom, style),
        start: fb.originalStart,
        length: fb.excerptLength,
        referenceKind,
        signal: controller.signal,
        onProgress: (label, fraction) => setComparing({ entryId: id, label, fraction })
      })
      references.setResult(id, r)
      saveComparison(id, {
        at: new Date().toISOString(),
        referenceName: r.referenceName,
        room: r.room,
        referenceKind: r.referenceKind,
        style: r.style,
        excerpt: r.excerpt,
        score: r.comparison.score,
        rows: r.comparison.rows
      })
    } catch (e) {
      if (!controller.signal.aborted) setMessage({ error: true, text: `The comparison failed${errorText(e)}` })
    } finally {
      endComparison(controller)
      setComparing(null)
    }
  }

  // Blind listening test -------------------------------------------------------------------

  /** Style of our version for a blind source ('original' has none). */
  const blindStyle = (s: BlindSource): StyleId | null => (s === 'original' ? null : s === 'ours' ? style : s)

  const blindUnavailable: Record<BlindMode, string | null> = {
    'ours-vs-original': !playable
      ? 'Needs a score for this piece: import one above.'
      : slot.status !== 'ready'
        ? 'Needs an original recording: load one above.'
        : referenceKind !== 'fiddle'
          ? `The original is set to “${REFERENCE_KIND_INFO[referenceKind].label}”: a blind test against it needs a morin khuur recording.`
          : null,
    'style-vs-style': !playable ? 'Needs a score for this piece: import one above.' : null
  }

  /** Seconds of melody that every source of a trial has, from its melody start. */
  const blindMelodySeconds = (sources: readonly BlindSource[]): number => {
    if (!playable) return 0
    let seconds = Infinity
    for (const s of sources) {
      if (s === 'original') {
        if (slot.status === 'ready') seconds = Math.min(seconds, slot.audio.buffer.duration - fb.originalStart)
        continue
      }
      // Up to our last score note: a closing frame is not part of the melody.
      seconds = Math.min(seconds, spanSeconds(melodySpan(ourEvents(playable.song, playable.report, blindStyle(s)))))
    }
    return Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  }

  const prepareBlind = async (sources: readonly BlindSource[]): Promise<boolean> => {
    if (!playable) return false
    stop()
    setMessage(null)
    try {
      for (const s of sources) if (s !== 'original') await renderOurVersion(playable.song, playable.report, renderOptions(compareRoom, blindStyle(s)))
      return true
    } catch (e) {
      setMessage({ error: true, text: `Could not prepare the blind trial${errorText(e)}` })
      return false
    }
  }

  const playBlind = async (s: BlindSource, excerpt: { at: number; seconds: number }): Promise<boolean> => {
    if (!playable) return false
    stop()
    const token = run
    await engine.resume()
    let buffer: AudioBuffer | OurVersion['buffer']
    let offset: number
    if (s === 'original') {
      if (slot.status !== 'ready') return false
      buffer = slot.audio.buffer
      offset = fb.originalStart + excerpt.at
    } else {
      // Rendered (and cached) when the trial was prepared; rendered again if it was evicted since,
      // and that render can be cancelled (leaving the view) or fail.
      let ours: OurVersion
      try {
        ours = await renderOurVersion(playable.song, playable.report, renderOptions(compareRoom, blindStyle(s)))
      } catch (e) {
        if (token === run) setMessage({ error: true, text: `Could not render the excerpt${errorText(e)}` })
        return false
      }
      buffer = ours.buffer
      offset = ours.onset + excerpt.at
    }
    await whenRendersIdle()
    if (token !== run) return false
    return ab.play('blind', buffer, { gain: excerptGain(buffer, offset, excerpt.seconds), offset, duration: excerpt.seconds, masterDb: useSettings.getState().masterDb, fade: BLIND_FADE })
  }

  const answerBlind = (answer: Pick<BlindAnswer, 'mode' | 'order' | 'excerpt' | 'moreReal' | 'guessedOurs'>) => {
    const withOriginal = answer.mode === 'ours-vs-original'
    addBlindAnswer(entryId, {
      ...answer,
      at: new Date().toISOString(),
      oursStyle: withOriginal ? style : null,
      referenceName: withOriginal && slot.status === 'ready' ? slot.audio.name : null,
      room: compareRoom
    })
  }

  // -------------------------------------------------------------------------------------------

  const importScore = async (e: PlaylistEntry) => {
    setMessage(null)
    let name: string | null = null
    try {
      const file = await openFile({ title: `Import a score for “${e.titleLatin}”`, filters: SONG_FILE_FILTERS })
      if (!file) return
      name = file.name
      const { entry: song, messages } = await importSongFile(file)
      const saved = importSong(song)
      link(e.id, song.id)
      selectEntry(e.id)
      const details = saved ? messages : [...messages, 'There is no room left to save it: it is linked for this session only.']
      if (details.length) setMessage({ error: false, text: `Arranged “${song.title}” for the morin khuur and linked it to ${e.titleLatin}`, details })
    } catch (err) {
      // Electron prefixes errors from the main process (e.g. a locked or unreadable file).
      const detail = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') : ''
      setMessage({ error: true, text: name === null ? `Could not open the file${detail ? `: ${detail}` : '.'}` : detail || `Could not import ${name}.` })
    }
  }

  const loadOriginal = async (e: PlaylistEntry) => {
    setMessage(null)
    try {
      const file = await openFile({ title: `Original recording of “${e.titleLatin}”`, filters: REFERENCE_AUDIO_FILTERS })
      if (!file) return
      if (now?.entryId === e.id || ab.side() === 'blind') stop()
      await references.load(e.id, file)
    } catch (err) {
      const detail = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '') : ''
      setMessage({ error: true, text: `Could not open the recording${detail ? `: ${detail}` : '.'}` })
    }
  }

  const exportReport = async () => {
    try {
      await exportFeedback({ settings: { 'song vibrato (cents)': engine.morinKhuur().vibratoCents } })
    } catch (e) {
      setMessage({ error: true, text: `Could not save the feedback${errorText(e)}` })
    }
  }

  useKeyboard({
    down: (e) => {
      if (e.code === 'Space') {
        if (now || abSide) stop()
        else if (playable && !comparing) void playEntries(entryId, false)
        return true
      }
      if (e.code === 'KeyT' && (abSide === 'original' || abSide === 'ours')) {
        switchAb()
        return true
      }
      return false
    }
  })

  const nowEntry = now ? PLAYLIST.find((e) => e.id === now.entryId) : undefined
  const busy = comparing !== null
  const recordingReady = slot.status === 'ready'
  const excerpt = slot.status === 'ready' ? excerptWindow(slot.audio.buffer.duration, fb.originalStart, melodyLength ?? slot.audio.buffer.duration, fb.excerptLength) : null

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      {/* Transport */}
      <div className="panel flex items-center gap-4 px-5 py-2.5 narrow:gap-3">
        <div className="flex items-center gap-3">
          <ListMusic className="h-6 w-6 text-bilag" />
          <div>
            <div className="text-lg font-semibold leading-tight">Playlist</div>
            <div className="text-[11px] text-muted narrow:hidden">Our morin khuur next to original recordings</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" className="btn" onClick={() => (now && !now.all ? stop() : void playEntries(entryId, false))} disabled={!playable || busy} title="Play our version of the selected piece">
            {now && !now.all ? <Square className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-go text-go" />}
            {now && !now.all ? 'Stop' : 'Play ours'}
            <Kbd hideWhenNarrow>Space</Kbd>
          </button>
          <button
            type="button"
            className="btn"
            data-on={now?.all ?? false}
            onClick={() => (now?.all ? stop() : void playEntries(queue[0] ?? '', true))}
            disabled={!queue.length || busy}
            title="Play every playable piece in order"
          >
            {now?.all ? <Square className="h-4 w-4 fill-current" /> : <SkipForward className="h-4 w-4" />}
            {now?.all ? 'Stop' : 'Play all'}
          </button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted" title="In Play all, play each piece’s original recording (when you have loaded one) before our version">
          <input type="checkbox" checked={withOriginals} onChange={(e) => setWithOriginals(e.target.checked)} className="accent-[var(--color-bilag)]" />
          Original first
        </label>
        <div className="lcd flex min-w-0 flex-1 items-center gap-3 px-4 py-1.5">
          {now && nowEntry ? (
            <>
              {now.what === 'preparing' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" /> : <AudioLines className={`h-4 w-4 shrink-0 ${now.what === 'original' ? 'text-arga' : 'text-bilag'}`} />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{nowEntry.titleMn}</div>
                <div className="truncate text-[11px] text-muted">
                  {now.what === 'original' ? 'Original recording' : now.what === 'preparing' ? 'Rendering our version…' : 'Our version'}
                  {now.all ? ` · ${queue.indexOf(now.entryId) + 1} of ${queue.length}` : ''}
                </div>
              </div>
              {now.what === 'live' && (
                <div className="h-1 w-24 overflow-hidden rounded-full bg-panel-3">
                  <div className="h-full bg-bilag" style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
              )}
            </>
          ) : abSide === 'blind' && entry ? (
            <>
              <AudioLines className="h-4 w-4 shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{entry.titleMn}</div>
                <div className="truncate text-[11px] text-muted">Blind listening test</div>
              </div>
            </>
          ) : (
            <span className="text-xs text-faint">Nothing playing</span>
          )}
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void exportReport()} title="Save your ratings, notes, comparisons and blind-test answers to send to the developer">
          <Download className="h-4 w-4" /> Export feedback
        </button>
      </div>

      {message && (
        <div className={`flex items-start gap-3 rounded-lg border px-4 py-2 text-sm ${message.error ? 'border-rec/60 bg-rec/10 text-rec' : 'border-line-2 bg-panel-2'}`}>
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{message.text}</div>
            {message.details && (
              <ul className="mt-1 max-h-24 list-disc overflow-auto pl-5 text-muted">
                {message.details.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            )}
          </div>
          <button type="button" className="text-muted hover:text-text" onClick={() => setMessage(null)} aria-label="Dismiss">
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)] gap-3 narrow:grid-cols-[300px_minmax(0,1fr)]">
        {/* Entries */}
        <div className="panel flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="panel-title">Pieces</span>
            <span className="text-xs text-muted">
              {queue.length} of {PLAYLIST.length} playable
            </span>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto p-2">
            {PLAYLIST.map((e, i) => {
              const src = sourceOf(e)
              const f = feedback[e.id]
              const selected = e.id === entryId
              const playing = now?.entryId === e.id
              const hasRecording = recordings.stored.has(e.id) || recordings.slots.get(e.id)?.status === 'ready'
              return (
                <li
                  key={e.id}
                  className={`mb-1 rounded-xl border transition-colors ${selected ? 'border-line-2 bg-panel-3' : 'border-transparent hover:bg-panel-2'} ${playing ? 'shadow-[0_0_0_1px_var(--color-bilag),0_0_18px_rgb(246_169_48/0.25)]' : ''}`}
                >
                  <button type="button" onClick={() => selectEntry(e.id)} aria-current={selected ? 'true' : undefined} className="block w-full px-3 pb-1 pt-2.5 text-left">
                    <div className="flex items-center gap-2">
                      {playing ? <AudioLines className="h-4 w-4 shrink-0 text-bilag" /> : <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-faint">{i + 1}</span>}
                      <span className="min-w-0 flex-1 truncate font-semibold">{e.titleMn}</span>
                      <RightsBadge rights={e.rights} />
                    </div>
                    <div className="ml-6 truncate text-xs text-muted">
                      {e.titleLatin} · {KIND_INFO[e.kind].label}
                    </div>
                    <div className="ml-6 truncate text-[11px] text-faint">{e.composer}</div>
                  </button>
                  <div className="ml-6 flex items-center gap-2 px-3 pb-2 text-[11px]">
                    <SourceChip source={src} library={library} />
                    {src.kind === 'missing' && (
                      <button type="button" className="btn btn-sm h-7" onClick={() => void importScore(e)} disabled={busy}>
                        <FileUp className="h-3.5 w-3.5" /> Import score…
                      </button>
                    )}
                    <span className="ml-auto flex items-center gap-2 text-faint">
                      {hasRecording && <FileAudio className="h-3.5 w-3.5 text-arga" aria-label="Original recording loaded" />}
                      {f?.rating != null && (
                        <span className="text-bilag" aria-label={`Rated ${f.rating} of 5`}>
                          {'★'.repeat(f.rating)}
                        </span>
                      )}
                      {f?.comparison?.score != null && <span className="tabular-nums">{Math.round(f.comparison.score * 100)}%</span>}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

        {/* Selected entry */}
        {entry && (
          <div className="panel flex min-h-0 flex-col">
            <div className="border-b border-line px-5 py-3">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 className="text-xl font-semibold">{entry.titleMn}</h2>
                <span className="text-sm text-muted">{entry.titleLatin}</span>
                <RightsBadge rights={entry.rights} />
              </div>
              <div className="mt-0.5 text-xs text-faint">
                {KIND_INFO[entry.kind].label} ({KIND_INFO[entry.kind].mongolian}) · {entry.composer}
              </div>
              {entry.notes && <p className="mt-1.5 text-xs text-muted">{entry.notes}</p>}
              {entry.techniques.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {entry.techniques.map((t) => (
                    <span key={t} className="rounded-full border border-line-2 px-2 py-0.5 text-[11px] text-muted">
                      {isTechniqueId(t) ? TECHNIQUES[t].name : t}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
              <div className="grid grid-cols-2 gap-3">
                <Section title="Score">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <SourceChip source={source} library={library} />
                    <button type="button" className="btn btn-sm" onClick={() => void importScore(entry)} disabled={busy} title="Import a .mkhuur.json, MIDI or MusicXML score and link it to this piece">
                      <FileUp className="h-4 w-4" /> Import score…
                    </button>
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs text-muted">
                    Use
                    <select
                      aria-label="Score for this piece"
                      className="field h-8 min-w-0 flex-1"
                      value={fb.link === null ? 'auto' : fb.link === false ? 'none' : fb.link}
                      onChange={(e) => link(entry.id, e.target.value === 'auto' ? null : e.target.value === 'none' ? false : e.target.value)}
                      disabled={now !== null || busy}
                    >
                      <option value="auto">{entry.songId ? 'Bundled arrangement' : 'An import whose title matches'}</option>
                      {!entry.songId && <option value="none">No score</option>}
                      {imported.length > 0 && (
                        <optgroup label="Imported songs">
                          {imported.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.title}
                            </option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </label>
                  {STYLE_RENDERING && (
                    <label className="mt-2 flex items-center gap-2 text-xs text-muted" title="How our version is played: the ornaments, vibrato and timing a player of that style adds">
                      Style
                      <select
                        aria-label="Playing style of our version"
                        className="field h-8 min-w-0 flex-1"
                        value={fb.style ?? 'default'}
                        onChange={(e) => setStyle(entry.id, e.target.value === 'default' ? null : (e.target.value as StyleId))}
                        disabled={now !== null || busy}
                      >
                        <option value="default">{styleName(entry.style)} (suggested)</option>
                        {STYLES.filter((s) => s.id !== entry.style).map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {playable ? (
                    <p className="mt-2 text-[11px] text-faint">
                      {playable.song.timeSignature.beats}/{playable.song.timeSignature.unit} · {playable.song.tempoBpm} BPM · tuning {prettyNoteName(midiToName(playable.song.tuning.male))}–
                      {prettyNoteName(midiToName(playable.song.tuning.female))} · {clock(ourSeconds ?? 0)} ·{' '}
                      <span className={playable.report.score < 1 ? 'text-[#f6c945]' : ''}>{Math.round(playable.report.score * 100)}% playable as written</span>
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-faint">Import a score (MusicXML from MuseScore, MIDI or .mkhuur.json) to hear our version of this piece.</p>
                  )}
                </Section>

                <Section title="Original performances">
                  {entry.originals.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {entry.originals.map((o) => (
                        <button key={o.url} type="button" className="btn btn-sm max-w-full" onClick={() => openExternal(o.url)} title={`${o.label} — ${o.url}`}>
                          <span className="min-w-0 truncate">{o.label}</span> <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-faint">No links yet. Load a recording you have below to compare with it.</p>
                  )}
                  {entry.recordings && entry.recordings.length > 0 && (
                    <ul className="mt-2 list-disc pl-5 text-[11px] text-muted">
                      {entry.recordings.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  )}
                  <p className="mt-2 text-[11px] text-faint">These recordings are protected: listen in your browser, and compare only with copies you own.</p>
                </Section>

                <Section title="Original recording · A/B">
                  <RecordingInfo slot={slot} onLoad={() => void loadOriginal(entry)} onRemove={() => void references.remove(entry.id)} disabled={busy} />
                  {recordingReady && (
                    <>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
                        <label className="flex items-center gap-2" title="Where our score begins in the recording: A/B, the comparison and blind trials start there">
                          Melody starts at
                          <SecondsField key={entry.id} value={fb.originalStart} onChange={(seconds) => setOriginalStart(entry.id, seconds)} label="Melody start in the original, seconds" />s
                        </label>
                        <label className="flex items-center gap-2" title="How much of the recording the comparison analyses from the melody start; empty: a little longer than our version">
                          Compare
                          <OptionalSecondsField key={`${entry.id}-length`} value={fb.excerptLength} onChange={(seconds) => setExcerptLength(entry.id, seconds)} label="Seconds of the original to compare" />s
                        </label>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          className="btn btn-sm"
                          data-on={abSide === 'original'}
                          style={{ '--btn-accent': 'var(--color-arga)' } as React.CSSProperties}
                          onClick={() => void listen('original')}
                          disabled={busy}
                        >
                          A · Original
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          data-on={abSide === 'ours'}
                          onClick={() => void listen('ours')}
                          disabled={!playable || busy}
                          title={playable ? undefined : 'Needs a score for this piece'}
                        >
                          {now?.what === 'preparing' && now.entryId === entry.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} B · Ours
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={switchAb}
                          disabled={(abSide !== 'original' && abSide !== 'ours') || !playable}
                          title={playable ? 'Switch to the other version at the same point of the melody' : 'Needs a score for this piece'}
                        >
                          <ArrowLeftRight className="h-4 w-4" /> Switch <Kbd hideWhenNarrow>T</Kbd>
                        </button>
                        {(abSide === 'original' || abSide === 'ours') && (
                          <button type="button" className="btn btn-sm" onClick={stop} aria-label="Stop">
                            <Square className="h-3.5 w-3.5 fill-current" />
                          </button>
                        )}
                      </div>
                      <p className="mt-1.5 text-[11px] text-faint">
                        {playable
                          ? `Both play at the same loudness; ours is rendered ${compareRoom === 'dry' ? 'dry' : 'in the steppe room'}${style ? ` in the ${styleName(style)} style` : ''}.`
                          : 'B · Ours and Switch need a score for this piece: import one above.'}
                      </p>
                    </>
                  )}
                </Section>

                <Section title="Your feedback">
                  <Stars value={fb.rating} onChange={(r) => setRating(entry.id, r)} />
                  <textarea
                    value={fb.notes}
                    onChange={(e) => setNotes(entry.id, e.target.value)}
                    placeholder="What sounds different from the original? (Юу нь өөр сонсогдож байна вэ?)"
                    aria-label="Notes"
                    className="field mt-2 h-24 w-full resize-none py-2 text-xs select-text"
                  />
                  {saveFailed && <p className="mt-1 text-[11px] text-[#f6c945]">Storage is full: your feedback is kept until you close the app. Use Export feedback to keep it.</p>}
                </Section>
              </div>

              <Section title="Comparison" className="mt-3">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    Our version
                    <select aria-label="Room for our version" className="field h-8" value={compareRoom} onChange={(e) => setCompareRoom(e.target.value as CompareRoom)} disabled={busy}>
                      <option value="dry">Dry</option>
                      <option value="steppe">Steppe room</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted" title={REFERENCE_KIND_INFO[referenceKind].description}>
                    Original is
                    <select
                      aria-label="What the original recording is"
                      className="field h-8"
                      value={fb.referenceKind ?? 'default'}
                      onChange={(e) => setReferenceKind(entry.id, e.target.value === 'default' ? null : (e.target.value as ReferenceKind))}
                      disabled={busy}
                    >
                      <option value="default">{REFERENCE_KIND_INFO[entry.referenceKind].label} (suggested)</option>
                      {REFERENCE_KINDS.filter((k) => k !== entry.referenceKind).map((k) => (
                        <option key={k} value={k}>
                          {REFERENCE_KIND_INFO[k].label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="button" className="btn btn-sm" onClick={() => void compare()} disabled={!playable || !recordingReady || busy}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <AudioLines className="h-4 w-4" />} Compare with the original
                  </button>
                  {!recordingReady && <span className="text-xs text-faint">Load an original recording to compare.</span>}
                  {recordingReady && !playable && <span className="text-xs text-faint">Import a score first.</span>}
                </div>
                <p className="mb-3 text-[11px] text-faint">
                  {REFERENCE_KIND_INFO[referenceKind].description}
                  {excerpt && playable ? ` Compares ${clock(excerpt.start)}–${clock(excerpt.start + excerpt.duration)} of the original with our whole version.` : ''}
                </p>
                {(comparing?.entryId === entry.id || fb.comparison) && (
                  <ComparisonReport
                    rows={comparing?.entryId === entry.id ? [] : (fb.comparison?.rows ?? [])}
                    score={comparing?.entryId === entry.id ? null : (fb.comparison?.score ?? null)}
                    progress={comparing?.entryId === entry.id ? { label: comparing.label, fraction: comparing.fraction } : null}
                    caption={fb.comparison && comparing?.entryId !== entry.id ? comparisonCaption(fb.comparison) : undefined}
                  />
                )}
              </Section>

              <Section title="Blind listening test" className="mt-3">
                <BlindTest
                  key={entry.id}
                  unavailable={blindUnavailable}
                  styles={STYLE_RENDERING ? STYLES : []}
                  blindStyles={blindStyles}
                  onBlindStyles={setBlindStyles}
                  answers={fb.blind}
                  melodySeconds={blindMelodySeconds}
                  prepare={prepareBlind}
                  play={playBlind}
                  stop={stopBlind}
                  onAnswer={answerBlind}
                  onClear={() => clearBlindAnswers(entry.id)}
                  disabled={busy}
                />
              </Section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function comparisonCaption(c: NonNullable<EntryFeedback['comparison']>): string {
  const kind = c.referenceKind ? ` (${REFERENCE_KIND_INFO[c.referenceKind].label.toLowerCase()})` : ''
  const style = c.style ? ` in the ${styleName(c.style)} style` : ''
  return `Compared ${new Date(c.at).toLocaleString()} with “${c.referenceName}”${kind}, ${clock(c.excerpt.start)}–${clock(c.excerpt.start + c.excerpt.duration)}; our version ${c.room === 'dry' ? 'dry' : 'in the steppe room'}${style}.`
}

function Section({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-line bg-panel/60 p-3 ${className}`}>
      <h3 className="panel-title mb-2">{title}</h3>
      {children}
    </section>
  )
}

const RIGHTS_STYLE: Record<PlaylistRights, string> = {
  'public-domain': 'border-go/50 text-go',
  original: 'border-bilag/50 text-bilag',
  copyrighted: 'border-rec/50 text-rec',
  unknown: 'border-line-2 text-muted'
}

function RightsBadge({ rights }: { rights: PlaylistRights }) {
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-semibold ${RIGHTS_STYLE[rights]}`} title={RIGHTS_INFO[rights].description}>
      {RIGHTS_INFO[rights].label}
    </span>
  )
}

function SourceChip({ source, library }: { source: SongSource; library: readonly LibraryEntry[] }) {
  if (source.kind === 'missing') return <span className="text-[#f6c945]">Needs a score</span>
  if (source.kind === 'bundled') return <span className="text-go">Bundled score</span>
  const title = library.find((s) => s.id === source.songId)?.title ?? source.songId
  return (
    <span className="min-w-0 truncate text-arga" title={title}>
      {source.kind === 'linked' ? 'Linked' : 'Matched'}: {title}
    </span>
  )
}

/** A seconds input that can be cleared while typing: only numbers are stored, and it shows the stored value again on blur. */
function SecondsField({ value, onChange, label }: { value: number; onChange(seconds: number): void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      min={0}
      step={0.5}
      value={draft ?? value}
      onChange={(e) => {
        setDraft(e.target.value)
        const seconds = parseSeconds(e.target.value)
        if (seconds !== null) onChange(seconds)
      }}
      onBlur={() => setDraft(null)}
      className="field h-8 w-20"
      aria-label={label}
    />
  )
}

/** A seconds input where empty means automatic (null); 0 counts as empty. */
function OptionalSecondsField({ value, onChange, label }: { value: number | null; onChange(seconds: number | null): void; label: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      min={0}
      step={1}
      placeholder="auto"
      value={draft ?? value ?? ''}
      onChange={(e) => {
        setDraft(e.target.value)
        if (!e.target.value.trim()) onChange(null)
        else {
          const seconds = parseSeconds(e.target.value)
          if (seconds !== null) onChange(seconds > 0 ? seconds : null)
        }
      }}
      onBlur={() => setDraft(null)}
      className="field h-8 w-20"
      aria-label={label}
    />
  )
}

function RecordingInfo({ slot, onLoad, onRemove, disabled }: { slot: ReferenceSlot; onLoad(): void; onRemove(): void; disabled: boolean }) {
  if (slot.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Decoding the recording…
      </div>
    )
  }
  const load = (
    <button type="button" className="btn btn-sm" onClick={onLoad} disabled={disabled} title="WAV, MP3, OGG, FLAC or M4A from this computer; it is kept on this computer only">
      <FileAudio className="h-4 w-4" /> {slot.status === 'ready' ? 'Replace…' : 'Load original recording…'}
    </button>
  )
  if (slot.status !== 'ready') {
    return (
      <div className="flex flex-col items-start gap-2">
        {load}
        {slot.status === 'error' ? <p className="text-xs text-rec">{slot.message}</p> : <p className="text-[11px] text-faint">A recording of this piece from your computer (it stays on this computer).</p>}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm" title={slot.audio.name}>
          {slot.audio.name}
        </div>
        <div className="text-[11px] text-faint">
          {clock(slot.audio.buffer.duration)} · {slot.audio.buffer.numberOfChannels === 1 ? 'mono' : 'stereo'}
          {slot.audio.saved ? '' : ' · this session only'}
        </div>
      </div>
      {load}
      <button type="button" className="btn btn-sm" onClick={onRemove} disabled={disabled} aria-label="Remove the recording">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )
}

function Stars({ value, onChange }: { value: number | null; onChange(rating: number | null): void }) {
  return (
    <div role="radiogroup" aria-label="How close is our version to the original?" className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} of 5`}
          onClick={() => onChange(value === n ? null : n)}
          className="rounded p-0.5 text-faint transition-colors hover:text-bilag"
        >
          <Star className={`h-5 w-5 ${value !== null && n <= value ? 'fill-bilag text-bilag' : ''}`} />
        </button>
      ))}
      <span className="ml-2 text-[11px] text-faint">{value === null ? 'How close does ours sound?' : ['Very different', 'Different', 'Somewhat close', 'Close', 'Like the original'][value - 1]}</span>
    </div>
  )
}
