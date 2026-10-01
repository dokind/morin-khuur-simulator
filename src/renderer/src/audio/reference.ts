import * as Tone from 'tone'
import type { OpenedFile } from '@shared/ipc'
import { analyzeAudio, compareFeatures, mixToMono, type AudioFeatures, type ComparisonRow, type FeatureComparison } from '@renderer/core/analysis'
import type { Tuning } from '@renderer/core/instrument'
import { quartersPerBar, type Song, type VerificationReport } from '@renderer/core/notation'
import type { StyleId } from '@renderer/core/performance/types'
import { cacheEvictions, excerptWindow, listeningGain, type CompareRoom, type ReferenceKind } from '@renderer/core/playlist'
import type { Soundboard } from './body'
import { engine } from './engine'
import { MorinKhuur } from './morin-khuur'
import { renderOffline, softClipper, whenOfflineIdle } from './offline'
import { eventsDuration, songEvents, type TimedEvent } from './song-player'

/** Original recordings the user can load for comparison (whatever Chromium decodes). */
export const REFERENCE_AUDIO_FILTERS = [{ name: 'Audio recordings', extensions: ['wav', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm'] }]

export interface ReferenceAudio {
  name: string
  buffer: AudioBuffer
  /** Gain that brings the recording to the common A/B listening level. */
  gain: number
  /** False when it could not be stored for later sessions (kept for this session only). */
  saved: boolean
}

export type ReferenceSlot = { status: 'none' } | { status: 'loading' } | { status: 'ready'; audio: ReferenceAudio } | { status: 'error'; message: string }

export interface CompareResult {
  sim: AudioFeatures
  ref: AudioFeatures
  comparison: FeatureComparison
  /** Seconds of the original that were analysed. */
  excerpt: { start: number; duration: number }
  room: CompareRoom
  referenceKind: ReferenceKind
  style: StyleId | null
  referenceName: string
  /** The score our version was rendered from. */
  song: Song
}

const channelsOf = (buffer: AudioBuffer | Tone.ToneAudioBuffer): Float32Array[] =>
  Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))

async function decode(bytes: Uint8Array): Promise<AudioBuffer> {
  engine.init()
  // decodeAudioData detaches the buffer it is given, so it gets a copy.
  return Tone.getContext().decodeAudioData(bytes.slice().buffer)
}

// ---------------------------------------------------------------------------------------------
// IndexedDB: the recordings' original bytes, keyed by playlist entry id (never localStorage).

const DB_NAME = 'mkhuur.references'
const STORE = 'recordings'
/** Larger files stay for the session only. */
const MAX_STORED_BYTES = 100 * 1024 * 1024

interface StoredRecording {
  name: string
  bytes: ArrayBuffer
  savedAt: string
}

let database: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB is unavailable.'))
  }).catch((e: unknown) => {
    database = null
    throw e
  })
  return database
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = run(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = tx.onabort = () => reject(tx.error ?? req.error ?? new Error('IndexedDB request failed.'))
  })
}

// ---------------------------------------------------------------------------------------------

interface LibraryState {
  slots: ReadonlyMap<string, ReferenceSlot>
  /** Entries with a recording saved in IndexedDB (decoded or not). */
  stored: ReadonlySet<string>
  results: ReadonlyMap<string, CompareResult>
}

const NONE: ReferenceSlot = { status: 'none' }
/** Decoded recordings kept in memory (a few minutes of stereo PCM is ~100 MB); saved ones reload on demand. */
const MAX_DECODED = 3

/**
 * The user's original recordings (decoded in memory, bytes persisted in IndexedDB) and this
 * session's comparison results, per playlist entry. An external store: `snapshot()` changes
 * identity on every update (for useSyncExternalStore).
 */
class ReferenceLibrary {
  private state: LibraryState = { slots: new Map(), stored: new Set(), results: new Map() }
  private readonly listeners = new Set<() => void>()
  private readonly restoring = new Map<string, Promise<void>>()
  private scanned = false

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = (): LibraryState => this.state

  get(entryId: string): ReferenceSlot {
    return this.state.slots.get(entryId) ?? NONE
  }

  result(entryId: string): CompareResult | null {
    return this.state.results.get(entryId) ?? null
  }

  setResult(entryId: string, result: CompareResult): void {
    this.update({ results: new Map(this.state.results).set(entryId, result) })
  }

  private update(patch: Partial<LibraryState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  private setSlot(entryId: string, slot: ReferenceSlot | null, { stored }: { stored?: boolean } = {}): void {
    const slots = new Map(this.state.slots)
    slots.delete(entryId) // re-inserted last: Map order is least recently loaded first
    if (slot) slots.set(entryId, slot)
    if (slot?.status === 'ready') {
      // Evict the oldest decoded recordings that can be reloaded from storage.
      let decoded = [...slots].filter(([, s]) => s.status === 'ready').length
      for (const [id, s] of slots) {
        if (decoded <= MAX_DECODED) break
        if (id === entryId || s.status !== 'ready' || !s.audio.saved) continue
        slots.delete(id)
        this.restoring.delete(id)
        decoded--
      }
    }
    const patch: Partial<LibraryState> = { slots }
    if (stored !== undefined) {
      const set = new Set(this.state.stored)
      if (stored) set.add(entryId)
      else set.delete(entryId)
      patch.stored = set
    }
    this.update(patch)
  }

  /** Finds which entries have a saved recording (once), without decoding any. */
  async scan(): Promise<void> {
    if (this.scanned) return
    this.scanned = true
    try {
      const keys = await idb('readonly', (s) => s.getAllKeys())
      this.update({ stored: new Set([...this.state.stored, ...keys.map(String)]) })
    } catch {
      // No storage: recordings are per session.
    }
  }

  /** Loads the recording saved for `entryId` in an earlier session; concurrent calls share one load. */
  restore(entryId: string): Promise<void> {
    let pending = this.restoring.get(entryId)
    if (!pending) {
      pending = this.restoreNow(entryId)
      this.restoring.set(entryId, pending)
    }
    return pending
  }

  private async restoreNow(entryId: string): Promise<void> {
    if (this.state.slots.has(entryId)) return
    let stored: StoredRecording | undefined
    try {
      stored = await idb<StoredRecording | undefined>('readonly', (s) => s.get(entryId) as IDBRequest<StoredRecording | undefined>)
    } catch {
      return
    }
    if (!stored || this.state.slots.has(entryId)) return
    this.setSlot(entryId, { status: 'loading' }, { stored: true })
    try {
      const buffer = await decode(new Uint8Array(stored.bytes))
      if (this.get(entryId).status !== 'loading') return // replaced meanwhile
      this.setSlot(entryId, { status: 'ready', audio: { name: stored.name, buffer, gain: listeningGain(channelsOf(buffer), buffer.sampleRate), saved: true } })
    } catch {
      this.setSlot(entryId, { status: 'error', message: `The saved recording “${stored.name}” could not be decoded; load it again.` })
    }
  }

  /** Decodes a recording the user picked and keeps it for `entryId`, replacing any earlier one. */
  async load(entryId: string, file: OpenedFile): Promise<void> {
    const bytes = typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data
    this.restoring.set(entryId, Promise.resolve())
    const results = new Map(this.state.results)
    results.delete(entryId)
    this.update({ results })
    this.setSlot(entryId, { status: 'loading' })
    let buffer: AudioBuffer
    try {
      buffer = await decode(bytes)
    } catch {
      this.setSlot(entryId, { status: 'error', message: `“${file.name}” could not be decoded as audio. Try WAV, MP3, OGG or FLAC.` })
      return
    }
    let saved = false
    if (bytes.byteLength <= MAX_STORED_BYTES) {
      try {
        const record: StoredRecording = { name: file.name, bytes: bytes.slice().buffer, savedAt: new Date().toISOString() }
        await idb('readwrite', (s) => s.put(record, entryId))
        saved = true
      } catch {
        // Storage full or unavailable: the recording stays for this session.
      }
    }
    if (!saved) {
      // Otherwise the recording this one replaces would come back in the next session.
      try {
        await idb('readwrite', (s) => s.delete(entryId))
      } catch {
        // Nothing stored, or no storage at all.
      }
    }
    this.setSlot(entryId, { status: 'ready', audio: { name: file.name, buffer, gain: listeningGain(channelsOf(buffer), buffer.sampleRate), saved } }, { stored: saved })
  }

  async remove(entryId: string): Promise<void> {
    this.restoring.set(entryId, Promise.resolve())
    const results = new Map(this.state.results)
    results.delete(entryId)
    this.update({ results })
    this.setSlot(entryId, null, { stored: false })
    try {
      await idb('readwrite', (s) => s.delete(entryId))
    } catch {
      // Nothing stored.
    }
  }
}

export const references = new ReferenceLibrary()

// ---------------------------------------------------------------------------------------------

/**
 * Whether our renders take a playing style (core/performance through songEvents). With false,
 * every render uses the song's own style and the view hides the style choices.
 */
export const STYLE_RENDERING: boolean = true

/** The events of our version of `song` in `style` (null: the song's own, see resolveStyle). */
export function ourEvents(song: Song, report: VerificationReport, style: StyleId | null): TimedEvent[] {
  return songEvents(song, report, song.tempoBpm, STYLE_RENDERING && style ? { style } : {})
}

/** Seconds from the start of the events to the first score note (framing strokes come before it). */
export const firstNoteAt = (events: readonly TimedEvent[]): number => (events.find((e) => e.order >= 0) ?? events[0])?.start ?? 0

/**
 * Where the score notes sound: from the first one's start to the last one's end, without the
 * framing strokes before and after them. Comparisons and blind excerpts use this span, since the
 * original's melody start marks where its tune begins.
 */
export function melodySpan(events: readonly TimedEvent[]): { start: number; end: number } {
  const notes = events.filter((e) => e.order >= 0)
  if (!notes.length) return { start: 0, end: eventsDuration(events) }
  return { start: notes[0]!.start, end: Math.max(...notes.map((e) => e.start + e.event.duration)) }
}

/** Start offset of our renders, so the first attack isn't clipped. */
export const RENDER_LEAD_IN = 0.05

export interface OurVersion {
  buffer: Tone.ToneAudioBuffer
  gain: number
  /** Seconds from the start of the buffer to the first note. */
  onset: number
  /** Seconds of music (without the reverb tail). */
  length: number
}

export interface RenderOptions {
  room: CompareRoom
  soundboard: Soundboard
  vibratoCents: number
  /** Playing style; null: the song's own (always, without STYLE_RENDERING). */
  style: StyleId | null
}

const songTuning = (song: Song): Tuning => ({ id: 'song', name: '', male: song.tuning.male, female: song.tuning.female, scaleTonic: 0 })

/** Songs get a number for the render cache keys (loadSong keeps a song's identity), so the cache does not hold them. */
const songKeys = new WeakMap<Song, number>()
let nextSongKey = 0

interface CachedRender {
  promise: Promise<OurVersion>
  /** Size of the rendered audio; null while it renders. */
  bytes: number | null
}

/** Rendered versions by song and render settings, least recently used first (a minute of stereo is ~21 MB). */
const renders = new Map<string, CachedRender>()
const MAX_RENDERS = 4
const MAX_RENDER_BYTES = 160 * 1024 * 1024

function evictRenders(): void {
  for (const key of cacheEvictions([...renders].map(([key, r]) => ({ key, bytes: r.bytes })), { maxEntries: MAX_RENDERS, maxBytes: MAX_RENDER_BYTES })) renders.delete(key)
}

/**
 * Renders go through renderOffline's app-wide queue (one at a time). This controller is aborted
 * by cancelQueuedRenders, so the Playlist's renders that have not started yet never start.
 */
let queued = new AbortController()

/** Drops the renders that are queued but have not started (they reject with an AbortError); the running one finishes. */
export function cancelQueuedRenders(): void {
  queued.abort(new DOMException('The render was cancelled.', 'AbortError'))
  queued = new AbortController()
}

/** Resolves once no offline render (from any view) is queued or running; live playback waits for it. */
export const whenRendersIdle = whenOfflineIdle

/** Our version of `song` rendered offline as it plays live (expressive), through the full instrument chain. */
export function renderOurVersion(song: Song, report: VerificationReport, { room, soundboard, vibratoCents, style }: RenderOptions): Promise<OurVersion> {
  const styleKey = STYLE_RENDERING ? style : null
  let songKey = songKeys.get(song)
  if (songKey === undefined) songKeys.set(song, (songKey = nextSongKey++))
  const key = `${songKey}|${room}|${soundboard}|${vibratoCents}|${styleKey ?? ''}`
  const cached = renders.get(key)
  if (cached) {
    renders.delete(key)
    renders.set(key, cached) // most recently used last
    return cached.promise
  }
  const events = ourEvents(song, report, styleKey)
  const length = eventsDuration(events)
  const promise = renderOffline(
    RENDER_LEAD_IN + length + (room === 'dry' ? 1 : 3),
    (input) => {
      const kh = new MorinKhuur(input)
      kh.tuning = songTuning(song)
      kh.soundboard = soundboard
      kh.vibratoCents = vibratoCents
      for (const e of events) kh.play(e.event, RENDER_LEAD_IN + e.start)
    },
    { room, channels: 2, signal: queued.signal }
  ).then((buffer) => ({ buffer, gain: listeningGain(channelsOf(buffer), buffer.sampleRate), onset: RENDER_LEAD_IN + firstNoteAt(events), length }))
  const entry: CachedRender = { promise, bytes: null }
  renders.set(key, entry)
  evictRenders()
  promise.then(
    ({ buffer }) => {
      entry.bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
      evictRenders()
    },
    () => {
      if (renders.get(key) === entry) renders.delete(key)
    }
  )
  return promise
}

/** Lets the UI paint between heavy synchronous steps. */
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

/** A detected onset may lead the scheduled one by a few analysis frames. */
const ONSET_SLACK = 0.04

/**
 * Bar number (1 = the song's first bar) of the score note starting at or just before `seconds`
 * into our render of `events`, for naming the bars where the melody differs. Framing strokes
 * before the melody count as its first bar.
 */
function renderBars(song: Song, report: VerificationReport, events: readonly TimedEvent[]): (seconds: number) => number {
  const perBar = quartersPerBar(song.timeSignature)
  const notes = events.filter((e) => e.order >= 0)
  return (seconds) => {
    let at = notes[0]
    for (const e of notes) {
      if (RENDER_LEAD_IN + e.start > seconds + ONSET_SLACK) break
      at = e
    }
    const beats = at ? (report.checks[at.order]?.note.startBeats ?? 0) : 0
    return Math.floor(beats / perBar + 1e-6) + 1
  }
}

/** Mono samples of `buffer` from `start` for `duration` seconds. */
function excerptSamples(buffer: AudioBuffer | Tone.ToneAudioBuffer, start: number, duration: number): Float32Array {
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.floor(start * sr))
  const to = Math.min(buffer.length, from + Math.floor(duration * sr))
  return mixToMono(channelsOf(buffer).map((c) => c.subarray(from, to)))
}

/**
 * Renders our version, analyses it and the original's excerpt (from `start`, `length` seconds or
 * automatic; see excerptWindow) and compares their features. Analysis runs on the main thread,
 * one step at a time (well under a second for a 90 s excerpt). Both use the analysis' default
 * pitch range (60–2000 Hz, the whole instrument), so a transposed original is still tracked.
 * `signal` stops it between steps (the render itself cannot be interrupted once it has started).
 */
export async function compareWithOriginal(
  song: Song,
  report: VerificationReport,
  original: Pick<ReferenceAudio, 'name' | 'buffer'>,
  {
    start,
    length = null,
    referenceKind,
    onProgress,
    signal,
    ...render
  }: RenderOptions & { start: number; length?: number | null; referenceKind: ReferenceKind; onProgress(label: string, fraction: number): void; signal?: AbortSignal }
): Promise<CompareResult> {
  onProgress('Rendering our version…', 0.05)
  const ours = await renderOurVersion(song, report, render)
  signal?.throwIfAborted()
  onProgress('Analysing our version…', 0.35)
  await breathe()
  signal?.throwIfAborted()
  // The same events renderOurVersion played (it caches the audio, not the events). Only our
  // melody is analysed, from just before its first note to a closing frame (or the render's end):
  // the original's excerpt starts at its melody start, so our framing strokes would be extra notes.
  const events = ourEvents(song, report, STYLE_RENDERING ? render.style : null)
  const span = melodySpan(events)
  const closing = events.find((e) => e.order < 0 && e.start >= span.end - 1e-9)
  const from = span.start
  const to = closing ? RENDER_LEAD_IN + closing.start : ours.buffer.duration
  const sim = analyzeAudio(excerptSamples(ours.buffer, from, to - from), ours.buffer.sampleRate)
  onProgress('Analysing the original…', 0.6)
  await breathe()
  signal?.throwIfAborted()
  const excerpt = excerptWindow(original.buffer.duration, start, span.end - span.start, length)
  const ref = analyzeAudio(excerptSamples(original.buffer, excerpt.start, excerpt.duration), original.buffer.sampleRate)
  onProgress('Comparing…', 0.95)
  await breathe()
  signal?.throwIfAborted()
  const bars = renderBars(song, report, events)
  const barOf = (seconds: number) => bars(from + seconds)
  return {
    sim,
    ref,
    comparison: compareFeatures(sim, ref, { referenceKind, barOf }),
    excerpt,
    room: render.room,
    referenceKind,
    style: STYLE_RENDERING ? render.style : null,
    referenceName: original.name,
    song
  }
}

/** Listening gain of one excerpt, so both halves of a blind trial are equally loud where they play. */
export function excerptGain(buffer: AudioBuffer | Tone.ToneAudioBuffer, start: number, duration: number): number {
  const sr = buffer.sampleRate
  const from = Math.max(0, Math.floor(start * sr))
  const to = Math.min(buffer.length, from + Math.floor(duration * sr))
  return listeningGain(
    channelsOf(buffer).map((c) => c.subarray(from, to)),
    sr
  )
}

// ---------------------------------------------------------------------------------------------

/** What the A/B player is playing: one of the versions, or a blind-test excerpt (never revealed). */
export type AbSide = 'original' | 'ours' | 'blind'

interface AbClip {
  side: AbSide
  startedAt: number
  offset: number
  finish(ended: boolean): void
}

/**
 * A/B listening: one version at a time at the common listening level. It bypasses the live room
 * (the original carries its own acoustics; ours was rendered with the chosen compare room), so
 * both are heard through the same path: master volume, then a limiter and a soft clipper like the
 * live output, so a raised master volume never hard-clips.
 */
export class AbPlayer {
  private clip: AbClip | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** What is playing (a stable primitive for useSyncExternalStore). */
  side = (): AbSide | null => this.clip?.side ?? null

  /** Seconds into the playing buffer. */
  get position(): number {
    return this.clip ? this.clip.offset + Math.max(0, Tone.now() - this.clip.startedAt) : 0
  }

  /** Plays `buffer` from `offset`; resolves true when it played to the end, false when stopped or replaced. */
  play(
    side: AbSide,
    buffer: AudioBuffer | Tone.ToneAudioBuffer,
    { gain, offset = 0, duration, masterDb = 0, fade = { in: 0.01, out: 0.04 } }: { gain: number; offset?: number; duration?: number; masterDb?: number; fade?: { in: number; out: number } }
  ): Promise<boolean> {
    this.stop()
    engine.init()
    return new Promise<boolean>((resolve) => {
      const clipper = softClipper().toDestination()
      const limiter = new Tone.Limiter(-1).connect(clipper)
      const volume = new Tone.Volume(masterDb).connect(limiter)
      const player = new Tone.Player({ url: buffer, fadeIn: fade.in, fadeOut: fade.out }).connect(volume)
      player.volume.value = Tone.gainToDb(gain)
      let settled = false
      const clip: AbClip = {
        side,
        startedAt: Tone.now(),
        offset: Math.max(0, Math.min(offset, buffer.duration - 0.05)),
        finish: (ended) => {
          if (settled) return
          settled = true
          player.onstop = () => {}
          if (!ended) player.stop()
          if (this.clip === clip) this.clip = null
          // Disposed once the fade-out and the source's own `ended` event are done.
          setTimeout(
            () => {
              player.dispose()
              volume.dispose()
              limiter.dispose()
              clipper.dispose()
            },
            250 + fade.out * 1000
          )
          for (const l of this.listeners) l()
          resolve(ended)
        }
      }
      player.onstop = () => clip.finish(true)
      this.clip = clip
      player.start(clip.startedAt, clip.offset, duration)
      for (const l of this.listeners) l()
    })
  }

  stop(): void {
    this.clip?.finish(false)
  }
}

// ---------------------------------------------------------------------------------------------
// Developer comparison (dev builds, via window.__mkhuur): the same decode, render and analysis
// path as the Playlist view, driven by a URL instead of a picked file.

/** A song to render for a developer comparison. */
export interface DevPiece {
  id: string
  title: string
  song: Song
  report: VerificationReport
}

export interface CompareUrlOptions {
  /** Audio file to fetch, e.g. a Vite `/@fs/C:/…/references/x.mp3` URL. */
  url: string
  /** Our version to compare with; null analyses the recording alone. */
  piece: DevPiece | null
  /** Seconds into the file where the compared section starts. */
  start?: number
  /** Seconds to compare; default a little longer than our version (at most 90 s). */
  length?: number | null
  referenceKind?: ReferenceKind
  room?: CompareRoom
  style?: StyleId | null
  soundboard?: Soundboard
}

type FeatureSummary = AudioFeatures['summary'] & { duration: number; rmsDb: number; noteCount: number }

export interface CompareUrlReport {
  url: string
  referenceName: string
  song: { id: string; title: string } | null
  room: CompareRoom
  referenceKind: ReferenceKind
  style: StyleId | null
  /** Seconds of the recording that were analysed. */
  excerpt: { start: number; duration: number }
  score: number | null
  rows: ComparisonRow[]
  sim: FeatureSummary | null
  ref: FeatureSummary
}

const summarize = (f: AudioFeatures): FeatureSummary => ({ duration: f.duration, rmsDb: f.rmsDb, noteCount: f.notes.length, ...f.summary })

async function fetchAudio(url: string): Promise<{ name: string; buffer: AudioBuffer }> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not fetch ${url}: HTTP ${response.status}.`)
  const buffer = await decode(new Uint8Array(await response.arrayBuffer()))
  const file = url.split('?')[0]!.split(/[\\/]/).pop() || url
  let name = file
  try {
    name = decodeURIComponent(file)
  } catch {
    // Not percent-encoded.
  }
  return { name, buffer }
}

/** Features of an audio file fetched from `url` (from `start`, for `length` seconds or to the end). */
export async function analyzeUrl(url: string, { start = 0, length }: { start?: number; length?: number } = {}): Promise<AudioFeatures> {
  const { buffer } = await fetchAudio(url)
  const from = Math.min(Math.max(0, start), buffer.duration)
  return analyzeAudio(excerptSamples(buffer, from, length ?? buffer.duration - from), buffer.sampleRate)
}

/** Compares a recording fetched from `url` with our render of `piece`, as the Playlist's Compare does. */
export async function compareUrl({ url, piece, start = 0, length = null, referenceKind = 'fiddle', room = 'dry', style = null, soundboard = 'wood' }: CompareUrlOptions): Promise<CompareUrlReport> {
  const { name, buffer } = await fetchAudio(url)
  const base = { url, referenceName: name, room, referenceKind, style: STYLE_RENDERING ? style : null }
  if (!piece) {
    const excerpt = excerptWindow(buffer.duration, start, buffer.duration, length)
    const ref = analyzeAudio(excerptSamples(buffer, excerpt.start, excerpt.duration), buffer.sampleRate)
    return { ...base, song: null, excerpt, score: null, rows: [], sim: null, ref: summarize(ref) }
  }
  const result = await compareWithOriginal(
    piece.song,
    piece.report,
    { name, buffer },
    { start, length, referenceKind, room, style, soundboard, vibratoCents: engine.morinKhuur().vibratoCents, onProgress: () => {} }
  )
  return {
    ...base,
    song: { id: piece.id, title: piece.title },
    excerpt: result.excerpt,
    score: result.comparison.score,
    rows: result.comparison.rows,
    sim: summarize(result.sim),
    ref: summarize(result.ref)
  }
}
