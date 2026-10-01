/**
 * Recording analysis for the reference comparison: measures how a morin khuur recording *plays*
 * (pitch, vibrato, harmonic balance, brightness, bow noise, attacks, note density, slides, tempo,
 * rhythm, key, melody), so a render of the simulator can be compared with an original recording
 * of the same piece.
 *
 * Pipeline: frame-wise YIN pitch track at a decimated rate (voiced = confident and within
 * `gateDb` of the loudest frame), each period checked against the partials it predicts (octave
 * slips, the common period of a note and the previous note's reverb) → octave-error and spike
 * clean-up → notes from rests, energy dips (re-bowing) and a penalised piecewise-constant fit of the pitch
 * contour, which a vibrato cannot beat but a note change can; slides and scoops join the note
 * they lead into, tracking slips whose own period is missing (and other notes' reverb heard
 * through an attack) are blanked, and reverb heard through rests is cut or dropped (a note needs
 * an attack of its own: a silent gap, or its partials rising together) → per-note features →
 * medians over notes, plus tempo, rhythm and pitch-class statistics from the notes.
 *
 * Pure TypeScript (no DOM, no Tone); a 4-minute 44.1 kHz recording takes about a second.
 */

import { blackmanHarrisWindow, fft, hannWindow, nextPowerOfTwo } from './fft'
import { detectPitch } from './pitch-detect'
import { centsBetween, freqToMidi, midiToFreq } from './pitch'

export interface NoteFeatures {
  /** Seconds from the start of the analysed audio. */
  start: number
  end: number
  /** Median fundamental of the note's steady (non-sliding) frames, Hz. */
  f0: number | null
  /** Regular vibrato rate (3–9 Hz); null for short notes or a note without periodic vibrato. */
  vibratoRateHz: number | null
  /** Vibrato width as half peak-to-peak (√2 · RMS of the detrended pitch), cents; null for short notes. */
  vibratoExtentCents: number | null
  /** Time from the note's start to the centre of the first one-cycle window at half the full vibrato width (so never below about half a cycle); null without vibrato. */
  vibratoOnsetMs?: number | null
  /** Correlation of the detrended pitch with the detrended level on a vibrato note (+1 louder when sharper); null without vibrato. */
  amCorrelation?: number | null
  /** H1..H10 in dB relative to the strongest of them; empty when the note could not be measured. */
  harmonicsDb: number[]
  /** Magnitude-weighted spectral centroid, f0/2 … 8 kHz. */
  centroidHz: number | null
  /** Harmonic-to-noise ratio: energy of the harmonics vs the noise between them (horsehair/bow noise). */
  hnrDb: number | null
  /** 10 % → 90 % rise time of the RMS envelope; null for legato notes that do not rise ≥ 6 dB. */
  attackMs: number | null
}

export interface AudioFeatures {
  sampleRate: number
  /** Seconds. */
  duration: number
  /** Overall RMS level, dBFS. */
  rmsDb: number
  notes: NoteFeatures[]
  /** One frame per `hopSeconds`; f0 is null outside notes (rests, reverb tails, noise). */
  pitchTrack: { t: number; f0: number | null; rmsDb: number }[]
  summary: {
    f0MedianHz: number | null
    vibratoRateHz: number | null
    vibratoExtentCents: number | null
    /** Per-harmonic median over notes, renormalised so the strongest is 0 dB. */
    harmonicsDb: number[]
    centroidHz: number | null
    hnrDb: number | null
    attackMs: number | null
    /** Notes per second between the first note's start and the last note's end. */
    noteRate: number
    /** Share of voiced frames spent sliding faster than `glideSemitonesPerSecond`. */
    glideShare: number
    // The fields below are always filled by analyzeAudio; optional for hand-made summaries.
    /** Beat (quarter-note level, `tempoMinBpm`–`tempoMaxBpm`) from the note onsets; null with too few onsets. */
    tempoBpm?: number | null
    /** Spread of the local tempo over 8-beat (two 4/4 bars) windows: standard deviation ÷ mean. */
    tempoVariance?: number | null
    /** Deviation of the notes from equal temperament at A = 440 Hz (duration-weighted circular mean), cents (−50…50). */
    tuningCents?: number | null
    /** Duration-weighted pitch-class histogram (index 0 = C, after removing `tuningCents`), summing to 1; empty without notes. */
    pitchClasses?: number[]
    /** Share of notes ≥ `vibratoShareMinSeconds` with vibrato (a rate and ≥ `vibratoMinExtentCents`); null without such notes. */
    vibratoShare?: number | null
    /** Median over vibrato notes of NoteFeatures.vibratoOnsetMs. */
    vibratoOnsetMs?: number | null
    /** Median over vibrato notes of NoteFeatures.amCorrelation: positive = pitch and loudness move in phase. */
    amPhase?: number | null
    /** Trills (alternations of ≥ `trillMinCents` at `trillMinHz`–`trillMaxHz`): count, median rate (cycles/s; null when every trill is under `trillTimedSwings` swings) and interval (cents, peak to peak). */
    trillCount?: number
    trillRateHz?: number | null
    trillExtentCents?: number | null
    /** Slides between two steady notes: count, median length (ms, the whole movement) and median interval (semitones, unsigned). */
    slideCount?: number
    slideMs?: number | null
    slideSemitones?: number | null
    /** Long-term average spectrum of the sustained notes in the 1/6-octave bands of LTAS_BANDS_HZ, dB relative to the mean band; null above Nyquist, empty when unmeasured. */
    ltasDb?: (number | null)[]
    /** Peaks of the histogram of successive inter-onset-interval ratios (folded to ≥ 1), strongest first. */
    ioiRatioPeaks?: number[]
    /** The main uneven ratio among them (e.g. 2 for a 1:1:2 gallop or a 2:1 amble), 1 for an even rhythm; null with too few notes. */
    ioiRatio?: number | null
    /** 95th minus 5th percentile of the notes' sustained levels (each the 90th percentile of its frame levels), dB; null with fewer than `dynamicsMinNotes` notes. */
    dynamicRangeDb?: number | null
  }
}

/** What an original recording is; decides which comparison rows apply (REFERENCE_ROWS). */
export type ReferenceKind = 'fiddle' | 'voice' | 'piano' | 'ensemble'

export type ComparisonGroup = 'pitch' | 'rhythm' | 'expression' | 'timbre' | 'dynamics'

export interface ComparisonRow {
  feature: string
  label: string
  /** `sim`, `ref`, `delta` (sim − ref) and `tolerance` are all in `unit`. */
  sim: number | null
  ref: number | null
  delta: number | null
  tolerance: number
  unit: string
  /** Within tolerance; null when either recording lacks the feature, or for an informational row. */
  ok: boolean | null
  hint: string
  /** What the row is about, for grouping in the UI. */
  group?: ComparisonGroup
  /** Reported but never scored (ok is null): the key difference, which the pitch rows already take out. */
  informational?: boolean
}

/** Result of melodyMatch: how much of `a` the other sequence plays, transposition-invariantly (over at most the first 2000 notes of each). */
export interface MelodyMatch {
  /** Notes of `a` that match (0–1 of `a`). */
  share: number
  matched: number
  total: number
  /** Indexes into `a` of the notes that differ (wrong, extra or missing around them). */
  differing: number[]
  /** Semitones from `b` to `a` over the matched notes (median, rounded); null if nothing matched. */
  transposition: number | null
}

export interface FeatureComparison {
  rows: ComparisonRow[]
  /** Share of comparable rows within tolerance (0–1); null if nothing was comparable. */
  score: number | null
  referenceKind?: ReferenceKind
  /**
   * Key difference, semitones ours − original: from the melody alignment when at least half our
   * notes match, else from the pitch-class histograms (octave from the median pitch); null without notes.
   */
  transposition?: number | null
  /** Our notes against the original's; `differingBars` when `barOf` was given. */
  melody?: (MelodyMatch & { differingBars: number[] | null }) | null
}

export interface CompareOptions {
  /** What the original is (default 'fiddle': every row). */
  referenceKind?: ReferenceKind
  /** Bar number at a time (seconds) of our render, to name the bars where the melody differs. */
  barOf?: (seconds: number) => number
}

/** Analysis parameters. Times in seconds, pitch distances in semitones unless named otherwise. */
export const ANALYSIS = {
  hopSeconds: 0.01,
  minFreq: 60,
  maxFreq: 2000,
  /** YIN dip threshold, and the confidence (1 − dip) a frame needs to count as voiced. */
  yinThreshold: 0.2,
  voicingConfidence: 0.65,
  /** Frames this far below the loudest frame are unvoiced (rests, reverb tails)… */
  gateDb: 35,
  /** …and so is anything below this absolute level. */
  silenceDb: -80,
  /**
   * Reverb: a note's last frames this far below its loud level are cut, and a segment this soon
   * after the previous note was last heard, starting without an attack, is checked for being
   * reverb (a short one `tailDb` below the note before is, at any pitch).
   */
  tailGapSeconds: 0.5,
  tailDb: 10,
  /**
   * A segment starts with an attack when the gap before it falls `gapSilentDb` below it (on a 5 ms
   * envelope), or when its partials (those within `attackPartialRangeDb` of the strongest) rise
   * `attackPartialRiseDb` or more out of the quietest frame before it: all but a tenth of them
   * (`attackPartialShareAlone`), or `attackPartialShare` when the segment also ends in a release of
   * its own. A new bow stroke excites every partial at once; reverb recovering from a momentary
   * null after a release brings back only those that had cancelled, and runs straight into the
   * next note.
   */
  gapSilentDb: 30,
  attackPartialShareAlone: 0.9,
  attackPartialShare: 0.7,
  attackPartialRiseDb: 2,
  attackPartialRangeDb: 30,
  /**
   * A reverb copy follows a release (the level `releaseDb` below the note before, and not then held
   * for `swellHeldSeconds` without decaying at `swellDecayDbPerSecond`: that is a note played
   * softly after an accent) and peaks at least `copyBelowDb` below the note it copies. A segment
   * touching the note before at its pitch is that note cut by a loudness swing when there was no
   * release (and no bow change: a dip `bowChangeDipDb` below the level just before it, with all
   * partials rising) or when it has no attack and is at most `splitDb` quieter.
   */
  releaseDb: 6,
  copyBelowDb: 1,
  bowChangeDipDb: 4,
  splitDb: 3,
  /**
   * A long segment holding its level `reverbShortSeconds` (no frame `swellHoldDb` lower) after an
   * onset is a note; a soft repeat hidden in a tail (no onset) rises `swellRiseDb` out of it after
   * a release (the tail decaying as above) and holds.
   */
  swellRiseDb: 4,
  swellHoldDb: 3,
  swellDecayDbPerSecond: 10,
  swellHeldSeconds: 0.25,
  /** A dropped reverb copy may be of any note that ended this long before it; one this short matches within a semitone (or a harmonic of the note). */
  reverbMemorySeconds: 1.5,
  reverbShortSeconds: 0.15,
  /** Unvoiced gaps up to this long inside a phrase are bridged. */
  bridgeSeconds: 0.03,
  /** A dip in the RMS envelope this deep on both sides is a re-articulation (bow change, re-bowed note)… */
  onsetDipDb: 8,
  /** …and so is a rise this steep out of a dip (an attack, when reverb fills the dip). */
  attackRiseDb: 6,
  attackRiseSeconds: 0.05,
  attackStepDbPerSecond: 200,
  /** Cost of one more note in the piecewise-constant pitch fit, semitones² × frames at a 10 ms hop. */
  segmentPenalty: 2.5,
  /** Adjacent pitch levels closer than this are the same note. */
  noteStepSemitones: 0.6,
  /** At most this many frames off both neighbours by more than this are a tracking spike. */
  spikeFrames: 3,
  spikeSemitones: 1,
  /** Shorter fragments are merged into a neighbour (or dropped when isolated). */
  minNoteSeconds: 0.06,
  /** Segments at most this long a (sub)harmonic away from a neighbour are tracking slips… */
  slipMaxSeconds: 0.25,
  /** …and at most this long for an octave below, or a harmonic sounded at a bow onset. */
  onsetTransientSeconds: 0.1,
  /**
   * A subharmonic segment is a slip only if its own period is missing: less than this share of
   * its energy off the higher note's partials (the looser value up to `onsetTransientSeconds`),
   * or a fundamental at most `slipFundamentalDb` below its strongest partial with less than
   * `slipOffCombWeakFundamental` off them (a mixture's common period). A real low note with a
   * weak fundamental (the open strings' H1 lies 1–3 dB below H2) keeps its odd partials: 30 % or
   * more of its energy even with H1 15 dB down.
   */
  slipOffComb: 0.15,
  slipOffCombShort: 0.2,
  slipFundamentalDb: -30,
  slipOffCombWeakFundamental: 0.6,
  /**
   * …or if it is another note's reverb masking the start of the note k times higher: at that
   * note's attack (the level rising this much) its partials rise this much more than the
   * segment's own, which rise less than `reverbOwnRiseDb` (each rise capped at `reverbRiseCapDb`,
   * as out of silence both rise all the way).
   */
  reverbRiseDb: 6,
  reverbOwnRiseDb: 8,
  reverbRiseCapDb: 24,
  /** A segment at most this long that is mostly sliding (or scooping) joins the note it leads into… */
  slideMaxSeconds: 0.4,
  /** …and so does a scoop into a note (or a fall off it) under the note's vibrato, measured on this much of the note after its first part (a chain of segments must be this smooth once the vibrato is out). */
  scoopVibratoSeconds: 0.4,
  scoopReachSeconds: 0.15,
  scoopSmoothSemitones: 0.15,
  /** Pitch movement: slope that counts as moving, travel that makes a slide (vibrato swings back). */
  motionSemitonesPerSecond: 3,
  slideMinSemitones: 0.6,
  /** A movement faster than this from 20 % to 80 % of the way (or covering 60 % of it this fast) is a jump (a finger change), not a slide… */
  jumpSeconds: 0.02,
  /** …and so is any step between two frames faster than this. */
  jumpSemitonesPerSecond: 150,
  /** Slides at least this fast (1 semitone per 100 ms) count towards `glideShare`. */
  glideSemitonesPerSecond: 10,
  /** A stretch of the raw contour this long within this range, inside a movement, is a note of a fast run. */
  plateauSeconds: 0.04,
  plateauSemitones: 0.15,
  vibratoMinNoteSeconds: 0.25,
  vibratoMinHz: 3,
  vibratoMaxHz: 9,
  /** Normalised autocorrelation the vibrato period must reach to report a rate. */
  vibratoMinCorrelation: 0.3,
  /** A note has vibrato (for `vibratoShare`, onset and AM phase) with a rate and at least this width… */
  vibratoMinExtentCents: 8,
  /** …and `vibratoShare` counts the notes at least this long. */
  vibratoShareMinSeconds: 0.4,
  /**
   * Trill: swings of at least this many cents, peak to peak, at this many cycles per second, at
   * least `trillMinSwings` in a row. Tuned for the 3.5–4.5-semitone "Mongolian trill"; whole-tone
   * trills (a pentatonic neighbour two semitones up) are not timed as trills.
   */
  trillMinCents: 250,
  trillMinHz: 4,
  trillMaxHz: 12,
  trillMinSwings: 4,
  /** A trill's rate is timed only over this many swings or more (3 cycles; shorter ones are counted but not timed). */
  trillTimedSwings: 6,
  harmonics: 10,
  /** Harmonic peaks are searched within ±3 % of k·f0. */
  harmonicSearch: 0.03,
  /** Level reported for harmonics above Nyquist. */
  harmonicFloorDb: -80,
  /** FFT frames per note (spread over its middle 60 %). */
  spectrumFrames: 4,
  hnrMaxHz: 5000,
  /**
   * HNR is capped here. Measured on a Blackman–Harris spectrum it follows the noise down to
   * about 45 dB with ±30 cents of vibrato and to the cap on a straight tone.
   */
  hnrCeilingDb: 60,
  centroidMaxHz: 8000,
  /** The long-term spectrum uses notes at least this long. */
  ltasMinNoteSeconds: 0.4,
  /** The loudness range needs this many notes. */
  dynamicsMinNotes: 5,
  /** A note's envelope must rise at least this much for an attack time. */
  attackMinRiseDb: 6,
  /** Tempo: beat range searched (quarter notes), the prior's centre (a log-Gaussian one octave wide), onsets needed. */
  tempoMinBpm: 40,
  tempoMaxBpm: 240,
  tempoPriorBpm: 120,
  tempoMinOnsets: 8,
  /** Inter-onset intervals longer than this span a phrase break and are left out of the rhythm ratios. */
  ioiMaxSeconds: 2,
  /** A ratio peak must hold this share of the successive-interval pairs; `ioiRatio` needs this ratio or more. */
  ioiPeakShare: 0.15,
  ioiUnevenRatio: 1.15
}

/**
 * How close "close to the original" is, per feature. Relative tolerances are fractions of the
 * original's value. Engineering targets, not yet validated by listening: tune them as research
 * and the user's blind listening come in.
 */
export const COMPARISON_TOLERANCES = {
  /** Median pitch, after moving the original into our key (so it measures the tuning). */
  f0Cents: 50,
  vibratoRateHz: 0.8,
  vibratoExtentCents: 12,
  /** H2−H1 and H3−H1. */
  harmonicBalanceDb: 4,
  centroidRelative: 0.2,
  hnrDb: 4,
  /** A key difference this large or more leaves brightness and HNR unscored (another register). */
  registerSemitones: 7,
  attackRelative: 0.4,
  noteRateRelative: 0.2,
  glideShare: 0.1,
  tempoRelative: 0.05,
  /** Relative to the original's tempo variance, but never tighter than `tempoVarianceFloor`. */
  tempoVarianceRelative: 0.3,
  tempoVarianceFloor: 0.02,
  /** Any key difference (a whole semitone or more) is reported, as information: it is not scored. */
  transpositionSemitones: 0.5,
  /** Share of our notes the original's melody must match. */
  melodyShare: 0.9,
  vibratoShare: 0.15,
  vibratoOnsetRelative: 0.3,
  /** AM/FM phase: only the sign is compared, and only when both correlations are at least this strong. */
  amPhaseMinCorrelation: 0.15,
  trillRateHz: 0.5,
  trillExtentCents: 80,
  slideRelative: 0.3,
  /** Long-term spectrum: mean and largest band difference after level normalisation. */
  ltasMeanDb: 3,
  ltasMaxDb: 6,
  ioiRatioRelative: 0.1,
  dynamicRangeDb: 3
}

/** Comparison rows that apply to each kind of original (null = all). Timbre rows need a fiddle. */
export const REFERENCE_ROWS: Record<ReferenceKind, readonly string[] | null> = {
  fiddle: null,
  voice: ['transposition', 'melody', 'tempo', 'tempoVariance', 'noteRate', 'ioiRatio', 'glideShare', 'slideLength', 'slideInterval'],
  piano: ['transposition', 'melody', 'tempo', 'tempoVariance', 'noteRate', 'ioiRatio'],
  ensemble: ['tempo', 'tempoVariance', 'ioiRatio']
}

/**
 * Checks of our own render against published measurements of the instrument (no original
 * needed): the soundbox maxima Bulanov measured, and the open male string's fundamental 1–2 dB
 * below its strongest overtone.
 */
export const RENDER_CHECKS = {
  bulanovMaximaHz: [170, 280, 440, 780, 1200, 1800, 2300, 3500],
  /** A maximum counts within this many octaves of its target… */
  bulanovSearchOctaves: 1 / 6,
  /** …and can be seen there when the response has data in the outer halves on both sides and no gap wider than this. */
  bulanovMaxGapOctaves: 1 / 8,
  bulanovMinFound: 6,
  /** Reading the response from notes' harmonics needs this many different pitches. */
  bulanovMinPitches: 6,
  /** The maxima near 280, 440 and 780 Hz lie within this many dB of each other. */
  bulanovMidSpreadDb: 4,
  /** H1 − max(H2, H3) of the open male string (F3 in the standard tuning), dB. */
  openStringBalanceDb: [-3, 0] as const,
  openStringHz: 174.61
}

/** Centres of the long-term spectrum's 1/6-octave bands (edges 100·2^(k/6) Hz, 100 Hz–8 kHz). */
export const LTAS_BANDS_HZ: readonly number[] = Array.from({ length: 38 }, (_, k) => 100 * 2 ** ((k + 0.5) / 6))

const MIN_DB = -120

/** Harmonics a bow onset can briefly sound: octave, twelfth, double octave. */
const ONSET_HARMONICS = [12, 19.02, 24]

const SUBHARMONICS = [2, 3, 4, 5, 6, 7, 8].map((k) => 12 * Math.log2(k))

/** k when `low` is the k-th subharmonic of `high` (both MIDI, ±0.5 semitone), else 0 (also for NaN). */
function subharmonicOf(low: number, high: number): number {
  const i = SUBHARMONICS.findIndex((d) => Math.abs(high - low - d) < 0.5)
  return i < 0 ? 0 : i + 2
}

const powerDb = (power: number) => (power > 0 ? Math.max(MIN_DB, 10 * Math.log10(power)) : MIN_DB)

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Linear-interpolated percentile (0–1) of unsorted values; null when empty. */
function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const x = p * (sorted.length - 1)
  const i = Math.floor(x)
  return i + 1 < sorted.length ? sorted[i]! + (x - i) * (sorted[i + 1]! - sorted[i]!) : sorted[i]!
}

const nonNull = (values: readonly (number | null | undefined)[]) => values.filter((v): v is number => v !== null && v !== undefined)

/** Averages the channels (unequal lengths are zero-padded). */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]!.slice()
  const out = new Float32Array(Math.max(...channels.map((c) => c.length)))
  for (const channel of channels) for (let i = 0; i < channel.length; i++) out[i] = out[i]! + channel[i]!
  const scale = 1 / channels.length
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * scale
  return out
}

// ---------------------------------------------------------------------------------------------
// Pitch track
// ---------------------------------------------------------------------------------------------

/** Mean-square level in dB over two hops around each frame centre. */
function frameLevels(samples: Float32Array, sampleRate: number, hop: number, count: number): Float64Array {
  const out = new Float64Array(count)
  const half = Math.max(1, Math.round(hop * sampleRate))
  for (let i = 0; i < count; i++) {
    const centre = Math.round(i * hop * sampleRate)
    const a = Math.max(0, centre - half)
    const b = Math.min(samples.length, centre + half)
    let sum = 0
    for (let j = a; j < b; j++) sum += samples[j]! * samples[j]!
    out[i] = powerDb(sum / Math.max(1, b - a))
  }
  return out
}

/** Integer-factor downsampling behind a Blackman-windowed sinc low-pass at 0.38 × the new rate. */
function decimate(samples: Float32Array, factor: number): Float32Array {
  const taps = 16 * factor + 1
  const mid = (taps - 1) / 2
  const cutoff = 0.38 / factor
  const h = new Float64Array(taps)
  let sum = 0
  for (let k = 0; k < taps; k++) {
    const x = k - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (taps - 1))
    h[k] = sinc * w
    sum += h[k]!
  }
  for (let k = 0; k < taps; k++) h[k] = h[k]! / sum
  const out = new Float32Array(Math.floor(samples.length / factor))
  for (let j = 0; j < out.length; j++) {
    const base = j * factor - mid
    const k0 = Math.max(0, -base)
    const k1 = Math.min(taps, samples.length - base)
    let acc = 0
    for (let k = k0; k < k1; k++) acc += h[k]! * samples[base + k]!
    out[j] = acc
  }
  return out
}

/** Energy at h·freq, h = 1…count (Goertzel), of an already windowed frame. */
function partialEnergies(windowed: Float64Array, rate: number, freq: number, count: number): Float64Array {
  const energy = new Float64Array(count + 1)
  for (let h = 1; h <= count; h++) {
    const coeff = 2 * Math.cos((2 * Math.PI * h * freq) / rate)
    let s1 = 0
    let s2 = 0
    for (let j = 0; j < windowed.length; j++) {
      const s = windowed[j]! + coeff * s1 - s2
      s2 = s1
      s1 = s
    }
    energy[h] = s1 * s1 + s2 * s2 - coeff * s1 * s2
  }
  return energy
}

interface PitchTrack {
  /** MIDI pitch per frame (NaN = unvoiced). */
  midi: Float64Array
  /**
   * Energies at the multiples of `freq` in frame `i` (index h = the h-th partial, up to `count` or
   * as many as fit below 0.4 × the analysis rate), computed on demand; null outside the audio.
   */
  partials(i: number, freq: number, count: number): Float64Array | null
}

function trackPitch(samples: Float32Array, sampleRate: number, hop: number, levels: Float64Array, minFreq: number, maxFreq: number): PitchTrack {
  const midi = new Float64Array(levels.length).fill(NaN)
  let loudest = -Infinity
  for (const v of levels) loudest = Math.max(loudest, v)
  const gate = Math.max(ANALYSIS.silenceDb, loudest - ANALYSIS.gateDb)
  // YIN's cost grows with the square of the lag range, so work at ≥ 5× the highest pitch only.
  const factor = Math.max(1, Math.floor(sampleRate / Math.max(8000, 5 * maxFreq)))
  const low = factor > 1 ? decimate(samples, factor) : samples
  const lowRate = sampleRate / factor
  const length = 2 * Math.ceil(lowRate / minFreq) + 2
  const windowed = new Float64Array(length)
  const hann = hannWindow(length)
  const frameAt = (i: number) => {
    const start = Math.min(low.length - length, Math.max(0, Math.round(i * hop * lowRate) - (length >> 1)))
    return low.subarray(start, start + length)
  }
  const partials = (i: number, freq: number, count: number) => {
    if (low.length < length || i < 0 || i >= levels.length) return null
    const frame = frameAt(i)
    for (let j = 0; j < length; j++) windowed[j] = frame[j]! * hann[j]!
    return partialEnergies(windowed, lowRate, freq, Math.min(count, Math.floor((0.4 * lowRate) / freq)))
  }
  if (low.length < length) return { midi, partials }
  for (let i = 0; i < levels.length; i++) {
    if (levels[i]! < gate) continue
    const frame = frameAt(i)
    const est = detectPitch(frame, lowRate, { minFreq, maxFreq, threshold: ANALYSIS.yinThreshold })
    if (!est || est.confidence < ANALYSIS.voicingConfidence) continue
    for (let j = 0; j < length; j++) windowed[j] = frame[j]! * hann[j]!
    midi[i] = freqToMidi(est.freq * periodDivisor(windowed, lowRate, est.freq, maxFreq))
  }
  return { midi, partials }
}

/**
 * Checks a YIN period against the partials it predicts (Goertzel at h·f on the windowed frame)
 * and returns the factor its frequency should be multiplied by:
 * - detectPitch's weak-fundamental check can settle on 2 or 3 periods when the true period falls
 *   between samples (worse at low sample rates and for high notes). Then the partials only the
 *   longer period would have (f, 3f, 5f… for 2 periods) are missing.
 * - Where a note overlaps the reverb of the one before, the mixture repeats at their common
 *   period (½ the lower note's frequency for a fifth, ⅓ for a fourth, ¼ for a major third…),
 *   which has nothing at its own fundamental. The played note is then the comb k·f that holds
 *   most of the energy.
 * A genuinely weak fundamental keeps its other partials (3f, 5f…), so it is left alone.
 */
function periodDivisor(windowed: Float64Array, rate: number, freq: number, maxFreq: number): number {
  const count = Math.min(16, Math.floor((0.4 * rate) / freq))
  if (count < 4) return 1
  const energy = partialEnergies(windowed, rate, freq, count)
  let total = 0
  let strongest = 0
  for (let h = 1; h <= count; h++) {
    total += energy[h]!
    strongest = Math.max(strongest, energy[h]!)
  }
  if (total <= 0) return 1
  const comb = (k: number) => {
    let sum = 0
    for (let h = k; h <= count; h += k) sum += energy[h]!
    return sum / total
  }
  for (const k of [2, 3]) {
    if (freq * k <= maxFreq && count >= 2 * k && 1 - comb(k) < 0.08 * comb(k)) return k
  }
  if (energy[1]! >= 0.003 * strongest) return 1
  const factors = [2, 3, 4, 5, 6, 7, 8].filter((k) => k <= count && freq * k <= maxFreq)
  const best = Math.max(0, ...factors.map(comb))
  // The largest factor that explains nearly as much as the best (a comb of 4 is also one of 2).
  const k = factors.filter((f) => comb(f) >= 0.9 * best).pop()
  return k !== undefined && best >= 0.5 ? k : 1
}

/**
 * A frame more than a fifth away from both neighbourhoods (±3 frames) is a tracking error: moved
 * by the octave (or twelfth) that puts it back in line, else dropped. Real leaps keep one side.
 */
function fixOctaveErrors(midi: Float64Array): void {
  const src = midi.slice()
  const side = (from: number, to: number) => {
    const values: number[] = []
    for (let j = Math.max(0, from); j <= Math.min(src.length - 1, to); j++) if (!Number.isNaN(src[j]!)) values.push(src[j]!)
    return median(values)
  }
  for (let i = 0; i < src.length; i++) {
    const m = src[i]!
    if (Number.isNaN(m)) continue
    const left = side(i - 3, i - 1)
    const right = side(i + 1, i + 3)
    const near = (value: number, limit: number) => (left !== null && Math.abs(value - left) <= limit) || (right !== null && Math.abs(value - right) <= limit)
    if ((left === null && right === null) || near(m, 7)) continue
    const shift = [12, -12, 19.02, -19.02, 24, -24].find((s) => near(m - s, 1))
    midi[i] = shift === undefined ? NaN : m - shift
  }
}

/**
 * Up to `spikeFrames` frames more than `spikeSemitones` off both neighbourhoods (3 frames each side,
 * steady within 0.3 semitone) that agree with each other are put back on their level: a mixture
 * of the note and another note's reverb read between them. A trill's or vibrato's swing has no
 * steady sides.
 */
function dropSpikes(midi: Float64Array): void {
  const src = midi.slice()
  const side = (from: number, to: number) => {
    const values: number[] = []
    for (let j = Math.max(0, from); j <= Math.min(src.length - 1, to); j++) if (!Number.isNaN(src[j]!)) values.push(src[j]!)
    return values.length === 3 && Math.max(...values) - Math.min(...values) <= 0.3 ? median(values) : null
  }
  for (let i = 0; i < src.length; i++) {
    for (let w = 1; w <= ANALYSIS.spikeFrames; w++) {
      const [left, right] = [side(i - 3, i - 1), side(i + w, i + w + 2)]
      if (left === null || right === null || Math.abs(left - right) >= ANALYSIS.noteStepSemitones) continue
      let off = true
      for (let j = i; j < i + w && off; j++) off = !Number.isNaN(src[j]!) && Math.abs(src[j]! - left) > ANALYSIS.spikeSemitones && Math.abs(src[j]! - right) > ANALYSIS.spikeSemitones
      if (off) midi.fill((left + right) / 2, i, i + w)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Slides and note segmentation
// ---------------------------------------------------------------------------------------------

/** A slide over frames first…last: `semitones` travelled (signed) in `seconds` (the whole movement). */
interface Slide {
  first: number
  last: number
  seconds: number
  semitones: number
  /** Steady pitch on both sides (a slide between two notes, not a scoop out of nothing). */
  between: boolean
}

/** Least-squares solution of `rows` · x = `y` (normal equations, Gaussian elimination); null if singular. */
function leastSquares(rows: readonly (readonly number[])[], y: readonly number[]): number[] | null {
  const d = rows[0]?.length ?? 0
  const m = Array.from({ length: d }, (_, r) => {
    const line = new Array<number>(d + 1).fill(0)
    rows.forEach((row, k) => {
      for (let c = 0; c < d; c++) line[c] = line[c]! + row[r]! * row[c]!
      line[d] = line[d]! + row[r]! * y[k]!
    })
    return line
  })
  for (let col = 0; col < d; col++) {
    let pivot = col
    for (let r = col + 1; r < d; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    const p = m[col]![col]!
    if (Math.abs(p) < 1e-9) return null
    for (let r = 0; r < d; r++) {
      if (r === col) continue
      const f = m[r]![col]! / p
      for (let c = col; c <= d; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!
    }
  }
  return m.map((row, k) => row[d]! / row[k]!)
}

/**
 * Vibrato around a movement: one sinusoid (`vibratoMinHz`–`vibratoMaxHz`) fitted together with a
 * level on each side to the steady frames before and after it, carried through the movement. Null
 * when it is narrower than 5 cents or leaves more than half of either side's deviation from its level.
 */
function vibratoAcross(midi: Float64Array, before: readonly number[], after: readonly number[], hop: number): { at: (j: number) => number; before: number; after: number } | null {
  const frames = [...before, ...after]
  const y = frames.map((j) => midi[j]!)
  const mean = (values: readonly number[]) => values.reduce((s, v) => s + v, 0) / values.length
  const [m1, m2] = [mean(y.slice(0, before.length)), mean(y.slice(before.length))]
  let best: { sse: number; x: number[]; w: number } | null = null
  for (let hz = ANALYSIS.vibratoMinHz; hz <= ANALYSIS.vibratoMaxHz + 1e-9; hz += 0.25) {
    const w = 2 * Math.PI * hz * hop
    const rows = frames.map((j, k) => [k < before.length ? 1 : 0, k < before.length ? 0 : 1, Math.cos(w * j), Math.sin(w * j)])
    const x = leastSquares(rows, y)
    if (!x) continue
    const sse = rows.reduce((s, row, k) => s + (y[k]! - row.reduce((t, v, c) => t + v * x[c]!, 0)) ** 2, 0)
    if (!best || sse < best.sse) best = { sse, x, w }
  }
  if (!best || Math.hypot(best.x[2]!, best.x[3]!) < 0.05) return null
  const { x, w } = best
  // One vibrato running through: it must explain each side (a vibrato restarting after a slide does not).
  const side = (from: number, to: number, level: number, fitted: number) => {
    let [plain, left] = [0, 0]
    for (let k = from; k < to; k++) {
      plain += (y[k]! - level) ** 2
      left += (y[k]! - fitted - x[2]! * Math.cos(w * frames[k]!) - x[3]! * Math.sin(w * frames[k]!)) ** 2
    }
    return left <= 0.5 * plain
  }
  if (!side(0, before.length, m1, x[0]!) || !side(before.length, frames.length, m2, x[1]!)) return null
  return { at: (j) => x[2]! * Math.cos(w * j) + x[3]! * Math.sin(w * j), before: x[0]!, after: x[1]! }
}

/**
 * Vibrato over `frames` of one note: one sinusoid (`vibratoMinHz`–`vibratoMaxHz`) fitted on a
 * straight trend, as a function of the frame (it carries on outside them); null when it is
 * narrower than `vibratoMinExtentCents` or leaves more than half of the detrended contour.
 */
function vibratoWave(midi: Float64Array, frames: readonly number[], hop: number): ((f: number) => number) | null {
  if (frames.length * hop < 1 / ANALYSIS.vibratoMinHz) return null
  const f0 = frames[0]!
  const y = frames.map((f) => midi[f]!)
  const trend = leastSquares(
    frames.map((f) => [1, f - f0]),
    y
  )
  if (!trend) return null
  const flat = frames.reduce((sum, f, k) => sum + (y[k]! - trend[0]! - trend[1]! * (f - f0)) ** 2, 0)
  let best: { sse: number; x: number[]; w: number } | null = null
  for (let hz = ANALYSIS.vibratoMinHz; hz <= ANALYSIS.vibratoMaxHz + 1e-9; hz += 0.1) {
    const w = 2 * Math.PI * hz * hop
    const rows = frames.map((f) => [1, f - f0, Math.cos(w * (f - f0)), Math.sin(w * (f - f0))])
    const x = leastSquares(rows, y)
    if (!x) continue
    const sse = rows.reduce((sum, row, k) => sum + (y[k]! - row.reduce((t, v, c) => t + v * x[c]!, 0)) ** 2, 0)
    if (!best || sse < best.sse) best = { sse, x, w }
  }
  if (!best || best.sse > 0.5 * flat || 100 * Math.hypot(best.x[2]!, best.x[3]!) < ANALYSIS.vibratoMinExtentCents) return null
  const { x, w } = best
  return (f) => x[2]! * Math.cos(w * (f - f0)) + x[3]! * Math.sin(w * (f - f0))
}

/**
 * Centre and length (in samples of `progress`) of a movement from 0 to 1: the least-squares best of a
 * straight and a raised-cosine ramp, searched around the 20–80 % crossings' centre and length.
 */
function fitRamp(progress: readonly number[], centre: number, length: number): { centre: number; length: number } {
  let best = { sse: Infinity, centre, length: length / 0.6 }
  for (let l = Math.max(1.5, 1.2 * length); l <= 4 * length; l *= 1.04) {
    for (let c = centre - 2; c <= centre + 2; c += 0.25) {
      for (const eased of [false, true]) {
        let sse = 0
        for (let j = 0; j < progress.length; j++) {
          const u = Math.min(1, Math.max(0, (j - c) / l + 0.5))
          sse += (progress[j]! - (eased ? 0.5 - 0.5 * Math.cos(Math.PI * u) : u)) ** 2
        }
        if (sse < best.sse) best = { sse, centre: c, length: l }
      }
    }
  }
  return best
}

/**
 * Frames inside a slide: a monotonic pitch movement of ≥ `slideMinSemitones` that stays where it
 * arrives and did not just come from there (vibrato and trills swing back and forth) and takes
 * ≥ `jumpSeconds` from 20 % to 80 % of the way without covering 60 % of it that fast (quicker is a
 * jump, e.g. a finger change; vibrato running on through it is taken out first). Movement is
 * found on a lightly smoothed contour with hysteresis, so jitter does not cut a slow scoop into
 * pieces too short to count, and split at the plateaus of the raw contour when that shows a
 * staircase of jumps (a fast run). It is timed between the steady levels on either side, and its
 * whole length is that of the better-fitting straight or raised-cosine ramp. Nothing moves across
 * a re-articulation or an instant jump (faster than `jumpSemitonesPerSecond` from one frame to the
 * next). `glide` marks the slides at least `glideSemitonesPerSecond` fast.
 */
function slideFrames(midi: Float64Array, onsets: Uint8Array, hop: number): { moving: Uint8Array; glide: Uint8Array; slides: Slide[] } {
  const n = midi.length
  const voiced = (i: number) => i >= 0 && i < n && !Number.isNaN(midi[i]!)
  const maxStep = ANALYSIS.jumpSemitonesPerSecond * hop
  /** Frames i and i + 1 are voiced and belong to one continuous movement. */
  const linked = (i: number) => voiced(i) && voiced(i + 1) && !onsets[i + 1] && Math.abs(midi[i + 1]! - midi[i]!) <= maxStep
  // Triangular 5-frame smoothing inside linked stretches.
  const smooth = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    if (!voiced(i)) continue
    let sum = 3 * midi[i]!
    let weight = 3
    for (let d = 1; d <= 2 && linked(i + d - 1); d++) {
      sum += (3 - d) * midi[i + d]!
      weight += 3 - d
    }
    for (let d = 1; d <= 2 && linked(i - d); d++) {
      sum += (3 - d) * midi[i - d]!
      weight += 3 - d
    }
    smooth[i] = sum / weight
  }
  const slope = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    if (linked(i - 2) && linked(i - 1) && linked(i) && linked(i + 1)) {
      slope[i] = (2 * (smooth[i + 2]! - smooth[i - 2]!) + smooth[i + 1]! - smooth[i - 1]!) / (10 * hop)
    } else if (linked(i - 1) && linked(i)) slope[i] = (smooth[i + 1]! - smooth[i - 1]!) / (2 * hop)
  }
  const high = ANALYSIS.motionSemitonesPerSecond
  const low = high / 3
  // Runs moving at ≥ `low` in one direction that reach `high` somewhere.
  const runs: { a: number; b: number; dir: number }[] = []
  for (let i = 0; i < n; ) {
    const dir = slope[i]! >= low ? 1 : slope[i]! <= -low ? -1 : 0
    let end = i
    while (dir !== 0 && linked(end) && slope[end + 1]! * dir >= low) end++
    let peak = 0
    for (let j = i; j <= end; j++) peak = Math.max(peak, slope[j]! * dir)
    if (dir !== 0 && peak >= high) runs.push({ a: i, b: end, dir })
    i = end + 1
  }
  // Rejoin a run that jitter or vibrato interrupted for a few frames without turning back.
  const joined: typeof runs = []
  for (const run of runs) {
    const last = joined[joined.length - 1]
    let bridged = !!last && last.dir === run.dir && run.a - last.b <= 4 && (smooth[run.a]! - smooth[last.b]!) * run.dir >= (low / 4) * (run.a - last.b) * hop
    for (let j = last ? last.b : 0; bridged && j < run.a; j++) bridged = linked(j) && (smooth[last!.b]! - smooth[j + 1]!) * run.dir <= 0.1
    if (bridged) last!.b = run.b
    else joined.push({ ...run })
  }
  /** The contour covers ≥ 60 % of `travel` within `jumpSeconds` somewhere in a…b: a finger change. */
  const jumpWindow = Math.max(1, Math.round(ANALYSIS.jumpSeconds / hop))
  const jumps = (a: number, b: number, travel: number, at = (j: number) => midi[j]!) => {
    for (let j = a; j + jumpWindow <= b; j++) if (Math.abs(at(j + jumpWindow) - at(j)) >= 0.6 * Math.abs(travel)) return true
    return false
  }
  // A fast run of short notes smooths into one slow movement: split a movement at the plateaus of
  // its raw contour and keep the split if a piece is a jump (a staircase of finger changes). A
  // flat spot inside a slow scoop leaves slow pieces only.
  const plateau = Math.max(3, Math.round(ANALYSIS.plateauSeconds / hop))
  const split = (m: { first: number; last: number; a: number; b: number; dir: number }) => {
    const pieces: (typeof m)[] = []
    let from = m.a
    for (let p = m.a + 1; p < m.b; p++) {
      let [lo, hi, q] = [midi[p]!, midi[p]!, p]
      while (q + 1 < m.b && Math.max(hi, midi[q + 1]!) - Math.min(lo, midi[q + 1]!) <= ANALYSIS.plateauSemitones) {
        q++
        lo = Math.min(lo, midi[q]!)
        hi = Math.max(hi, midi[q]!)
      }
      if (q - p + 1 < plateau) continue
      pieces.push({ first: from, last: p, a: from, b: p, dir: m.dir })
      from = p = q
    }
    if (!pieces.length) return [m]
    pieces.push({ first: from, last: m.b, a: from, b: m.b, dir: m.dir })
    const travel = (s: typeof m) => midi[s.b]! - midi[s.a]!
    return pieces.some((s) => Math.abs(travel(s)) >= ANALYSIS.slideMinSemitones && jumps(s.a, s.b, travel(s))) ? pieces : [m]
  }
  // Movements that travel far enough, stay where they arrive and did not just come from there
  // (vibrato swings back and forth).
  const settle = Math.round(0.15 / hop)
  const candidates = joined
    .flatMap(({ a: first, b: last, dir }) => split({ first, last, a: linked(first - 1) ? first - 1 : first, b: linked(last) ? last + 1 : last, dir }))
    .filter(({ a, b, dir }) => {
      const travel = smooth[b]! - smooth[a]!
      if (travel * dir < ANALYSIS.slideMinSemitones) return false
      let swing = 0
      for (let j = b; j < b + settle && linked(j); j++) swing = Math.max(swing, (smooth[b]! - smooth[j + 1]!) * dir)
      for (let j = a; j > a - settle && linked(j - 1); j--) swing = Math.max(swing, (smooth[j - 1]! - smooth[a]!) * dir)
      return swing <= 0.5 * Math.abs(travel)
    })
  const moving = new Uint8Array(n)
  const glide = new Uint8Array(n)
  const slides: Slide[] = []
  const inSlide = new Uint8Array(n)
  for (const { a, b } of candidates) inSlide.fill(1, a, b + 1)
  const reach = Math.round(0.15 / hop)
  /** Median of the raw contour beyond `edge` (up to `reach` linked frames outside any movement, within a note step of the edge), else the edge frame. */
  const levelBeyond = (edge: number, step: number) => {
    const frames: number[] = []
    const near = (j: number) => !inSlide[j] && Math.abs(midi[j]! - midi[edge]!) <= ANALYSIS.noteStepSemitones
    for (let j = edge; frames.length < reach && (step > 0 ? linked(j) : linked(j - 1)) && near(j + step); j += step) frames.push(j + step)
    return frames.length >= 3 ? { level: median(frames.map((j) => midi[j]!))!, steady: true, frames } : { level: midi[edge]!, steady: false, frames }
  }
  for (const { first, last, a, b, dir } of candidates) {
    // Steady levels just outside the movement (vibrato averages out), and the 20 % / 80 % crossings
    // nearest the steepest frame.
    const before = levelBeyond(a, -1)
    const after = levelBeyond(b, 1)
    const from = before.level
    const span = after.level - from
    if (span * dir < ANALYSIS.slideMinSemitones) continue
    let steepest = first
    for (let j = first; j <= last; j++) if (slope[j]! * dir > slope[steepest]! * dir) steepest = j
    const progress = (j: number) => (midi[j]! - from) / span
    let half = -1
    for (let j = a; j < b; j++) if (progress(j) < 0.5 && progress(j + 1) >= 0.5 && (half < 0 || Math.abs(j - steepest) < Math.abs(half - steepest))) half = j
    if (half < 0) continue
    let t20 = a
    for (let j = half; j >= a; j--) {
      if (progress(j) <= 0.2) {
        t20 = j + (0.2 - progress(j)) / (progress(j + 1) - progress(j))
        break
      }
    }
    let t80 = b
    for (let j = half + 1; j <= b; j++) {
      if (progress(j) >= 0.8) {
        t80 = j - 1 + (0.8 - progress(j - 1)) / (progress(j) - progress(j - 1))
        break
      }
    }
    const seconds = (t80 - t20) * hop
    if (seconds < Math.max(ANALYSIS.jumpSeconds, 1.5 * hop)) continue
    // Vibrato running on through a finger change stretches its crossings: judge the jump without it.
    const wobble = before.steady && after.steady ? vibratoAcross(midi, before.frames, after.frames, hop) : null
    const at = (j: number) => midi[j]! - (wobble ? wobble.at(j) : 0)
    if (jumps(a, b, Math.min(Math.abs(wobble ? wobble.after - wobble.before : span), Math.abs(at(b) - at(a))), at)) continue
    const fast = (0.6 * Math.abs(span)) / seconds >= ANALYSIS.glideSemitonesPerSecond
    // The whole movement, whatever its shape (20–80 % is 60 % of a straight slide, 41 % of a smooth one).
    const ramp = fitRamp(Array.from({ length: b - a + 1 }, (_, k) => progress(a + k)), (t20 + t80) / 2 - a, t80 - t20)
    const start = Math.max(a, Math.round(a + ramp.centre - ramp.length / 2))
    const end = Math.min(b, Math.round(a + ramp.centre + ramp.length / 2))
    for (let j = start; j <= end; j++) {
      moving[j] = 1
      if (fast) glide[j] = 1
    }
    slides.push({ first: start, last: end, seconds: ramp.length * hop, semitones: span, between: before.steady && after.steady })
  }
  return { moving, glide, slides }
}

/**
 * Frames that start a re-articulation: the rise out of a dip ≥ `onsetDipDb` below both sides, or
 * (in a wet room, where reverb fills the dip) an attack: a rise of ≥ `attackRiseDb` within
 * `attackRiseSeconds` that includes a step of ≥ `attackStepDbPerSecond`, faster than vibrato's
 * loudness swing or reverb beating. The onset is the steepest step of the rise, so a reverb tail
 * ringing on (and building up) through a rest stays with the note it belongs to.
 */
function dipOnsets(levels: Float64Array, hop: number): Uint8Array {
  const n = levels.length
  const onsets = new Uint8Array(n)
  const back = Math.max(1, Math.round(0.15 / hop))
  const ahead = Math.max(1, Math.round(0.1 / hop))
  const attack = Math.max(1, Math.round(ANALYSIS.attackRiseSeconds / hop))
  const step = ANALYSIS.attackStepDbPerSecond * hop
  for (let i = 1; i + 1 < n; i++) {
    const e = levels[i]!
    if (!(e <= levels[i - 1]! && e < levels[i + 1]!)) continue
    let before = -Infinity
    for (let j = Math.max(0, i - back); j < i; j++) before = Math.max(before, levels[j]!)
    let rise = -1
    let steepest = i + 1
    for (let j = i + 1; j <= Math.min(n - 1, i + ahead) && levels[j]! >= e && rise < 0; j++) {
      if (levels[j]! - levels[j - 1]! > levels[steepest]! - levels[steepest - 1]!) steepest = j
      const dip = before - e >= ANALYSIS.onsetDipDb && levels[j]! - e >= ANALYSIS.onsetDipDb
      // The attack's rise, counted from the lowest level within `attackRiseSeconds` before it.
      let from = levels[j - 1]!
      for (let k = Math.max(i, j - attack); k < j; k++) from = Math.min(from, levels[k]!)
      const sharp = levels[j]! - from >= ANALYSIS.attackRiseDb && levels[steepest]! - levels[steepest - 1]! >= step
      if (dip || sharp) rise = j
    }
    if (rise >= 0) onsets[steepest] = 1
  }
  return onsets
}

/** Runs of voiced frames, bridging unvoiced gaps of up to `bridge` frames. */
function voicedRegions(midi: Float64Array, bridge: number): [number, number][] {
  const regions: [number, number][] = []
  let first = -1
  let last = -1
  for (let i = 0; i < midi.length; i++) {
    if (Number.isNaN(midi[i]!)) continue
    if (first >= 0 && i - last - 1 > bridge) {
      regions.push([first, last])
      first = -1
    }
    if (first < 0) first = i
    last = i
  }
  if (first >= 0) regions.push([first, last])
  return regions
}

/**
 * Optimal partition into constant levels minimising squared error + `penalty` per segment
 * (PELT pruning, segments capped at `maxLength`). Returns the segment start indices.
 */
function partition(values: readonly number[], penalty: number, maxLength: number): number[] {
  const n = values.length
  const s1 = new Float64Array(n + 1)
  const s2 = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) {
    s1[i + 1] = s1[i]! + values[i]!
    s2[i + 1] = s2[i]! + values[i]! * values[i]!
  }
  const cost = (a: number, b: number) => {
    const sum = s1[b]! - s1[a]!
    return s2[b]! - s2[a]! - (sum * sum) / (b - a)
  }
  const best = new Float64Array(n + 1)
  best[0] = -penalty
  const from = new Int32Array(n + 1)
  let candidates = [0]
  for (let t = 1; t <= n; t++) {
    let min = Infinity
    let arg = 0
    for (const c of candidates) {
      const v = best[c]! + cost(c, t) + penalty
      if (v < min) {
        min = v
        arg = c
      }
    }
    best[t] = min
    from[t] = arg
    candidates = candidates.filter((c) => t - c < maxLength && best[c]! + cost(c, t) <= min)
    candidates.push(t)
  }
  const starts: number[] = []
  for (let t = n; t > 0; t = from[t]!) starts.push(from[t]!)
  return starts.reverse()
}

interface Segment {
  /** First and last frame (voiced, unless blanked as a tracking slip). */
  first: number
  last: number
  /** Starts after a rest or an energy dip: never merged with the segment before on pitch alone. */
  onset: boolean
}

interface SegmentStats {
  level: number
  /** First and last voiced frame, and the median of the first and last three. */
  head: number
  tail: number
  headLevel: number
  tailLevel: number
  seconds: number
  slideShare: number
}

function segmentStats(seg: Segment, midi: Float64Array, moving: Uint8Array, hop: number): SegmentStats {
  const all: number[] = []
  const steady: number[] = []
  for (let f = seg.first; f <= seg.last; f++) {
    const m = midi[f]!
    if (Number.isNaN(m)) continue
    all.push(m)
    if (!moving[f]) steady.push(m)
  }
  return {
    level: median(steady.length >= 3 ? steady : all)!,
    head: all[0]!,
    tail: all[all.length - 1]!,
    headLevel: median(all.slice(0, 3))!,
    tailLevel: median(all.slice(-3))!,
    seconds: (seg.last - seg.first + 1) * hop,
    slideShare: 1 - steady.length / all.length
  }
}

/**
 * Turns the fitted segments of one voiced region into notes: fragments join the neighbour with
 * the closest pitch, slides join the note they lead into, and equal pitches without a
 * re-articulation between them are one note.
 */
function mergeSegments(input: readonly Segment[], midi: Float64Array, moving: Uint8Array, levels: Float64Array, hop: number, partials: PitchTrack['partials']): Segment[] {
  const segs = input.map((s) => ({ ...s }))
  const stats = segs.map((s) => segmentStats(s, midi, moving, hop))
  const join = (from: number, into: number) => {
    const a = Math.min(from, into)
    const b = a + 1
    let onset = segs[a]!.onset
    // A re-articulation inside the merged span moves to the nearest surviving boundary.
    if (from === b) {
      if (segs[b]!.onset && b + 1 < segs.length) segs[b + 1]!.onset = true
    } else onset ||= segs[b]!.onset
    const merged = { first: segs[a]!.first, last: segs[b]!.last, onset }
    segs.splice(a, 2, merged)
    stats.splice(a, 2, segmentStats(merged, midi, moving, hop))
  }
  const evidence = new Map<string, { offComb: number; fundamentalDb: number } | null>()
  const scoopCache = new Map<string, boolean>()
  const maskCache = new Map<string, boolean>()
  /** Median share of segment i's energy off the partials of the note k times higher, and its fundamental re its strongest partial. */
  const combEvidence = (i: number, k: number) => {
    const seg = segs[i]!
    const key = `${seg.first}:${seg.last}:${k}`
    if (evidence.has(key)) return evidence.get(key)!
    const frames: number[] = []
    for (let f = seg.first; f <= seg.last; f++) if (!Number.isNaN(midi[f]!)) frames.push(f)
    const step = Math.max(1, Math.floor(frames.length / 12))
    const off: number[] = []
    const fundamental: number[] = []
    for (let j = 0; j < frames.length; j += step) {
      const energy = partials(frames[j]!, midiToFreq(midi[frames[j]!]!), 16)
      const count = energy ? energy.length - 1 : 0
      if (count < 2 * k) continue
      let total = 0
      let comb = 0
      let strongest = 0
      for (let h = 1; h <= count; h++) {
        total += energy![h]!
        if (h % k === 0) comb += energy![h]!
        strongest = Math.max(strongest, energy![h]!)
      }
      if (total <= 0) continue
      off.push(1 - comb / total)
      fundamental.push(powerDb(energy![1]! / strongest))
    }
    const found = off.length ? { offComb: median(off)!, fundamentalDb: median(fundamental)! } : null
    evidence.set(key, found)
    return found
  }
  /**
   * Whether segment i sounds its own period rather than the partials of the note k times higher:
   * a real low note (re-bowed or legato, e.g. an open string between melody notes) has energy
   * between that note's partials even with a weak fundamental, a tracking slip or a mixture's
   * common period has almost none there, or nothing at its own fundamental. Unknown (too few
   * partials in range) counts as a real note.
   */
  const ownPeriod = (i: number, k: number): boolean => {
    const e = combEvidence(i, k)
    if (!e) return true
    const short = stats[i]!.seconds <= ANALYSIS.onsetTransientSeconds
    return e.offComb >= (short ? ANALYSIS.slipOffCombShort : ANALYSIS.slipOffComb) && (e.fundamentalDb > ANALYSIS.slipFundamentalDb || e.offComb >= ANALYSIS.slipOffCombWeakFundamental)
  }
  /** Energy (dB) in frame f on the partials of `freq` that are multiples of k (`comb`) and on the others (`off`). */
  const combLevels = (f: number, freq: number, k: number) => {
    const energy = partials(f, freq, 16)
    let [comb, off] = [0, 0]
    for (let h = 1; energy && h < energy.length; h++) {
      if (h % k === 0) comb += energy[h]!
      else off += energy[h]!
    }
    return { comb: powerDb(comb), off: powerDb(off) }
  }
  /**
   * Segment i (k-th subharmonic of the next) is an earlier note's reverb heard through the next
   * note's attack: that note (at least `minNoteSeconds`) follows without an onset, and from the
   * quietest frame in the `onsetTransientSeconds` before segment i to the median of as long after
   * its start the level rises at least `reverbRiseDb`, the next note's partials rise at least
   * `reverbRiseDb` more than segment i's own, and those rise less than `reverbOwnRiseDb`. A
   * re-bowed or slurred low note rises on all its partials alike (or keeps them level), so it stays.
   */
  const ringsOn = (i: number, k: number): boolean => {
    const next = i + 1
    if (next >= segs.length || segs[next]!.onset || stats[next]!.seconds < ANALYSIS.minNoteSeconds) return false
    const key = `${segs[i]!.first}:${segs[i]!.last}:${segs[next]!.first}:${segs[next]!.last}:${k}`
    if (!maskCache.has(key)) maskCache.set(key, masked(i, k))
    return maskCache.get(key)!
  }
  const masked = (i: number, k: number): boolean => {
    const next = i + 1
    const { first, last } = segs[i]!
    const reach = Math.max(1, Math.round(ANALYSIS.onsetTransientSeconds / hop))
    let dip = first - 1
    for (let f = first - 2; f >= Math.max(0, first - reach); f--) if (levels[f]! < levels[dip]!) dip = f
    if (dip < 0) return false
    const freq = midiToFreq(stats[i]!.level)
    const from = combLevels(dip, freq, k)
    const comb: number[] = []
    const off: number[] = []
    for (let f = first; f <= Math.min(last, first + reach); f++) {
      if (Number.isNaN(midi[f]!)) continue
      const e = combLevels(f, freq, k)
      comb.push(e.comb)
      off.push(e.off)
    }
    const attack: number[] = []
    for (let f = segs[next]!.first; f <= Math.min(segs[next]!.last, segs[next]!.first + reach); f++) attack.push(levels[f]!)
    if (!comb.length) return false
    // Out of silence both rise all the way; the difference is only the note's spectrum.
    const rise = (to: number, level: number) => Math.min(ANALYSIS.reverbRiseCapDb, to - level)
    const [levelRise, combRise, offRise] = [median(attack)! - levels[dip]!, rise(median(comb)!, from.comb), rise(median(off)!, from.off)]
    return levelRise >= ANALYSIS.reverbRiseDb && offRise < ANALYSIS.reverbOwnRiseDb && combRise - offRise >= ANALYSIS.reverbRiseDb
  }
  const slipInto = (i: number): number => {
    const s = stats[i]!
    if (s.seconds > ANALYSIS.slipMaxSeconds) return -1
    const short = s.seconds <= ANALYSIS.onsetTransientSeconds
    const level = (j: number) => (j >= 0 && j < segs.length ? stats[j]!.level : NaN)
    const next = i + 1
    // A harmonic at a bow onset gives way to the note for good; a pitch that comes back after the
    // lower one is the new note, heard through the previous note's reverb.
    const returns = next + 1 < segs.length && !segs[next + 1]!.onset && Math.abs(level(next + 1) - s.level) < ANALYSIS.noteStepSemitones
    if (segs[i]!.onset && short && next < segs.length && !segs[next]!.onset && !returns && ONSET_HARMONICS.some((jump) => Math.abs(s.level - level(next) - jump) < 0.6)) return next
    // A segment starting at an onset is a note unless its period is missing (the common period of
    // a mixture) or it is the old note's reverb; a legato one an octave below is also a plausible
    // short note, so it needs a second sign.
    const belongs = (j: number, other: number) => {
      const k = subharmonicOf(s.level, level(j))
      if (k < 2) return false
      if (j === next && ringsOn(i, k)) return true
      if (segs[i]!.onset) return !ownPeriod(i, k)
      return (k >= 3 || short || subharmonicOf(s.level, level(other)) >= 2) && !ownPeriod(i, k)
    }
    return belongs(next, i - 1) ? next : belongs(i - 1, next) ? i - 1 : -1
  }
  for (;;) {
    const slip = segs.findIndex((_, i) => slipInto(i) >= 0)
    if (slip >= 0) {
      const into = slipInto(slip)
      for (let f = segs[slip]!.first; f <= segs[slip]!.last; f++) midi[f] = NaN
      join(slip, into)
      continue
    }
    let fragment = -1
    // A region of its own, between silences, is a short note if it lasts `minNoteSeconds` with a
    // frame at either end (the tracker locks on a frame late and lets go a frame early).
    const lone = segs.length === 1 ? 2 * hop : 0
    stats.forEach((s, i) => {
      if (s.seconds + lone < ANALYSIS.minNoteSeconds && (fragment < 0 || s.seconds < stats[fragment]!.seconds)) fragment = i
    })
    if (fragment >= 0) {
      if (segs.length === 1) return []
      // The closer pitch, but on this side of a re-articulation if the other side is across one.
      const level = stats[fragment]!.level
      const dPrev = fragment > 0 ? Math.abs(stats[fragment - 1]!.level - level) : Infinity
      const dNext = fragment + 1 < segs.length ? Math.abs(stats[fragment + 1]!.level - level) : Infinity
      const [prevOpen, nextOpen] = [fragment > 0 && !segs[fragment]!.onset, fragment + 1 < segs.length && !segs[fragment + 1]!.onset]
      join(fragment, prevOpen !== nextOpen ? (prevOpen ? fragment - 1 : fragment + 1) : dPrev <= dNext ? fragment - 1 : fragment + 1)
      continue
    }
    const intoPrev = (i: number) => i > 0 && !segs[i]!.onset
    const intoNext = (i: number) => i + 1 < segs.length && !segs[i + 1]!.onset
    /**
     * Segment i moves most of the way to neighbour j's pitch and ends up (or starts) within a
     * note step of it: a scoop into the next note or a fall off the one before, too slow or
     * too wavy (vibrato on top) to count as moving frame by frame.
     */
    const approaches = (i: number, j: number) => {
      const s = stats[i]!
      const [near, far] = j > i ? [s.tailLevel, s.headLevel] : [s.headLevel, s.tailLevel]
      const target = stats[j]!.level
      return Math.abs(target - near) < ANALYSIS.noteStepSemitones && (near - far) * Math.sign(target - far) >= 0.5 * Math.abs(target - far)
    }
    /**
     * A stroke's first segments scooping into the note after them (or its last falling off the
     * note before) under that note's vibrato, which can hide the movement from `approaches`: the
     * vibrato fitted to the note's `scoopVibratoSeconds` beyond its first (last) `scoopReachSeconds`
     * is carried back through them and taken out, and the straight-line trend of the rest must head
     * for the note, arriving within 1.5 × their own length (at least `scoopReachSeconds`), or move
     * at least half `slideMinSemitones` towards it and run on into the note's first (last) frames
     * (which then hold the rest of the scoop). Vibrato on top of a scoop can leave steps in it, so
     * the stroke's segments up to i (at most `slideMaxSeconds` in all) count as one movement if,
     * without the vibrato, they are smooth (within `scoopSmoothSemitones` RMS of a parabola): a run
     * of notes is a staircase.
     */
    const scoops = (i: number, j: number): boolean => {
      const forward = j > i
      // The chain from the stroke's start (end) to i, within `slideMaxSeconds` in all.
      const within = (a: number, b: number) => (segs[b]!.last - segs[a]!.first + 1) * hop <= ANALYSIS.slideMaxSeconds
      let s = i
      if (forward) while (s > 0 && !segs[s]!.onset && within(s - 1, i)) s--
      else while (s + 1 < segs.length && !segs[s + 1]!.onset && within(i, s + 1)) s++
      const stroke = forward ? s === 0 || segs[s]!.onset : s === segs.length - 1 || segs[s + 1]!.onset
      if (!stroke) return false
      const [a, b] = forward ? [s, i] : [i, s]
      const key = `${segs[a]!.first}:${segs[b]!.last}:${segs[j]!.first}:${segs[j]!.last}`
      if (!scoopCache.has(key)) scoopCache.set(key, scoopsInto(a, b, j))
      return scoopCache.get(key)!
    }
    /** Whether segments a…b (one of them, or a chain) scoop into (or fall off) segment j. */
    const scoopsInto = (a: number, b: number, j: number): boolean => {
      const voicedIn = (from: number, to: number) => {
        const out: number[] = []
        for (let f = from; f <= to; f++) if (!Number.isNaN(midi[f]!)) out.push(f)
        return out
      }
      const note = voicedIn(segs[j]!.first, segs[j]!.last)
      const forward = j > b
      const [skip, count] = [ANALYSIS.scoopReachSeconds, ANALYSIS.scoopVibratoSeconds].map((t) => Math.round(t / hop)) as [number, number]
      const wave = vibratoWave(midi, forward ? note.slice(skip, skip + count) : note.slice(Math.max(0, note.length - skip - count), note.length - skip), hop)
      if (!wave) return false
      const frames = voicedIn(segs[a]!.first, segs[b]!.last)
      const flat = frames.map((f) => midi[f]! - wave(f))
      const line = leastSquares(
        frames.map((f) => [1, f - frames[0]!]),
        flat
      )
      if (!line || line[1] === 0) return false
      if (a !== b) {
        const bend = leastSquares(
          frames.map((f) => [1, f - frames[0]!, (f - frames[0]!) ** 2]),
          flat
        )
        if (!bend) return false
        const error = flat.reduce((sum, v, k) => sum + (v - bend[0]! - bend[1]! * (frames[k]! - frames[0]!) - bend[2]! * (frames[k]! - frames[0]!) ** 2) ** 2, 0)
        if (Math.sqrt(error / frames.length) > ANALYSIS.scoopSmoothSemitones) return false
      }
      const fit = (f: number) => line[0]! + line[1]! * (f - frames[0]!)
      const [nearFrame, farFrame] = forward ? [frames[frames.length - 1]!, frames[0]!] : [frames[0]!, frames[frames.length - 1]!]
      const [near, far] = [fit(nearFrame), fit(farFrame)]
      const target = stats[j]!.level
      const toward = Math.sign(target - far)
      const arrives = Math.abs(target - near) / Math.abs(line[1]!) <= 1.5 * Math.max(skip, frames.length)
      // The note may itself open with the rest of the scoop (already joined to it): the trend then
      // runs on into its first frames (its last, for a fall), vibrato taken out.
      const edge = forward ? note.slice(0, 3) : note.slice(-3)
      const continues =
        edge.length > 0 && Math.abs(edge[0]! - nearFrame) <= 3 && Math.abs(median(edge.map((f) => midi[f]! - wave(f)))! - fit(median(edge)!)) < ANALYSIS.noteStepSemitones
      const travel = (near - far) * toward
      if (continues && travel >= ANALYSIS.slideMinSemitones / 2 && (target - near) * toward > 0) return true
      return travel >= 0.3 * Math.abs(target - far) && (Math.abs(target - near) < ANALYSIS.noteStepSemitones || ((target - near) * toward > 0 && arrives))
    }
    let slide = -1
    let into = -1
    for (let i = 0; i < segs.length && slide < 0; i++) {
      const s = stats[i]!
      if (s.seconds > ANALYSIS.slideMaxSeconds || !(intoPrev(i) || intoNext(i))) continue
      if (s.slideShare >= 0.5) {
        const dPrev = intoPrev(i) ? Math.abs(stats[i - 1]!.level - s.head) : Infinity
        const dNext = intoNext(i) ? Math.abs(stats[i + 1]!.level - s.tail) : Infinity
        ;[slide, into] = [i, dNext <= dPrev ? i + 1 : i - 1]
      } else if (intoNext(i) && (approaches(i, i + 1) || scoops(i, i + 1))) [slide, into] = [i, i + 1]
      else if (intoPrev(i) && (approaches(i, i - 1) || scoops(i, i - 1))) [slide, into] = [i, i - 1]
    }
    if (slide >= 0) {
      join(slide, into)
      continue
    }
    const same = segs.findIndex((s, i) => i > 0 && !s.onset && Math.abs(stats[i]!.level - stats[i - 1]!.level) < ANALYSIS.noteStepSemitones)
    if (same < 0) return segs
    join(same, same - 1)
  }
}

/** Full-rate measurements for telling a note's attack from reverb (dropReverbTails). */
interface Probe {
  /** Quietest level (dB) of 5 ms windows, 2.5 ms apart, between frames a and b; +∞ when shorter. */
  quietest(a: number, b: number): number
  /** Energies at h·freq (h = 1…count, up to 0.45 × the sample rate) in a 30 ms Hann window around frame i. */
  harmonics(i: number, freq: number, count: number): Float64Array
}

function segmentNotes(
  midi: Float64Array,
  moving: Uint8Array,
  onsets: Uint8Array,
  levels: Float64Array,
  hop: number,
  partials: PitchTrack['partials'],
  probe: Probe
): Segment[] {
  const penalty = ANALYSIS.segmentPenalty * (0.01 / hop)
  const maxLength = Math.round(10 / hop)
  const notes: Segment[] = []
  for (const [first, last] of voicedRegions(midi, Math.round(ANALYSIS.bridgeSeconds / hop))) {
    const segments: Segment[] = []
    let from = first
    for (let f = first + 1; f <= last + 1; f++) {
      if (f <= last && !onsets[f]) continue
      const frames: number[] = []
      for (let k = from; k < f; k++) if (!Number.isNaN(midi[k]!)) frames.push(k)
      if (frames.length) {
        const starts = partition(frames.map((k) => midi[k]!), penalty, maxLength)
        starts.forEach((s, i) => segments.push({ first: frames[s]!, last: frames[(starts[i + 1] ?? frames.length) - 1]!, onset: i === 0 }))
      }
      from = f
    }
    notes.push(...mergeSegments(segments, midi, moving, levels, hop, partials))
  }
  return dropReverbTails(notes, midi, levels, onsets, hop, probe)
}

/**
 * Reverb heard through rests, told from notes by their attacks (ANALYSIS.gapSilentDb…). A note
 * starts with an attack of its own: the gap before it falls silent, or, in a room where reverb
 * fills the gap, its partials rise together, as a new bow stroke excites them all at once; a tail
 * recovering from a momentary null after a release brings back only the partials that had
 * cancelled, and runs straight into the next note without a release of its own. A long segment
 * that holds its level after an onset, where a tail decays, is a note too. After the note before
 * has been released, a segment without an attack is dropped as reverb if it is quieter than a note
 * of its pitch heard within `reverbMemorySeconds` (within a semitone if short, or a harmonic of
 * one: the tracker hopping between tails, whose mixture also bends the pitch), or if it is short
 * and `tailDb` below the note before (the tails' mixture, whatever its pitch). A segment touching
 * the note before at its pitch is that note cut by a loudness swing (vibrato in a wet room, a
 * crescendo after an accent) and joins it again, unless a release or bow change came between them
 * (or, with no attack, it is much quieter). A soft repeat the tail hid (no onset) is split off
 * where the level rises out of the decaying tail after a release and holds (swell). Finally each
 * note's last frames `tailDb` or more below its loud level (90th percentile) are cut.
 */
function dropReverbTails(
  input: readonly Segment[],
  midi: Float64Array,
  levels: Float64Array,
  onsets: Uint8Array,
  hop: number,
  { quietest, harmonics }: Probe
): Segment[] {
  const measure = (seg: Segment) => {
    const pitch: number[] = []
    const level: number[] = []
    for (let f = seg.first; f <= seg.last; f++) {
      if (Number.isNaN(midi[f]!)) continue
      pitch.push(midi[f]!)
      level.push(levels[f]!)
    }
    const sorted = [...level].sort((a, b) => a - b)
    return { pitch: median(pitch)!, peak: sorted[sorted.length - 1]!, loud: sorted[Math.floor(0.9 * (sorted.length - 1))]! }
  }
  const span = Math.max(1, Math.round(ANALYSIS.attackRiseSeconds / hop))
  const reach = Math.max(1, Math.round(ANALYSIS.onsetTransientSeconds / hop))
  const hold = Math.max(3, Math.round(ANALYSIS.reverbShortSeconds / hop))
  const bridge = Math.round(ANALYSIS.bridgeSeconds / hop)
  /** Power-averaged level (dB) of the frames from…to − 1; null if none. */
  const meanDb = (from: number, to: number) => {
    let [sum, count] = [0, 0]
    for (let f = Math.max(0, from); f < Math.min(levels.length, to); f++) {
      sum += 10 ** (levels[f]! / 10)
      count++
    }
    return count ? powerDb(sum / count) : null
  }
  /**
   * After the rise at frame t (its first two frames), no frame of `reverbShortSeconds` falls
   * `swellHoldDb` below the level over the first `attackRiseSeconds` of them: a note holds where a
   * tail decays (4.5 dB in that time even at T60 = 2 s).
   */
  const holds = (t: number) => {
    const from = t + 2
    if (from + hold > levels.length) return false
    const at = meanDb(from, from + span)!
    for (let f = from; f < from + hold; f++) if (levels[f]! < at - ANALYSIS.swellHoldDb) return false
    return true
  }
  /** Least-squares slope of the level over frames from…to (dB per second). */
  const slope = (from: number, to: number) => {
    const mid = (from + to) / 2
    let [num, den] = [0, 0]
    for (let f = from; f <= to; f++) {
      num += (f - mid) * levels[f]!
      den += (f - mid) ** 2
    }
    return den > 0 ? num / den / hop : 0
  }
  /** The quietest frame in the `onsetTransientSeconds` before frame `on` (−1 at the start). */
  const dipBefore = (on: number) => {
    let dip = on - 1
    for (let f = on - 2; f >= Math.max(0, on - reach); f--) if (levels[f]! < levels[dip]!) dip = f
    return dip
  }
  /**
   * How much the segment starting at frame `on` (at `freq` Hz) begins with an attack of its own:
   * 1 out of a gap `gapSilentDb` below its first `attackRiseSeconds` (on a 5 ms envelope, so a
   * short silence between frames counts), else the share of its partials (those within
   * `attackPartialRangeDb` of the strongest) rising `attackPartialRiseDb` or more from the
   * quietest frame before the onset (and its neighbours) to the `attackRiseSeconds` after it
   * (within the segment, which ends at `last`).
   */
  const attackShare = (on: number, last: number, freq: number): number => {
    const dip = dipBefore(on)
    if (dip < 0) return 1
    if (meanDb(on, on + span)! - quietest(dip - 1, on + 1) >= ANALYSIS.gapSilentDb) return 1
    const energy = (frames: readonly number[]) => {
      const sum = new Float64Array(ANALYSIS.harmonics + 1)
      for (const f of frames) {
        const e = harmonics(f, freq, ANALYSIS.harmonics)
        for (let h = 1; h < e.length; h++) sum[h] = sum[h]! + e[h]! / frames.length
      }
      return sum
    }
    const dipped = energy([dip - 1, dip, dip + 1].filter((f) => f >= 0))
    // (The segment's last frame may already hold the next note's attack.)
    const after = energy(Array.from({ length: Math.max(1, Math.min(span, last - on - 1)) }, (_, k) => on + 1 + k))
    const top = Math.max(...after)
    let [significant, rising] = [0, 0]
    for (let h = 1; h < after.length; h++) {
      if (!(after[h]! > 0) || after[h]! < top * 10 ** (-ANALYSIS.attackPartialRangeDb / 10)) continue
      significant++
      if (after[h]! >= dipped[h]! * 10 ** (ANALYSIS.attackPartialRiseDb / 10)) rising++
    }
    return significant ? rising / significant : 0
  }
  /**
   * A soft repeat heard in a note's reverb tail without an onset of its own: after the note's loud
   * part ends in a release (the level `releaseDb` lower within `attackRiseSeconds`) and a tail
   * (from `attackRiseSeconds` after the release; one lasting `swellHeldSeconds` or more must decay
   * at `swellDecayDbPerSecond` or faster, as a note held softly after an accent does not), a
   * level `swellRiseDb` above the lowest frame of the `attackRiseSeconds` before it (itself
   * `tailDb` below the note) that then holds. Returns its first frame, or −1.
   */
  const swell = (seg: Segment, loud: number): number => {
    let end = seg.last
    while (end > seg.first && levels[end]! < loud - ANALYSIS.tailDb / 2) end--
    let bottom = Infinity
    for (let f = end + 1; f <= Math.min(seg.last, end + span); f++) bottom = Math.min(bottom, levels[f]!)
    if (!(bottom <= levels[end]! - ANALYSIS.releaseDb)) return -1
    for (let t = end + 2; t + 2 + hold <= seg.last + 1; t++) {
      let floor = Infinity
      for (let f = Math.max(end + 1, t - span); f < t; f++) floor = Math.min(floor, levels[f]!)
      if (floor > loud - ANALYSIS.tailDb) continue
      if (meanDb(t, t + span)! - floor < ANALYSIS.swellRiseDb || !holds(t)) continue
      const tail = end + span + 1
      return (t - tail) * hop >= ANALYSIS.swellHeldSeconds && slope(tail, t - 1) > -ANALYSIS.swellDecayDbPerSecond ? -1 : t
    }
    return -1
  }
  // Soft repeats hidden in tails become notes of their own, starting with an attack.
  const notes: Segment[] = []
  const swells = new Set<number>()
  for (const note of input) {
    let seg = { ...note }
    for (let t = swell(seg, measure(seg).loud); t > seg.first; t = swell(seg, measure(seg).loud)) {
      notes.push({ ...seg, last: t - 1 })
      swells.add(t)
      seg = { first: t, last: seg.last, onset: true }
    }
    notes.push(seg)
  }
  const kept: Segment[] = []
  const heardAs: { last: number; pitch: number; loud: number }[] = []
  // Last frame at which the previous note, or reverb dropped after it, was still heard.
  let heard = -Infinity
  for (const note of notes) {
    const seg = { ...note }
    const { pitch, peak, loud } = measure(seg)
    const prev = heardAs[heardAs.length - 1]
    if (prev && (seg.first - heard) * hop <= ANALYSIS.tailGapSeconds) {
      const before = kept[kept.length - 1]!
      // After the note before has been released: its level `releaseDb` below its loud part, and not
      // then held (a soft stretch after an accent that lasts `swellHeldSeconds` without decaying).
      let end = prev.last
      while (end > before.first && levels[end]! < prev.loud - ANALYSIS.tailDb / 2) end--
      let drop = end
      while (drop <= Math.min(levels.length - 1, seg.first + 1) && levels[drop]! > prev.loud - ANALYSIS.releaseDb) drop++
      const held = (seg.first - 1 - (drop + span)) * hop >= ANALYSIS.swellHeldSeconds && slope(drop + span, seg.first - 1) > -ANALYSIS.swellDecayDbPerSecond
      const released = drop <= seg.first + 1 && !held
      // Only a segment after a release, or one at the pitch of the note before and touching it, can be reverb or part of that note.
      const touching = Math.abs(pitch - prev.pitch) < ANALYSIS.noteStepSemitones && seg.first - before.last <= bridge + 1
      const short = (seg.last - seg.first + 1) * hop <= ANALYSIS.reverbShortSeconds
      let [share, attack, bowChange] = [1, true, true]
      if (released || touching) {
        let on = -1
        for (let f = Math.max(0, seg.first - 3); f <= Math.min(onsets.length - 1, seg.first + 3); f++) if (onsets[f] && (on < 0 || Math.abs(f - seg.first) < Math.abs(on - seg.first))) on = f
        const onset = on >= 0
        if (!onset) on = seg.first
        // A tail recovering between two notes runs straight into the next one; a note ends in a release.
        let ending = Infinity
        for (let f = Math.max(seg.first, seg.last - 2); f <= Math.min(levels.length - 1, seg.last + 3); f++) ending = Math.min(ending, levels[f]!)
        share = attackShare(on, seg.last, midiToFreq(pitch))
        // A bow change dips below the note's level just before (a loudness swing only wavers around it).
        const dip = dipBefore(on)
        bowChange = dip >= 0 && median(Array.from(levels.subarray(Math.max(0, dip - reach), Math.max(1, dip))))! - levels[dip]! >= ANALYSIS.bowChangeDipDb
        attack =
          swells.has(seg.first) ||
          share >= ANALYSIS.attackPartialShareAlone ||
          (share >= ANALYSIS.attackPartialShare && ending <= loud - ANALYSIS.releaseDb) ||
          (onset && !short && holds(on))
      }
      // The note before, cut by a loudness swing (never released, and not all partials rising out of
      // a bow change, or without an attack and about as loud): one note again.
      const unreleased = !released && (share < ANALYSIS.attackPartialShareAlone || !bowChange) && !swells.has(seg.first)
      if (touching && (unreleased || (!attack && loud >= prev.loud - ANALYSIS.splitDb))) {
        before.last = heard = prev.last = seg.last
        prev.loud = Math.max(prev.loud, loud)
        continue
      }
      if (!attack && released) {
        // The reverb of a recent note (or, short, a harmonic of it: the tracker hopping between tails
        // bends the pitch; also the mixture of the tails at any pitch).
        const near = short ? 1 : ANALYSIS.noteStepSemitones
        let copy = short && peak <= prev.loud - ANALYSIS.tailDb
        for (let k = heardAs.length - 1; k >= 0 && !copy && (seg.first - heardAs[k]!.last) * hop <= ANALYSIS.reverbMemorySeconds; k--) {
          const { pitch: p, loud: l } = heardAs[k]!
          copy = peak <= l - ANALYSIS.copyBelowDb && (Math.abs(pitch - p) < near || (short && ONSET_HARMONICS.some((h) => Math.abs(Math.abs(pitch - p) - h) < 1)))
        }
        if (copy) {
          heard = seg.last
          continue
        }
      }
    }
    heard = seg.last
    heardAs.push({ last: seg.last, pitch, loud })
    kept.push(seg)
  }
  // The tails are cut at each (possibly re-joined) note's own loud level.
  for (const seg of kept) {
    const { loud } = measure(seg)
    while (seg.last > seg.first && (Number.isNaN(midi[seg.last]!) || levels[seg.last]! < loud - ANALYSIS.tailDb)) seg.last--
  }
  return kept
}

// ---------------------------------------------------------------------------------------------
// Per-note features
// ---------------------------------------------------------------------------------------------

/** Least-squares polynomial trend removed (time mapped to −1…1 for conditioning). */
function detrend(x: Float64Array, degree: number): Float64Array {
  const n = x.length
  const d = Math.min(degree, n - 1) + 1
  const m = Array.from({ length: d }, () => new Float64Array(d + 1))
  const powers = new Float64Array(d)
  const u = (j: number) => (n > 1 ? (2 * j) / (n - 1) - 1 : 0)
  for (let j = 0; j < n; j++) {
    powers[0] = 1
    for (let k = 1; k < d; k++) powers[k] = powers[k - 1]! * u(j)
    for (let r = 0; r < d; r++) {
      for (let c = 0; c < d; c++) m[r]![c] = m[r]![c]! + powers[r]! * powers[c]!
      m[r]![d] = m[r]![d]! + powers[r]! * x[j]!
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < d; col++) {
    let pivot = col
    for (let r = col + 1; r < d; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r
    ;[m[col], m[pivot]] = [m[pivot]!, m[col]!]
    const p = m[col]![col]!
    if (Math.abs(p) < 1e-12) continue
    for (let r = 0; r < d; r++) {
      if (r === col) continue
      const f = m[r]![col]! / p
      for (let c = col; c <= d; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!
    }
  }
  const coef = m.map((row, k) => (Math.abs(row[k]!) < 1e-12 ? 0 : row[d]! / row[k]!))
  return x.map((v, j) => {
    let trend = 0
    for (let k = d - 1; k >= 0; k--) trend = trend * u(j) + coef[k]!
    return v - trend
  })
}

/** Centred moving average (window shrinks symmetrically at the edges). */
function smooth(x: Float64Array, length: number): Float64Array {
  const half = Math.floor(length / 2)
  const prefix = new Float64Array(x.length + 1)
  for (let j = 0; j < x.length; j++) prefix[j + 1] = prefix[j]! + x[j]!
  return x.map((_, j) => {
    const w = Math.min(half, j, x.length - 1 - j)
    return (prefix[j + w + 1]! - prefix[j - w]!) / (2 * w + 1)
  })
}

/** Pearson correlation; null when either side is constant. */
function correlation(x: ArrayLike<number>, y: ArrayLike<number>): number | null {
  const n = Math.min(x.length, y.length)
  let mx = 0
  let my = 0
  for (let j = 0; j < n; j++) {
    mx += x[j]!
    my += y[j]!
  }
  mx /= n
  my /= n
  let xy = 0
  let xx = 0
  let yy = 0
  for (let j = 0; j < n; j++) {
    xy += (x[j]! - mx) * (y[j]! - my)
    xx += (x[j]! - mx) ** 2
    yy += (y[j]! - my) ** 2
  }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null
}

/** Vibrato period by normalised autocorrelation in the 3–9 Hz lag range; null if not periodic. */
function vibratoRate(y: Float64Array, hop: number): number | null {
  const fps = 1 / hop
  const minLag = Math.max(2, Math.floor(fps / ANALYSIS.vibratoMaxHz))
  const maxLag = Math.min(Math.ceil(fps / ANALYSIS.vibratoMinHz), Math.floor(y.length * 0.6))
  if (maxLag < minLag + 1) return null
  const r = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let xy = 0
    let xx = 0
    let yy = 0
    for (let j = 0; j + lag < y.length; j++) {
      xy += y[j]! * y[j + lag]!
      xx += y[j]! * y[j]!
      yy += y[j + lag]! * y[j + lag]!
    }
    r[lag] = xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0
  }
  const peaks: number[] = []
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag]! > r[lag - 1]! && r[lag]! >= r[lag + 1]!) peaks.push(lag)
  if (!peaks.length) return null
  const top = Math.max(...peaks.map((p) => r[p]!))
  if (top < ANALYSIS.vibratoMinCorrelation) return null
  // The shortest strong period, not a multiple of it.
  const lag = peaks.find((p) => r[p]! >= 0.8 * top)!
  const denom = r[lag - 1]! - 2 * r[lag]! + r[lag + 1]!
  const refined = denom < 0 ? lag + (r[lag - 1]! - r[lag + 1]!) / (2 * denom) : lag
  const rate = fps / refined
  return rate >= ANALYSIS.vibratoMinHz && rate <= ANALYSIS.vibratoMaxHz ? rate : null
}

interface Vibrato {
  rate: number | null
  extent: number
  onsetMs: number | null
  am: number | null
}

/**
 * Vibrato of one note's steady part: the cents contour minus its slow trend. A note with vibrato
 * (a rate and ≥ `vibratoMinExtentCents`) also gets its onset, the centre of the first one-cycle
 * window at half the note's full width (80th percentile of those windows), timed from the note's
 * start, and the correlation of its detrended pitch and level: AM in or against the FM's phase.
 */
function noteVibrato(midi: Float64Array, moving: Uint8Array, levels: Float64Array, seg: Segment, level: number, hop: number): Vibrato | null {
  // Frames far off the note (tracking slips) would read as a huge vibrato.
  const usable = (f: number) => !Number.isNaN(midi[f]!) && !moving[f] && Math.abs(midi[f]! - level) < 3
  let a = seg.first
  let b = seg.last
  while (a <= b && !usable(a)) a++
  while (b >= a && !usable(b)) b--
  const margin = Math.round(0.03 / hop)
  a += margin
  b -= margin
  const count = b - a + 1
  if (count * hop < 0.6 * ANALYSIS.vibratoMinNoteSeconds) return null
  // Cents contour; holes (unvoiced or sliding frames) are bridged linearly.
  const x = new Float64Array(count)
  let prev = -1
  for (let j = 0; j < count; j++) {
    if (!usable(a + j)) continue
    x[j] = (midi[a + j]! - level) * 100
    for (let k = prev + 1; k < j; k++) x[k] = prev < 0 ? x[j]! : x[prev]! + ((x[j]! - x[prev]!) * (k - prev)) / (j - prev)
    prev = j
  }
  if (prev < 0) return null
  for (let k = prev + 1; k < count; k++) x[k] = x[prev]!
  const seconds = count * hop
  const degree = seconds < 0.6 ? 1 : seconds < 2 ? 2 : 3
  const y = detrend(x, degree)
  const rate = vibratoRate(y, hop)
  let residual = y
  if (rate !== null && seconds >= 2) {
    // Long notes bend: follow the trend with a triangular smoother one vibrato period wide (it
    // cancels the vibrato itself) and measure the part where the window fits.
    const period = Math.max(3, Math.round(1 / (rate * hop)))
    const trend = smooth(smooth(x, period), period)
    if (count > 4 * period) residual = x.map((v, j) => v - trend[j]!).subarray(period, count - period)
  }
  let sum = 0
  for (const v of residual) sum += v * v
  const extent = Math.SQRT2 * Math.sqrt(sum / residual.length)
  if (rate === null || extent < ANALYSIS.vibratoMinExtentCents) return { rate, extent, onsetMs: null, am: null }
  const period = Math.max(3, Math.round(1 / (rate * hop)))
  let onsetMs: number | null = null
  if (count >= 2 * period) {
    const width: number[] = []
    let power = 0
    for (let j = 0; j < count; j++) {
      power += y[j]! * y[j]!
      if (j >= period) power -= y[j - period]! * y[j - period]!
      if (j >= period - 1) width.push(Math.SQRT2 * Math.sqrt(Math.max(0, power) / period))
    }
    const full = percentile(width, 0.8)!
    const k = width.findIndex((w) => w >= 0.5 * full)
    onsetMs = (a + k + (period - 1) / 2 - seg.first + 0.5) * hop * 1000
  }
  const am = correlation(y, detrend(Float64Array.from({ length: count }, (_, j) => levels[a + j]!), degree))
  return { rate, extent, onsetMs, am }
}

interface Spectral {
  harmonicsDb: number[]
  centroidHz: number | null
  hnrDb: number | null
}

/** Edges of the long-term spectrum's bands (LTAS_BANDS_HZ are their centres). */
const LTAS_EDGES = Array.from({ length: LTAS_BANDS_HZ.length + 1 }, (_, k) => 100 * 2 ** (k / 6))

/** Band power summed over analysed frames (each normalised to mean-square per sample). */
interface LtasSum {
  power: Float64Array
  frames: number
}

/** Adds one frame's power spectrum (bins of `binHz`, up to `last`) to the band sums, splitting bins at band edges. */
function addBands(sum: Float64Array, edges: readonly number[], power: Float64Array, binHz: number, last: number, scale: number): void {
  for (let band = 0; band + 1 < edges.length; band++) {
    const lo = edges[band]!
    const hi = edges[band + 1]!
    if (hi > (last + 0.5) * binHz) break
    let total = 0
    for (let k = Math.max(0, Math.floor(lo / binHz - 0.5)); k <= Math.min(last, Math.ceil(hi / binHz + 0.5)); k++) {
      const overlap = Math.min(hi, (k + 0.5) * binHz) - Math.max(lo, (k - 0.5) * binHz)
      if (overlap > 0) total += (power[k]! * overlap) / binHz
    }
    sum[band] = sum[band]! + total * scale
  }
}

/**
 * Harmonic levels and centroid from Hann-windowed FFT frames (≥ 10 periods, zero-padded ×2) over
 * the note's middle 60 %, HNR from the same frames under a Blackman–Harris window. Each frame
 * uses the local pitch from the track and widens the harmonic bands by the pitch spread inside
 * the frame, so vibrato does not read as noise. `ltas` (sustained notes only) collects the
 * frames' band powers for the long-term spectrum.
 */
function noteSpectrum(
  samples: Float32Array,
  sampleRate: number,
  start: number,
  end: number,
  f0: number,
  localPitch: (from: number, to: number) => { f0: number; spread: number } | null,
  ltas: LtasSum | null
): Spectral {
  const empty: Spectral = { harmonicsDb: [], centroidHz: null, hnrDb: null }
  const minSize = nextPowerOfTwo(0.02 * sampleRate)
  let size = Math.min(nextPowerOfTwo((10 * sampleRate) / f0), nextPowerOfTwo(0.15 * sampleRate))
  while (size > minSize && size > (end - start) * sampleRate) size /= 2
  if (size > samples.length) return empty
  const a = (start + 0.2 * (end - start)) * sampleRate
  const room = (end - 0.2 * (end - start)) * sampleRate - a - size
  const count = room <= 0 ? 1 : Math.min(ANALYSIS.spectrumFrames, 1 + Math.floor(room / (size / 2)))
  const clampOffset = (o: number) => Math.max(0, Math.min(samples.length - size, Math.round(o)))
  const offsets =
    count === 1 ? [clampOffset(((start + end) / 2) * sampleRate - size / 2)] : Array.from({ length: count }, (_, k) => clampOffset(a + (k * room) / (count - 1)))

  const window = hannWindow(size)
  const lowLeak = blackmanHarrisWindow(size)
  let windowEnergy = 0
  for (const w of window) windowEnergy += w * w
  const fftSize = 2 * size
  const binHz = sampleRate / fftSize
  const nyquist = sampleRate / 2
  // Blackman–Harris main lobe: ±4 bins of the unpadded frame.
  const mainLobeHz = (4 * sampleRate) / size
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  const power = new Float64Array(size + 1)
  const harmonicPower = new Float64Array(ANALYSIS.harmonics)
  const measured = new Uint8Array(ANALYSIS.harmonics)
  let centroidSum = 0
  let centroidFrames = 0
  let harmonicEnergy = 0
  let noiseEnergy = 0
  const db = (k: number) => 10 * Math.log10(power[k]! + 1e-30)
  const spectrum = (offset: number, w: Float64Array) => {
    re.fill(0)
    im.fill(0)
    for (let j = 0; j < size; j++) re[j] = samples[offset + j]! * w[j]!
    fft(re, im)
    for (let k = 0; k <= size; k++) power[k] = re[k]! * re[k]! + im[k]! * im[k]!
  }

  for (const offset of offsets) {
    const local = localPitch(offset / sampleRate, (offset + size) / sampleRate) ?? { f0, spread: 0 }
    spectrum(offset, window)

    for (let h = 1; h <= ANALYSIS.harmonics; h++) {
      const centre = h * local.f0
      if (centre * (1 + ANALYSIS.harmonicSearch) >= nyquist) break
      const nearest = Math.round(centre / binHz)
      const lo = Math.max(1, Math.min(Math.floor((centre * (1 - ANALYSIS.harmonicSearch)) / binHz), nearest - 2))
      const hi = Math.min(size - 1, Math.max(Math.ceil((centre * (1 + ANALYSIS.harmonicSearch)) / binHz), nearest + 2))
      let peak = lo
      for (let k = lo; k <= hi; k++) if (power[k]! > power[peak]!) peak = k
      const [l, c, r] = [db(peak - 1), db(peak), db(peak + 1)]
      const denom = l - 2 * c + r
      const peakDb = denom < 0 ? c - ((l - r) * (l - r)) / (8 * denom) : c
      harmonicPower[h - 1] = harmonicPower[h - 1]! + 10 ** (peakDb / 10)
      measured[h - 1] = 1
    }

    let num = 0
    let den = 0
    for (let k = Math.max(1, Math.ceil((0.5 * local.f0) / binHz)); k <= Math.min(size, Math.floor(ANALYSIS.centroidMaxHz / binHz)); k++) {
      const mag = Math.sqrt(power[k]!)
      num += k * binHz * mag
      den += mag
    }
    if (den > 0) {
      centroidSum += num / den
      centroidFrames++
    }
    if (ltas) {
      addBands(ltas.power, LTAS_EDGES, power, binHz, size, 1 / (fftSize * windowEnergy))
      ltas.frames++
    }

    // HNR: noise density from the bins between the harmonic bands, spread over the whole band, on
    // a Blackman–Harris spectrum (Hann sidelobes would put a floor near 30 dB under clean tones).
    const top = Math.floor(Math.min(ANALYSIS.hnrMaxHz, nyquist) / local.f0 - 0.5)
    if (top >= 1) {
      spectrum(offset, lowLeak)
      let harm = 0
      let harmBins = 0
      let noise = 0
      let noiseBins = 0
      for (let k = Math.ceil((0.5 * local.f0) / binHz); k <= Math.min(size, Math.floor(((top + 0.5) * local.f0) / binHz)); k++) {
        const f = k * binHz
        const h = Math.max(1, Math.round(f / local.f0))
        const band = Math.min(0.4 * local.f0, mainLobeHz + (h * local.f0 * local.spread) / 2)
        if (Math.abs(f - h * local.f0) <= band) {
          harm += power[k]!
          harmBins++
        } else {
          noise += power[k]!
          noiseBins++
        }
      }
      if (noiseBins > 0) {
        const density = noise / noiseBins
        harmonicEnergy += Math.max(0, harm - density * harmBins)
        noiseEnergy += density * (harmBins + noiseBins)
      }
    }
  }

  const levels = Array.from(harmonicPower, (p, k) => (measured[k] ? powerDb(p / offsets.length) : null))
  const strongest = Math.max(...nonNull(levels))
  const ceiling = ANALYSIS.hnrCeilingDb
  return {
    harmonicsDb: Number.isFinite(strongest) ? levels.map((v) => (v === null ? ANALYSIS.harmonicFloorDb : Math.max(ANALYSIS.harmonicFloorDb, v - strongest))) : [],
    centroidHz: centroidFrames ? centroidSum / centroidFrames : null,
    hnrDb: noiseEnergy > 0 ? Math.max(-20, Math.min(ceiling, 10 * Math.log10(Math.max(harmonicEnergy, 1e-30) / noiseEnergy))) : harmonicEnergy > 0 ? ceiling : null
  }
}

/**
 * 10 % → 90 % rise time of the RMS envelope (1 ms steps, window ≥ 2 periods) from the quietest
 * point just before the note to its level over the first half second (90th percentile).
 */
function noteAttack(samples: Float32Array, sampleRate: number, start: number, end: number, f0: number): number | null {
  const window = Math.max(Math.round(0.005 * sampleRate), Math.round((2 * sampleRate) / f0))
  const step = Math.max(1, Math.round(0.001 * sampleRate))
  const from = Math.max(0, Math.round((start - 0.1) * sampleRate))
  const to = Math.min(samples.length, Math.round(Math.min(end, start + 0.5) * sampleRate))
  if (to - from < 2 * window) return null
  const lo = Math.max(0, from - window)
  const hi = Math.min(samples.length, to + window)
  const prefix = new Float64Array(hi - lo + 1)
  for (let j = lo; j < hi; j++) prefix[j - lo + 1] = prefix[j - lo]! + samples[j]! * samples[j]!
  const env: number[] = []
  for (let p = from; p < to; p += step) {
    const a = Math.max(lo, p - (window >> 1))
    const b = Math.min(hi, a + window)
    env.push(Math.sqrt((prefix[b - lo]! - prefix[a - lo]!) / Math.max(1, b - a)))
  }
  const searchEnd = Math.min(env.length, Math.ceil(((start + 0.05) * sampleRate - from) / step) + 1)
  let quiet = 0
  for (let j = 1; j < searchEnd; j++) if (env[j]! < env[quiet]!) quiet = j
  const sorted = env.slice(quiet).sort((x, y) => x - y)
  const reference = sorted[Math.floor(0.9 * (sorted.length - 1))]!
  const base = env[quiet]!
  if (reference <= base * 10 ** (ANALYSIS.attackMinRiseDb / 20)) return null
  const crossing = (fraction: number, after: number) => {
    const level = base + fraction * (reference - base)
    for (let j = after + 1; j < env.length; j++) if (env[j]! >= level) return j - 1 + (level - env[j - 1]!) / (env[j]! - env[j - 1]!)
    return null
  }
  const t10 = crossing(0.1, quiet)
  const t90 = t10 === null ? null : crossing(0.9, Math.floor(t10))
  return t10 === null || t90 === null ? null : ((t90 - t10) * step * 1000) / sampleRate
}

// ---------------------------------------------------------------------------------------------
// Tempo, rhythm, key and trills
// ---------------------------------------------------------------------------------------------

/** Onsets on a `step` grid from the first one, each spread as a Gaussian (σ = 20 ms) so nearby lags add up. */
function onsetEnvelope(onsets: readonly number[], step: number): Float64Array {
  const t0 = onsets[0]!
  const out = new Float64Array(Math.round((onsets[onsets.length - 1]! - t0) / step) + 1)
  const sigma = 0.02 / step
  const reach = Math.ceil(3 * sigma)
  for (const t of onsets) {
    const c = (t - t0) / step
    for (let j = Math.max(0, Math.floor(c) - reach); j <= Math.min(out.length - 1, Math.ceil(c) + reach); j++) out[j] = out[j]! + Math.exp(-0.5 * ((j - c) / sigma) ** 2)
  }
  return out
}

/** Σ x[j]·x[j + lag] for j in [from, to − lag). */
function lagProduct(x: Float64Array, lag: number, from = 0, to = x.length): number {
  let sum = 0
  for (let j = from; j + lag < to; j++) sum += x[j]! * x[j + lag]!
  return sum
}

/** Peak position of f near integer i, by a parabola through i − 1, i, i + 1. */
function refinePeak(f: (i: number) => number, i: number): number {
  const [l, c, r] = [f(i - 1), f(i), f(i + 1)]
  const denom = l - 2 * c + r
  return denom < 0 ? i + (l - r) / (2 * denom) : i
}

/**
 * Tempo from the note onsets: the autocorrelation peak of the onset envelope, with half the weight
 * of the double period added (a beat also repeats every two beats) and a log-Gaussian prior one
 * octave wide around `tempoPriorBpm`, which settles the metrical level. The variance is that of
 * the same estimate in half-overlapping 8-beat windows (two 4/4 bars), searched within ±25 % of
 * the whole piece's beat.
 */
function estimateTempo(onsets: readonly number[]): { bpm: number | null; variance: number | null } {
  const none = { bpm: null, variance: null }
  if (onsets.length < ANALYSIS.tempoMinOnsets) return none
  const step = 0.01
  const env = onsetEnvelope(onsets, step)
  const minLag = Math.max(2, Math.floor(60 / ANALYSIS.tempoMaxBpm / step))
  const maxLag = Math.ceil(60 / ANALYSIS.tempoMinBpm / step)
  const r = new Float64Array(2 * maxLag + 2)
  for (let lag = 0; lag < r.length; lag++) r[lag] = lagProduct(env, lag)
  if (r[0]! <= 0) return none
  const score = (lag: number) => (r[lag]! + 0.5 * r[2 * lag]!) * Math.exp(-0.5 * Math.log2((lag * step * ANALYSIS.tempoPriorBpm) / 60) ** 2)
  let best = -1
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (r[lag]! < r[lag - 1]! || r[lag]! < r[lag + 1]!) continue
    if (best < 0 || score(lag) > score(best)) best = lag
  }
  if (best < 0 || r[best]! < 0.1 * r[0]!) return none
  const period = refinePeak((i) => r[i]!, best)
  const bpm = 60 / (period * step)
  const window = Math.round(8 * period)
  const lo = Math.max(2, Math.floor(0.8 * period))
  const hi = Math.ceil(1.25 * period)
  const local: number[] = []
  for (let from = 0; from + window <= env.length; from += Math.round(window / 2)) {
    const to = from + window
    const energy = lagProduct(env, 0, from, to)
    const c = new Float64Array(hi + 2)
    for (let lag = lo - 1; lag <= hi + 1; lag++) c[lag] = lagProduct(env, lag, from, to) + 0.5 * lagProduct(env, 2 * lag, from, to)
    let arg = lo
    for (let lag = lo; lag <= hi; lag++) if (c[lag]! > c[arg]!) arg = lag
    if (energy <= 0 || arg === lo || arg === hi || c[arg]! < 0.2 * energy) continue
    local.push(60 / (refinePeak((i) => c[i]!, arg) * step))
  }
  if (local.length < 3) return { bpm, variance: null }
  const mean = local.reduce((s, v) => s + v, 0) / local.length
  return { bpm, variance: Math.sqrt(local.reduce((s, v) => s + (v - mean) ** 2, 0) / local.length) / mean }
}

/**
 * Peaks of the histogram of successive inter-onset-interval ratios, folded to ≥ 1 (short→long
 * and long→short count alike; Gaussian kernels 0.05 octave wide), each holding ≥ `ioiPeakShare`
 * of the pairs, strongest first. `main` is the strongest uneven one (≥ `ioiUnevenRatio`), else 1.
 */
function ioiRatios(onsets: readonly number[]): { peaks: number[]; main: number | null } {
  const folded: number[] = []
  for (let i = 2; i < onsets.length; i++) {
    const first = onsets[i - 1]! - onsets[i - 2]!
    const second = onsets[i]! - onsets[i - 1]!
    if (Math.min(first, second) >= ANALYSIS.minNoteSeconds && Math.max(first, second) <= ANALYSIS.ioiMaxSeconds) folded.push(Math.abs(Math.log2(second / first)))
  }
  if (folded.length < ANALYSIS.tempoMinOnsets - 2) return { peaks: [], main: null }
  const width = 0.05
  const bins = Math.round(2 / width)
  const density = new Float64Array(bins + 1)
  for (let b = 0; b <= bins; b++) for (const u of folded) density[b] = density[b]! + Math.exp(-0.5 * ((u - b * width) / width) ** 2)
  const peaks: { ratio: number; share: number }[] = []
  for (let b = 0; b <= bins; b++) {
    if ((b > 0 && density[b]! < density[b - 1]!) || (b < bins && density[b]! <= density[b + 1]!)) continue
    const u = (b === 0 || b === bins ? b : refinePeak((i) => density[i]!, b)) * width
    const share = folded.filter((v) => Math.abs(v - u) <= 2 * width).length / folded.length
    if (share >= ANALYSIS.ioiPeakShare) peaks.push({ ratio: 2 ** u, share })
  }
  peaks.sort((x, y) => y.share - x.share)
  return { peaks: peaks.map((p) => p.ratio), main: peaks.find((p) => p.ratio >= ANALYSIS.ioiUnevenRatio)?.ratio ?? 1 }
}

/** Tuning offset from equal temperament (duration-weighted circular mean) and the duration-weighted pitch classes after removing it. */
function pitchClassProfile(notes: readonly NoteFeatures[]): { tuningCents: number | null; classes: number[] } {
  const pitched = notes.filter((n) => n.f0 !== null && n.f0 > 0)
  if (!pitched.length) return { tuningCents: null, classes: [] }
  let cos = 0
  let sin = 0
  for (const n of pitched) {
    const m = freqToMidi(n.f0!)
    cos += (n.end - n.start) * Math.cos(2 * Math.PI * m)
    sin += (n.end - n.start) * Math.sin(2 * Math.PI * m)
  }
  const offset = Math.atan2(sin, cos) / (2 * Math.PI)
  const classes = new Array<number>(12).fill(0)
  let total = 0
  for (const n of pitched) {
    const pc = ((Math.round(freqToMidi(n.f0!) - offset) % 12) + 12) % 12
    classes[pc] = classes[pc]! + (n.end - n.start)
    total += n.end - n.start
  }
  return { tuningCents: offset * 100, classes: classes.map((v) => (total > 0 ? v / total : 0)) }
}

/**
 * Trills: at least `trillMinSwings` pitch swings in a row of ≥ `trillMinCents` peak to peak, each
 * half-cycle lasting 1/(2·trillMaxHz) … 1/(2·trillMinHz). Turning points are found with hysteresis
 * (half the minimum swing) and half-cycles timed between the swings' half-way crossings, so trills
 * between two held notes are timed like smooth ones. Rate in cycles per second, from a straight
 * line through the inner swings' crossings of the level half-way between the trill's two notes
 * (the first and last swings are cut by the notes around the trill), null for a trill of fewer
 * than `trillTimedSwings` swings; extent in cents (median swing, peak to peak).
 */
function findTrills(midi: Float64Array, inNote: Uint8Array, hop: number): { rate: number | null; extent: number }[] {
  const swingMin = ANALYSIS.trillMinCents / 100
  const turn = swingMin / 2
  const bridge = Math.round(ANALYSIS.bridgeSeconds / hop)
  const minHalf = 1 / (2 * ANALYSIS.trillMaxHz)
  const maxHalf = 1 / (2 * ANALYSIS.trillMinHz)
  const on = (f: number) => inNote[f] === 1 && !Number.isNaN(midi[f]!)
  const trills: { rate: number | null; extent: number }[] = []
  const evaluate = (extremes: readonly number[]) => {
    const swings = extremes.slice(1).map((to, k) => Math.abs(midi[to]! - midi[extremes[k]!]!))
    /** Where the contour crosses `mid` going from turning point `from` to `to` (frames across a fast step are often unvoiced: interpolated between the voiced ones); null if it does not. */
    const crossingOf = (from: number, to: number, mid: number) => {
      const up = midi[to]! > midi[from]!
      for (let f = from, g = from + 1; g <= to; g++) {
        if (!on(g)) continue
        const [x, y] = [midi[f]!, midi[g]!]
        if (up ? x < mid && y >= mid : x > mid && y <= mid) return f + ((mid - x) / (y - x)) * (g - f)
        f = g
      }
      return null
    }
    // Where each swing crosses its half-way level: held notes at the turning points do not move it.
    const crossing = extremes.slice(1).map((to, k) => crossingOf(extremes[k]!, to, (midi[extremes[k]!]! + midi[to]!) / 2) ?? (extremes[k]! + to) / 2)
    let from = 0
    const close = (end: number) => {
      const count = end - from + 1
      if (count < ANALYSIS.trillMinSwings) return
      // The first and last half-cycles are cut short by the notes around the trill: the rate comes
      // from the inner ones, and only from a trill of `trillTimedSwings` swings or more. They are
      // timed where they cross the level half-way between the trill's two notes (the medians of its
      // upper and lower turning points, so a glitch at one of them moves nothing), by a straight
      // line through those crossings.
      const [a, b] = [from + 1, end - 1]
      let rate: number | null = null
      if (count >= ANALYSIS.trillTimedSwings) {
        const turns = extremes.slice(from, end + 2).map((f) => midi[f]!)
        const [even, odd] = [turns.filter((_, k) => k % 2 === 0), turns.filter((_, k) => k % 2 === 1)]
        const level = (median(even)! + median(odd)!) / 2
        const times: number[] = []
        for (let k = a; k <= b; k++) times.push(crossingOf(extremes[k]!, extremes[k + 1]!, level) ?? crossing[k]!)
        const fit = leastSquares(
          times.map((_, k) => [1, k]),
          times
        )
        const half = fit ? fit[1]! : (times[times.length - 1]! - times[0]!) / (times.length - 1)
        rate = half > 0 ? 1 / (2 * half * hop) : null
      }
      trills.push({ rate, extent: 100 * median(swings.slice(from, end + 1))! })
    }
    for (let k = 0; k < swings.length; k++) {
      if (swings[k]! < swingMin) {
        close(k - 1)
        from = k + 1
      } else if (k > from) {
        const half = (crossing[k]! - crossing[k - 1]!) * hop
        if (half < minHalf || half > maxHalf) {
          close(k - 1)
          from = k
        }
      }
    }
    close(swings.length - 1)
  }
  let extremes: number[] = []
  let dir = 0
  let ext = -1
  let low = -1
  let high = -1
  let last = -Infinity
  for (let f = 0; f <= midi.length; f++) {
    if (f < midi.length && !on(f)) continue
    if (f === midi.length || f - last - 1 > bridge) {
      if (dir !== 0) extremes.push(ext)
      evaluate(extremes)
      extremes = []
      dir = 0
      ext = low = high = last = f
      continue
    }
    last = f
    const v = midi[f]!
    if (dir === 0) {
      if (v < midi[low]!) low = f
      if (v > midi[high]!) high = f
      if (midi[high]! - midi[low]! >= turn) {
        extremes.push(Math.min(low, high))
        dir = low < high ? 1 : -1
        ext = Math.max(low, high)
      }
    } else if ((v - midi[ext]!) * dir > 0) ext = f
    else if ((midi[ext]! - v) * dir >= turn) {
      extremes.push(ext)
      dir = -dir
      ext = f
    }
  }
  return trills
}

// ---------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------

export function analyzeAudio(samples: Float32Array, sampleRate: number, opts: { minFreq?: number; maxFreq?: number; hopSeconds?: number } = {}): AudioFeatures {
  const hop = opts.hopSeconds ?? ANALYSIS.hopSeconds
  const minFreq = opts.minFreq ?? ANALYSIS.minFreq
  const maxFreq = opts.maxFreq ?? ANALYSIS.maxFreq
  const duration = samples.length / sampleRate
  const frameCount = Math.max(0, Math.ceil(duration / hop - 1e-9))

  const levels = frameLevels(samples, sampleRate, hop, frameCount)
  const { midi, partials } = trackPitch(samples, sampleRate, hop, levels, minFreq, maxFreq)
  fixOctaveErrors(midi)
  dropSpikes(midi)
  const onsets = dipOnsets(levels, hop)
  const { moving, glide, slides } = slideFrames(midi, onsets, hop)
  const probeWidth = Math.min(samples.length, Math.max(8, Math.round(0.03 * sampleRate)))
  const probeWindow = hannWindow(probeWidth)
  const probeFrame = new Float64Array(probeWidth)
  const probe: Probe = {
    quietest: (a, b) => {
      const width = Math.max(1, Math.round(0.005 * sampleRate))
      const to = Math.min(samples.length, Math.round(b * hop * sampleRate))
      let min = Infinity
      for (let p = Math.max(0, Math.round(a * hop * sampleRate)); p + width <= to; p += Math.max(1, width >> 1)) {
        let sum = 0
        for (let j = p; j < p + width; j++) sum += samples[j]! * samples[j]!
        min = Math.min(min, powerDb(sum / width))
      }
      return min
    },
    harmonics: (i, freq, count) => {
      const start = Math.max(0, Math.min(samples.length - probeWidth, Math.round(i * hop * sampleRate) - (probeWidth >> 1)))
      for (let j = 0; j < probeWidth; j++) probeFrame[j] = samples[start + j]! * probeWindow[j]!
      return partialEnergies(probeFrame, sampleRate, freq, Math.max(1, Math.min(count, Math.floor((0.45 * sampleRate) / freq))))
    }
  }
  const segments = segmentNotes(midi, moving, onsets, levels, hop, partials, probe)

  const inNote = new Uint8Array(frameCount)
  let voicedFrames = 0
  let glideFrames = 0
  const ltas: LtasSum = { power: new Float64Array(LTAS_BANDS_HZ.length), frames: 0 }
  const notes: NoteFeatures[] = segments.map((seg) => {
    const all: number[] = []
    const steady: number[] = []
    for (let f = seg.first; f <= seg.last; f++) {
      const m = midi[f]!
      if (Number.isNaN(m)) continue
      inNote[f] = 1
      voicedFrames++
      if (glide[f]) glideFrames++
      all.push(m)
      if (!moving[f]) steady.push(m)
    }
    const level = median(steady.length >= 3 ? steady : all)!
    const f0 = midiToFreq(level)
    const start = Math.max(0, (seg.first - 0.5) * hop)
    const end = Math.min(duration, (seg.last + 0.5) * hop)
    const vibrato = end - start >= ANALYSIS.vibratoMinNoteSeconds ? noteVibrato(midi, moving, levels, seg, level, hop) : null
    const localPitch = (from: number, to: number) => {
      const hz: number[] = []
      for (let f = Math.max(seg.first, Math.ceil(from / hop)); f <= Math.min(seg.last, Math.floor(to / hop)); f++) {
        if (Math.abs(midi[f]! - level) < 3) hz.push(midiToFreq(midi[f]!))
      }
      const centre = median(hz)
      return centre === null ? null : { f0: centre, spread: (Math.max(...hz) - Math.min(...hz)) / centre }
    }
    return {
      start,
      end,
      f0,
      vibratoRateHz: vibrato?.rate ?? null,
      vibratoExtentCents: vibrato?.extent ?? null,
      vibratoOnsetMs: vibrato?.onsetMs ?? null,
      amCorrelation: vibrato?.am ?? null,
      ...noteSpectrum(samples, sampleRate, start, end, f0, localPitch, end - start >= ANALYSIS.ltasMinNoteSeconds ? ltas : null),
      attackMs: noteAttack(samples, sampleRate, start, end, f0)
    }
  })

  // Each note's sustained level: the 90th percentile of its voiced frames (attacks, releases and
  // reverb-lengthened ends left out), for notes with at least `minNoteSeconds` of them.
  const noteLevels = nonNull(
    segments.map((seg) => {
      const values: number[] = []
      for (let f = seg.first; f <= seg.last; f++) if (!Number.isNaN(midi[f]!)) values.push(levels[f]!)
      return values.length * hop >= ANALYSIS.minNoteSeconds ? percentile(values, 0.9) : null
    })
  )
  const between = slides.filter((s) => s.between && inNote.subarray(s.first, s.last + 1).every((v) => v === 1))
  const trills = findTrills(midi, inNote, hop)
  let ltasDb: (number | null)[] = []
  if (ltas.frames) {
    const bands = Array.from(ltas.power, (p) => (p > 0 ? 10 * Math.log10(p / ltas.frames) : null))
    const valid = nonNull(bands)
    const mean = valid.reduce((s, v) => s + v, 0) / Math.max(1, valid.length)
    ltasDb = bands.map((v) => (v === null ? null : v - mean))
  }
  let total = 0
  for (let i = 0; i < samples.length; i++) total += samples[i]! * samples[i]!
  return {
    sampleRate,
    duration,
    rmsDb: powerDb(total / Math.max(1, samples.length)),
    notes,
    pitchTrack: Array.from(levels, (rmsDb, i) => ({ t: i * hop, f0: inNote[i] ? midiToFreq(midi[i]!) : null, rmsDb })),
    summary: {
      ...summarize(notes, voicedFrames ? glideFrames / voicedFrames : 0),
      trillCount: trills.length,
      trillRateHz: median(nonNull(trills.map((t) => t.rate))),
      trillExtentCents: median(trills.map((t) => t.extent)),
      slideCount: between.length,
      slideMs: median(between.map((s) => s.seconds * 1000)),
      slideSemitones: median(between.map((s) => Math.abs(s.semitones))),
      ltasDb,
      dynamicRangeDb: noteLevels.length >= ANALYSIS.dynamicsMinNotes ? percentile(noteLevels, 0.95)! - percentile(noteLevels, 0.05)! : null
    }
  }
}

function summarize(notes: readonly NoteFeatures[], glideShare: number): AudioFeatures['summary'] {
  const measured = notes.filter((n) => n.harmonicsDb.length === ANALYSIS.harmonics)
  const harmonics = measured.length ? Array.from({ length: ANALYSIS.harmonics }, (_, k) => median(measured.map((n) => n.harmonicsDb[k]!))!) : []
  const strongest = Math.max(...harmonics)
  const span = notes.length ? notes[notes.length - 1]!.end - notes[0]!.start : 0
  const hasVibrato = (n: NoteFeatures) => n.vibratoRateHz !== null && (n.vibratoExtentCents ?? 0) >= ANALYSIS.vibratoMinExtentCents
  const long = notes.filter((n) => n.end - n.start >= ANALYSIS.vibratoShareMinSeconds)
  const vibratoNotes = notes.filter(hasVibrato)
  const starts = notes.map((n) => n.start)
  const tempo = estimateTempo(starts)
  const rhythm = ioiRatios(starts)
  const key = pitchClassProfile(notes)
  return {
    f0MedianHz: median(nonNull(notes.map((n) => n.f0))),
    // Rate and width of the vibrato where there is some; how often it occurs is vibratoShare.
    vibratoRateHz: median(nonNull(vibratoNotes.map((n) => n.vibratoRateHz))),
    vibratoExtentCents: median(nonNull(vibratoNotes.map((n) => n.vibratoExtentCents))),
    harmonicsDb: harmonics.map((v) => v - strongest),
    centroidHz: median(nonNull(notes.map((n) => n.centroidHz))),
    hnrDb: median(nonNull(notes.map((n) => n.hnrDb))),
    attackMs: median(nonNull(notes.map((n) => n.attackMs))),
    noteRate: span > 0 ? notes.length / span : 0,
    glideShare,
    tempoBpm: tempo.bpm,
    tempoVariance: tempo.variance,
    tuningCents: key.tuningCents,
    pitchClasses: key.classes,
    vibratoShare: long.length ? long.filter(hasVibrato).length / long.length : null,
    vibratoOnsetMs: median(nonNull(vibratoNotes.map((n) => n.vibratoOnsetMs))),
    amPhase: median(nonNull(vibratoNotes.map((n) => n.amCorrelation))),
    ioiRatioPeaks: rhythm.peaks,
    ioiRatio: rhythm.main
  }
}

// ---------------------------------------------------------------------------------------------
// Checks of our own render
// ---------------------------------------------------------------------------------------------

export interface BulanovCheck {
  /** Per target maximum: the strongest spectral maximum within `bulanovSearchOctaves`, if any. */
  maxima: { targetHz: number; foundHz: number | null; levelDb: number | null }[]
  found: number
  /** Level spread (max − min) of the maxima near 280, 440 and 780 Hz; null if one is missing. */
  midSpreadDb: number | null
  /** The verdict; null when the render cannot be judged (not `measurable`). */
  ok: boolean | null
  /** What the response was read from: the notes' harmonics (the string's spectrum taken out), the plain spectrum (noise, an impulse) or the features' long-term spectrum. */
  method: 'harmonics' | 'spectrum' | 'ltas'
  /**
   * Targets whose surroundings (±`bulanovSearchOctaves`) the response samples densely enough to
   * show a maximum, or where one was found: in both outer halves, where the minima around it lie,
   * and with no gap over `bulanovMaxGapOctaves` (the long-term spectrum's band spacing for method
   * 'ltas', which only needs data on both sides). A melody with few pitches leaves gaps, so a
   * missing maximum there says little.
   */
  sampled: number
  /**
   * At least `bulanovMinFound` targets sampled, among them the three the level spread needs (280,
   * 440 and 780 Hz): otherwise the render cannot be judged (ok is null), e.g. a pentatonic melody;
   * a chromatic scale is best.
   */
  measurable: boolean
}

/**
 * The body's response sampled by the notes' harmonics, in 1/24-octave bands (dB, mean 0): each
 * harmonic level is modelled as note level + source + response at its frequency, and the three
 * are fitted by alternating least squares. The source is a sawtooth's 1/k (Helmholtz motion)
 * times a shape that is free apart from its tilt, so the response keeps the body's own tilt.
 * Empty without notes at `bulanovMinPitches` different pitches.
 */
function harmonicResponse(notes: readonly NoteFeatures[]): { hz: number; db: number }[] {
  const H = ANALYSIS.harmonics
  const usable = notes.filter((n) => n.f0 !== null && n.harmonicsDb.length === H)
  if (new Set(usable.map((n) => Math.round(freqToMidi(n.f0!)))).size < RENDER_CHECKS.bulanovMinPitches) return []
  const perOctave = 24
  const bandCount = Math.ceil(perOctave * Math.log2(8000 / 100))
  const data: { n: number; k: number; b: number; y: number }[] = []
  usable.forEach((note, n) =>
    note.harmonicsDb.forEach((db, k) => {
      const b = Math.floor(perOctave * Math.log2(((k + 1) * note.f0!) / 100))
      if (db > -60 && b >= 0 && b < bandCount) data.push({ n, k, b, y: db + 20 * Math.log10(k + 1) })
    })
  )
  const level = new Float64Array(usable.length)
  const source = new Float64Array(H)
  const response = new Float64Array(bandCount)
  const count = new Float64Array(bandCount)
  for (const d of data) count[d.b] = count[d.b]! + 1
  /** Each entry of `target` becomes the mean residual of the data it explains. */
  const update = (target: Float64Array, key: 'n' | 'k' | 'b', residual: (d: (typeof data)[number]) => number) => {
    const sum = new Float64Array(target.length)
    const weight = new Float64Array(target.length)
    for (const d of data) {
      sum[d[key]] = sum[d[key]]! + residual(d)
      weight[d[key]] = weight[d[key]]! + 1
    }
    for (let i = 0; i < target.length; i++) target[i] = weight[i]! ? sum[i]! / weight[i]! : 0
  }
  const logK = Array.from({ length: H }, (_, k) => Math.log2(k + 1))
  const meanLogK = logK.reduce((s, v) => s + v, 0) / H
  const spreadLogK = logK.reduce((s, x) => s + (x - meanLogK) ** 2, 0)
  for (let iteration = 0; iteration < 40; iteration++) {
    update(level, 'n', (d) => d.y - source[d.k]! - response[d.b]!)
    update(source, 'k', (d) => d.y - level[d.n]! - response[d.b]!)
    // The source's own tilt would trade off against the response's: keep only its shape.
    const mean = source.reduce((s, v) => s + v, 0) / H
    const slope = logK.reduce((s, x, k) => s + (x - meanLogK) * (source[k]! - mean), 0) / spreadLogK
    for (let k = 0; k < H; k++) source[k] = source[k]! - mean - slope * (logK[k]! - meanLogK)
    update(response, 'b', (d) => d.y - level[d.n]! - source[d.k]!)
    let [sum, weight] = [0, 0]
    for (let b = 0; b < bandCount; b++) [sum, weight] = [sum + response[b]! * count[b]!, weight + count[b]!]
    for (let b = 0; b < bandCount; b++) response[b] = response[b]! - sum / weight
  }
  const bands = Array.from(response, (db, b) => ({ hz: 100 * 2 ** ((b + 0.5) / perOctave), db, n: count[b]! })).filter((band) => band.n > 0)
  // Light smoothing over the neighbouring bands that have data.
  return bands.map((band, i) => {
    const near = bands.slice(Math.max(0, i - 1), i + 2).filter((o) => Math.abs(Math.log2(o.hz / band.hz)) < 1.5 / perOctave)
    const weights = near.map((o) => (o === band ? 2 : 1))
    return { hz: band.hz, db: near.reduce((s, o, j) => s + o.db * weights[j]!, 0) / weights.reduce((s, w) => s + w, 0) }
  })
}

/**
 * Spectral envelope for bulanovMaxima when there are no notes to read (noise, an impulse
 * response): a Welch average of Hann frames (≈ 0.1 s, frames within 40 dB of the loudest; the
 * signal is padded by half a frame so an impulse at the start is not windowed away), peak-held in
 * 1/24-octave bands from 100 Hz to 8 kHz and smoothed.
 */
function envelopeCurve(samples: Float32Array, sampleRate: number): { hz: number; db: number }[] {
  const size = nextPowerOfTwo(0.1 * sampleRate)
  if (samples.length < size / 2) return []
  const padded = new Float32Array(samples.length + size)
  padded.set(samples, size / 2)
  const window = hannWindow(size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const average = new Float64Array(size / 2 + 1)
  const offsets: number[] = []
  const energy: number[] = []
  for (let o = 0; o + size <= padded.length; o += size / 4) {
    let e = 0
    for (let j = 0; j < size; j++) e += (padded[o + j]! * window[j]!) ** 2
    offsets.push(o)
    energy.push(e)
  }
  const floor = maxOfArray(energy) * 1e-4
  for (const [i, o] of offsets.entries()) {
    if (energy[i]! < floor || energy[i]! <= 0) continue
    re.fill(0)
    im.fill(0)
    for (let j = 0; j < size; j++) re[j] = padded[o + j]! * window[j]!
    fft(re, im)
    for (let k = 0; k <= size / 2; k++) average[k] = average[k]! + re[k]! * re[k]! + im[k]! * im[k]!
  }
  const binHz = sampleRate / size
  const bands: { hz: number; db: number }[] = []
  for (let k = 0; 100 * 2 ** ((k + 1) / 24) <= Math.min(8000 * 2 ** (1 / 48), sampleRate / 2); k++) {
    const lo = 100 * 2 ** (k / 24)
    const hi = 100 * 2 ** ((k + 1) / 24)
    let peak = 0
    for (let b = Math.ceil(lo / binHz); b * binHz < hi; b++) peak = Math.max(peak, average[b]!)
    if (peak === 0) peak = average[Math.round(Math.sqrt(lo * hi) / binHz)]!
    bands.push({ hz: Math.sqrt(lo * hi), db: powerDb(peak) })
  }
  return bands.map((b, i) => ({ hz: b.hz, db: (bands[Math.max(0, i - 1)]!.db + 2 * b.db + bands[Math.min(bands.length - 1, i + 1)]!.db) / 4 }))
}

function maxOfArray(values: readonly number[]): number {
  let max = -Infinity
  for (const v of values) if (v > max) max = v
  return max
}

/**
 * Bulanov's soundbox maxima (RENDER_CHECKS.bulanovMaximaHz) in our render: at least
 * `bulanovMinFound` of them, and the three around 280–780 Hz within `bulanovMidSpreadDb`. The
 * response is read from the notes' harmonics with the string's own spectrum taken out
 * (harmonicResponse; best from material covering many pitches, such as a chromatic scale).
 * Without enough notes it comes from the spectrum of the samples (noise or an impulse through the
 * body) or, coarsely, from the features' 1/6-octave long-term spectrum. A maximum is a local peak
 * rising ≥ 1 dB above the lower of the minima within 1/6 octave on either side. Material that
 * samples the response too sparsely (fewer than `bulanovMinFound` targets `sampled`, or not the
 * three around 280–780 Hz) is reported as not `measurable` (ok null) rather than judged.
 */
export function bulanovMaxima(input: AudioFeatures | { samples: Float32Array; sampleRate: number }): BulanovCheck {
  const C = RENDER_CHECKS
  const features = 'samples' in input ? analyzeAudio(input.samples, input.sampleRate) : input
  let method: BulanovCheck['method'] = 'harmonics'
  let curve = harmonicResponse(features.notes)
  if (!curve.length && 'samples' in input) [curve, method] = [envelopeCurve(input.samples, input.sampleRate), 'spectrum']
  else if (!curve.length) [curve, method] = [(features.summary.ltasDb ?? []).flatMap((db, k) => (db === null ? [] : [{ hz: LTAS_BANDS_HZ[k]!, db }])), 'ltas']
  const peaks = curve.filter((p, i) => {
    if (i === 0 || i === curve.length - 1 || p.db < curve[i - 1]!.db || p.db <= curve[i + 1]!.db) return false
    const near = curve.filter((q) => Math.abs(Math.log2(q.hz / p.hz)) <= C.bulanovSearchOctaves + 1e-9)
    const left = Math.min(...near.filter((q) => q.hz <= p.hz).map((q) => q.db))
    const right = Math.min(...near.filter((q) => q.hz >= p.hz).map((q) => q.db))
    return p.db - Math.max(left, right) >= 1
  })
  const maxima = C.bulanovMaximaHz.map((targetHz) => {
    const candidates = peaks.filter((p) => Math.abs(Math.log2(p.hz / targetHz)) <= C.bulanovSearchOctaves + 1e-9)
    const best = candidates.reduce<{ hz: number; db: number } | null>((m, p) => (m === null || p.db > m.db ? p : m), null)
    return { targetHz, foundHz: best?.hz ?? null, levelDb: best?.db ?? null }
  })
  const mid = maxima.filter((m) => m.targetHz >= 280 && m.targetHz <= 780).map((m) => m.levelDb)
  const midLevels = nonNull(mid)
  const midSpreadDb = midLevels.length === mid.length ? Math.max(...midLevels) - Math.min(...midLevels) : null
  const found = maxima.filter((m) => m.foundHz !== null).length
  const [maxGap, outer] = method === 'ltas' ? [1 / 6 + 1e-9, 1e-9] : [C.bulanovMaxGapOctaves, C.bulanovSearchOctaves / 2]
  // A maximum found proves its surroundings were seen.
  const covered = C.bulanovMaximaHz.map((t, k) => {
    if (maxima[k]!.foundHz !== null) return true
    const at = curve.map((p) => Math.log2(p.hz / t)).filter((o) => Math.abs(o) <= C.bulanovSearchOctaves + 1e-9)
    if (!at.some((o) => o <= -outer) || !at.some((o) => o >= outer)) return false
    const edges = [-C.bulanovSearchOctaves, ...at, C.bulanovSearchOctaves]
    return edges.every((o, k) => k === 0 || o - edges[k - 1]! <= maxGap)
  })
  const sampled = covered.filter(Boolean).length
  const measurable = sampled >= C.bulanovMinFound && C.bulanovMaximaHz.every((t, k) => covered[k] || t < 280 || t > 780)
  const ok = measurable ? found >= C.bulanovMinFound && midSpreadDb !== null && midSpreadDb <= C.bulanovMidSpreadDb : null
  return { maxima, found, midSpreadDb, ok, method, sampled, measurable }
}

/**
 * The open male string's fundamental against its strongest overtone, H1 − max(H2, H3) (median
 * over the notes within 50 cents of `openHz`); Bulanov measured it 1–2 dB below.
 */
export function openStringBalance(features: AudioFeatures, openHz: number = RENDER_CHECKS.openStringHz): { notes: number; balanceDb: number | null; ok: boolean | null } {
  const open = features.notes.filter((n) => n.f0 !== null && Math.abs(centsBetween(openHz, n.f0)) < 50 && n.harmonicsDb.length >= 3)
  const balanceDb = median(open.map((n) => n.harmonicsDb[0]! - Math.max(n.harmonicsDb[1]!, n.harmonicsDb[2]!)))
  const [lo, hi] = RENDER_CHECKS.openStringBalanceDb
  return { notes: open.length, balanceDb, ok: balanceDb === null ? null : balanceDb >= lo && balanceDb <= hi }
}

// ---------------------------------------------------------------------------------------------
// Melody
// ---------------------------------------------------------------------------------------------

const MELODY_MAX_NOTES = 2000

/**
 * Pitch offsets (a − b) of the notes an alignment of the two interval sequences pairs up: an edit
 * distance where an interval matches within half a semitone and two intervals of one side may
 * match one of the other (a repeated or passing note, cost ½). Only the transposition is taken
 * from it: a run shifted as a whole keeps its intervals.
 */
function intervalOffsets(a: readonly number[], b: readonly number[], cost: Float32Array, move: Uint8Array): number[] {
  const ia = a.slice(1).map((v, i) => v - a[i]!)
  const ib = b.slice(1).map((v, j) => v - b[j]!)
  const n = ia.length
  const m = ib.length
  const same = (x: number, y: number) => Math.abs(x - y) < 0.5
  const width = m + 1
  // 1 match, 2 substitute, 3 skip ours, 4 skip theirs, 5 two of ours = one of theirs, 6 one of ours = two of theirs.
  cost[0] = 0
  for (let i = 0; i <= n; i++) {
    for (let j = i === 0 ? 1 : 0; j <= m; j++) {
      const here = i * width + j
      let best = Infinity
      let op = 0
      const take = (value: number, which: number) => {
        if (value < best) {
          best = value
          op = which
        }
      }
      if (i > 0 && j > 0) {
        const equal = same(ia[i - 1]!, ib[j - 1]!)
        take(cost[here - width - 1]! + (equal ? 0 : 1), equal ? 1 : 2)
      }
      if (i > 0) take(cost[here - width]! + 1, 3)
      if (j > 0) take(cost[here - 1]! + 1, 4)
      if (i > 1 && j > 0 && same(ia[i - 2]! + ia[i - 1]!, ib[j - 1]!)) take(cost[here - 2 * width - 1]! + 0.5, 5)
      if (i > 0 && j > 1 && same(ia[i - 1]!, ib[j - 2]! + ib[j - 1]!)) take(cost[here - width - 2]! + 0.5, 6)
      cost[here] = best
      move[here] = op
    }
  }
  const offsets: number[] = []
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const op = move[i * width + j]!
    if (op === 1) offsets.push(a[i]! - b[j]!, a[i - 1]! - b[j - 1]!)
    else if (op === 5) offsets.push(a[i]! - b[j]!, a[i - 2]! - b[j - 1]!)
    else if (op === 6) offsets.push(a[i]! - b[j]!, a[i - 1]! - b[j - 2]!)
    i -= op === 5 ? 2 : op === 4 ? 0 : 1
    j -= op === 6 ? 2 : op === 3 ? 0 : 1
  }
  return offsets
}

/**
 * Note-by-note alignment of `a` with `b` + `offset`: a note matches within half a semitone; a
 * wrong, extra or missing note costs 1, except a repeat of the note before it on either side (a
 * re-bowed note, ¼). Notes of `b` before and after the part `a` plays are free. Returns the cost
 * and the indexes into `a` that differ: wrong and extra notes, and the note after a missing one
 * (the one before it at the end).
 */
function alignPitches(a: readonly number[], b: readonly number[], offset: number, cost: Float32Array, move: Uint8Array): { cost: number; differing: number[]; offsets: number[] } {
  const n = a.length
  const m = b.length
  const width = m + 1
  const same = (x: number, y: number) => Math.abs(x - y - offset) < 0.5
  const repeat = 0.25
  // A match earns a little, so of two equally costly alignments the one matching more notes wins.
  const hit = -0.01
  // 1 match, 2 wrong note, 3 extra in a, 4 missing from a.
  for (let j = 0; j <= m; j++) cost[j] = 0
  for (let i = 1; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const here = i * width + j
      const extra = i > 1 && Math.abs(a[i - 1]! - a[i - 2]!) < 0.5 ? repeat : 1
      let best = cost[here - width]! + extra
      let op = 3
      if (j > 0) {
        const equal = same(a[i - 1]!, b[j - 1]!)
        const diagonal = cost[here - width - 1]! + (equal ? hit : 1)
        if (diagonal <= best) [best, op] = [diagonal, equal ? 1 : 2]
        const missing = cost[here - 1]! + (j > 1 && Math.abs(b[j - 1]! - b[j - 2]!) < 0.5 ? repeat : 1)
        if (missing < best) [best, op] = [missing, 4]
      }
      cost[here] = best
      move[here] = op
    }
  }
  let j = 0
  for (let k = 1; k <= m; k++) if (cost[n * width + k]! < cost[n * width + j]!) j = k
  const total = cost[n * width + j]!
  const differing = new Set<number>()
  const offsets: number[] = []
  for (let i = n; i > 0; ) {
    const op = move[i * width + j]!
    if (op === 1) offsets.push(a[i - 1]! - b[j - 1]!)
    else if (op === 2 || (op === 3 && !(i > 1 && Math.abs(a[i - 1]! - a[i - 2]!) < 0.5))) differing.add(i - 1)
    else if (op === 4 && !(j > 1 && Math.abs(b[j - 1]! - b[j - 2]!) < 0.5)) differing.add(i < n ? i : i - 1)
    if (op !== 4) i--
    if (op !== 3) j--
  }
  return { cost: total, differing: [...differing].sort((x, y) => x - y), offsets }
}

/**
 * Transposition-invariant melody match of `a` against `b` (MIDI pitches). The transposition comes
 * from an alignment of the interval sequences (the commonest offset of the paired notes, trying
 * the runner-up too when it is nearly as common, e.g. a melody played half in another key); then
 * the notes themselves are aligned at it (alignPitches), so a wrong note, an extra one and a
 * missing one are all found, while a re-bowed repeat on either side is not a difference.
 */
export function melodyMatch(a: readonly number[], b: readonly number[]): MelodyMatch {
  const total = a.length
  if (total === 0) return { share: 0, matched: 0, total, differing: [], transposition: null }
  // The tables grow with both lengths: long recordings are matched over their first notes.
  if (a.length > MELODY_MAX_NOTES || b.length > MELODY_MAX_NOTES) return melodyMatch(a.slice(0, MELODY_MAX_NOTES), b.slice(0, MELODY_MAX_NOTES))
  if (total === 1 || b.length < 2) {
    const all = b.length > 0 && total === 1
    return { share: all ? 1 : 0, matched: all ? 1 : 0, total, differing: all ? [] : a.map((_, i) => i), transposition: all ? Math.round(a[0]! - b[0]!) : null }
  }
  const cost = new Float32Array((a.length + 1) * (b.length + 1))
  const move = new Uint8Array(cost.length)
  // Offsets grouped by the nearest semitone; each group's median keeps a tuning difference.
  const groups = new Map<number, number[]>()
  for (const o of intervalOffsets(a, b, cost, move)) groups.set(Math.round(o), [...(groups.get(Math.round(o)) ?? []), o])
  const ranked = [...groups.values()].sort((x, y) => y.length - x.length || Math.abs(median(x)!) - Math.abs(median(y)!))
  const candidates = ranked.length ? ranked.filter((g, k) => k < 2 && g.length >= 0.5 * ranked[0]!.length).map((g) => median(g)!) : [median(a)! - median(b)!]
  let best: ReturnType<typeof alignPitches> | null = null
  for (const offset of candidates) {
    const found = alignPitches(a, b, offset, cost, move)
    if (!best || found.cost < best.cost) best = found
  }
  const { differing, offsets } = best!
  const offset = median(offsets)
  return { share: (total - differing.length) / total, matched: total - differing.length, total, differing, transposition: offset === null ? null : Math.round(offset) }
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`)
const fixed = (v: number, digits = 1) => v.toFixed(digits)
const signedDb = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} dB`
const semitones = (v: number) => `${Math.abs(v)} semitone${Math.abs(v) === 1 ? '' : 's'}`

/** "3, 7, 12–14" from sorted numbers. */
function ranges(values: readonly number[]): string {
  const parts: string[] = []
  for (let i = 0; i < values.length; ) {
    let j = i
    while (j + 1 < values.length && values[j + 1] === values[j]! + 1) j++
    parts.push(j > i ? `${values[i]}–${values[j]}` : `${values[i]}`)
    i = j + 1
  }
  return parts.join(', ')
}

interface RowSpec {
  feature: string
  label: string
  group: ComparisonGroup
  sim: number | null
  ref: number | null
  /** Absolute tolerance in `unit`; may depend on the original's value. */
  tolerance: (ref: number) => number
  unit: string
  /** Hint when both values exist and differ beyond tolerance; `higher` = ours is higher. */
  differs: (sim: number, ref: number, higher: boolean) => string
  same: (sim: number, ref: number) => string
  missing: (sim: number | null, ref: number | null) => string
  /** Custom within-tolerance test (default |delta| ≤ tolerance). */
  within?: (sim: number, ref: number) => boolean
  /** Outside tolerance, report without scoring (ok null, `informational`). */
  inform?: boolean
}

function row(spec: RowSpec): ComparisonRow {
  const { feature, label, group, sim, ref, unit } = spec
  if (sim === null || ref === null || !Number.isFinite(sim) || !Number.isFinite(ref)) {
    return { feature, label, sim, ref, delta: null, tolerance: ref !== null && Number.isFinite(ref) ? spec.tolerance(ref) : spec.tolerance(0), unit, ok: null, hint: spec.missing(sim, ref), group }
  }
  const delta = sim - ref
  const tolerance = spec.tolerance(ref)
  const ok = spec.within ? spec.within(sim, ref) : Math.abs(delta) <= tolerance
  const hint = ok ? spec.same(sim, ref) : spec.differs(sim, ref, delta > 0)
  if (!ok && spec.inform) return { feature, label, sim, ref, delta, tolerance, unit, ok: null, hint, group, informational: true }
  return { feature, label, sim, ref, delta, tolerance, unit, ok, hint, group }
}

const notMeasured = (what: string) => (sim: number | null, ref: number | null) =>
  sim === null && ref === null ? `Neither recording has enough steady notes to measure ${what}.` : `Could not measure ${what} in ${sim === null ? 'our version' : 'the original'}.`

/** For features that are simply absent from both (no trills, no slides): no hint then. */
const onlyOne = (present: (inOriginal: boolean, value: number) => string) => (sim: number | null, ref: number | null) =>
  sim === null && ref === null ? '' : ref !== null ? present(true, ref) : present(false, sim!)

/**
 * Key difference from the pitch-class histograms (circular cross-correlation), ours − original,
 * in −5…+6 semitones, then moved by octaves towards the median-pitch difference.
 */
function keyShift(sim: AudioFeatures['summary'], ref: AudioFeatures['summary']): number | null {
  const a = sim.pitchClasses ?? []
  const b = ref.pitchClasses ?? []
  if (a.length !== 12 || b.length !== 12) return null
  let best = 0
  let bestScore = -Infinity
  for (let s = 0; s < 12; s++) {
    let score = 0
    for (let k = 0; k < 12; k++) score += a[(k + s) % 12]! * b[k]!
    if (score > bestScore + 1e-12) [best, bestScore] = [s, score]
  }
  const shift = best > 6 ? best - 12 : best
  if (sim.f0MedianHz == null || ref.f0MedianHz == null) return shift
  const semis = 12 * Math.log2(sim.f0MedianHz / ref.f0MedianHz)
  return shift + 12 * Math.round((semis - shift) / 12)
}

/**
 * Mean and largest band difference of two long-term spectra over their common bands from `fromHz`
 * up, re-normalised there. With `smooth`, the difference is first averaged over each band and its
 * neighbours (half an octave).
 */
function ltasDifference(
  a: readonly (number | null)[] | undefined,
  source: readonly (number | null)[] | undefined,
  fromHz = 0,
  smooth = false,
  semitones = 0
): { mean: number; max: number; worstHz: number; worstDb: number } | null {
  // `source` moved up by `semitones` (two to a band), interpolating between its bands.
  const b = semitones
    ? LTAS_BANDS_HZ.map((_, k) => {
        const x = k - semitones / 2
        const [i, w] = [Math.floor(x), x - Math.floor(x)]
        const [lo, hi] = [source?.[i], source?.[i + 1]]
        return lo == null || (w > 0 && hi == null) ? null : w > 0 ? lo * (1 - w) + hi! * w : lo
      })
    : source
  const common = LTAS_BANDS_HZ.flatMap((hz, k) => (a?.[k] != null && b?.[k] != null && hz >= fromHz ? [k] : []))
  if (common.length < 6) return null
  const meanOf = (x: readonly (number | null)[]) => common.reduce((s, k) => s + x[k]!, 0) / common.length
  const [ma, mb] = [meanOf(a!), meanOf(b!)]
  const raw = new Map(common.map((k) => [k, a![k]! - ma - (b![k]! - mb)]))
  const diff = (k: number) => {
    if (!smooth) return raw.get(k)!
    const near = [k - 1, k, k + 1].filter((j) => raw.has(j))
    return near.reduce((s, j) => s + raw.get(j)!, 0) / near.length
  }
  let sum = 0
  let worst = common[0]!
  for (const k of common) {
    sum += Math.abs(diff(k))
    if (Math.abs(diff(k)) > Math.abs(diff(worst))) worst = k
  }
  return { mean: sum / common.length, max: Math.abs(diff(worst)), worstHz: LTAS_BANDS_HZ[worst]!, worstDb: diff(worst) }
}

/**
 * Compares our render (`sim`) with the original (`ref`), feature by feature, with plain-language
 * hints. `referenceKind` keeps only the rows that make sense for the original (REFERENCE_ROWS);
 * the score counts only those.
 */
export function compareFeatures(sim: AudioFeatures, ref: AudioFeatures, { referenceKind = 'fiddle', barOf }: CompareOptions = {}): FeatureComparison {
  const T = COMPARISON_TOLERANCES
  const a = sim.summary
  const b = ref.summary
  const balance = (s: AudioFeatures['summary'], k: number) => (s.harmonicsDb.length > k ? s.harmonicsDb[k]! - s.harmonicsDb[0]! : null)
  const pitches = (f: AudioFeatures) => nonNull(f.notes.map((n) => (n.f0 === null ? null : freqToMidi(n.f0))))
  const simNotes = sim.notes.filter((n) => n.f0 !== null)
  const match = simNotes.length && ref.notes.length ? melodyMatch(pitches(sim), pitches(ref)) : null
  const melody = match && { ...match, differingBars: barOf ? [...new Set(match.differing.map((i) => barOf(simNotes[i]!.start)))].sort((x, y) => x - y) : null }
  // The melody alignment knows the octave too; the pitch classes are the fallback.
  const transposition = match && match.transposition !== null && match.share >= 0.5 ? match.transposition : keyShift(a, b)
  const transposed = transposition ? `, after transposing by ${transposition > 0 ? '+' : '−'}${semitones(transposition)}` : ''
  const differ = () => {
    const bars = melody!.differingBars
    const count = melody!.differing.length
    return `${count} of our ${melody!.total} notes differ${count === 1 ? 's' : ''} from the original's melody${bars?.length ? ` in bar${bars.length === 1 ? '' : 's'} ${ranges(bars)}` : ''}`
  }
  // Around the fundamentals the long-term spectrum follows the notes played (the key and melody),
  // so it is compared from an octave above the lower notes of the higher recording; in another
  // key or octave its fine structure (where the harmonics fall) moves too, so it is compared
  // half-octave-smoothed.
  const lowNotes = (f: AudioFeatures) => percentile(nonNull(f.notes.map((n) => n.f0)), 0.05)
  const [simLow, refLow] = [lowNotes(sim), lowNotes(ref)]
  const otherKey = !!transposition
  const fromHz = simLow !== null && refLow !== null ? 2 * Math.max(simLow, refLow) : 0
  // In another key the spectrum may follow the notes (the string) or stay put (the body): the
  // original's is compared both as it is and moved into our key, and the closer counts.
  const [asIs, moved] = [ltasDifference(a.ltasDb, b.ltasDb, fromHz, otherKey), otherKey ? ltasDifference(a.ltasDb, b.ltasDb, fromHz, true, transposition!) : null]
  const spectrum = moved && (!asIs || moved.mean < asIs.mean) ? moved : asIs
  const spectrumMoved = !!moved && spectrum === moved
  // The original's median pitch moved into our key: what is left is the tuning.
  const keyRatio = 2 ** ((transposition ?? 0) / 12)
  // The brightness likewise lies between the original's as it is (the body's resonances stay put)
  // and scaled into our key (the string's harmonics move); in another register (`registerSemitones`
  // or more away), where low notes with vibrato also read a lower HNR (the ceiling their smeared
  // harmonics allow), neither is scored.
  const register = Math.abs(transposition ?? 0) >= T.registerSemitones
  const brightnessWithin = (s: number, r: number) => Math.abs(s - r) <= T.centroidRelative * r
  const brightnessScaled = (s: number, r: number) =>
    otherKey && !brightnessWithin(s, r) && s >= Math.min(r, r * keyRatio) * (1 - T.centroidRelative) && s <= Math.max(r, r * keyRatio) * (1 + T.centroidRelative)
  const byKey = transposition ? ` once the original is transposed by ${transposition > 0 ? '+' : '−'}${semitones(transposition)}` : ''
  const bandsIn = (x: readonly (number | null)[] | undefined) => (x ?? []).filter((v) => v != null).length
  const oneSided = (what: string, simHas: boolean, refHas: boolean, neither: string) =>
    !simHas && !refHas ? neither : !simHas ? `Could not measure ${what} in our version.` : !refHas ? `Could not measure ${what} in the original.` : ''
  const phase = (v: number | null | undefined) => (v != null && Math.abs(v) >= T.amPhaseMinCorrelation ? v : null)
  const even = (v: number) => v < ANALYSIS.ioiUnevenRatio
  // Each ratio peak of one rhythm must be in the other (within `ioiRatioRelative`); summaries without peaks compare the main ratio only.
  const [simPeaks, refPeaks] = [a.ioiRatioPeaks ?? [], b.ioiRatioPeaks ?? []]
  const covers = (x: readonly number[], y: readonly number[]) => x.every((p) => y.some((q) => Math.abs(p - q) <= T.ioiRatioRelative * q))
  const peaksAgree = !simPeaks.length || !refPeaks.length || (covers(simPeaks, refPeaks) && covers(refPeaks, simPeaks))
  const ratioList = (peaks: readonly number[]) => [...peaks].sort((x, y) => x - y).map((p) => `${fixed(p, 2)}:1`).join(' and ')
  const rows = [
    row({
      feature: 'f0',
      label: 'Pitch (median note)',
      group: 'pitch',
      sim: a.f0MedianHz,
      ref: b.f0MedianHz === null ? null : b.f0MedianHz * keyRatio,
      tolerance: (r) => r * (2 ** (T.f0Cents / 1200) - 1),
      unit: 'Hz',
      within: (s, r) => Math.abs(centsBetween(r, s)) <= T.f0Cents,
      same: (s, r) =>
        transposition ? `Same tuning as the original${byKey} (${Math.round(Math.abs(centsBetween(r, s)))} cents apart).` : `Same key and tuning as the original (${Math.round(Math.abs(centsBetween(r, s)))} cents apart).`,
      differs: (s, r, higher) => {
        const cents = Math.abs(centsBetween(r, s))
        const dir = higher ? 'higher' : 'lower'
        if (cents < 100) return `Ours is ${Math.round(cents)} cents ${higher ? 'sharper' : 'flatter'} than the original${byKey}: the original may be tuned differently (not A = 440 Hz).`
        if (Math.abs(cents - 1200) < 60) return `Ours is an octave ${dir} than the original: check the octave the melody is played in.`
        return `Ours is ${fixed(cents / 100)} semitones ${dir} than the original (${hz(s)} vs ${hz(r)}): probably a different key or tuning, so transpose or retune before comparing pitch by ear.`
      },
      missing: notMeasured('the pitch')
    }),
    row({
      feature: 'transposition',
      label: 'Key (from the notes used)',
      group: 'pitch',
      sim: transposition ?? null,
      ref: transposition === null ? null : 0,
      tolerance: () => T.transpositionSemitones,
      unit: 'st',
      inform: true,
      same: () => 'Same key as the original.',
      differs: (s) =>
        Math.abs(s) % 12 === 0
          ? `Ours is ${Math.abs(s) / 12 === 1 ? 'an octave' : `${Math.abs(s) / 12} octaves`} ${s > 0 ? 'higher' : 'lower'} than the original, in the same key; the pitch and melody are compared after transposing, so this does not count against the score.`
          : `Ours is ${semitones(s)} ${s > 0 ? 'higher' : 'lower'} than the original (another key); the pitch and melody are compared after transposing, so this does not count against the score. Transpose one of them before comparing by ear.`,
      missing: notMeasured('the key')
    }),
    row({
      feature: 'melody',
      label: 'Melody (our notes found in the original)',
      group: 'pitch',
      sim: melody ? melody.share * 100 : null,
      ref: melody ? 100 : null,
      tolerance: () => (1 - T.melodyShare) * 100,
      unit: '%',
      same: (s) =>
        melody!.differing.length
          ? `The melody mostly matches the original (${Math.round(s)}% of our notes${transposed}); ${differ()}.`
          : `The melody matches the original (${Math.round(s)}% of our notes${transposed}).`,
      differs: () => `${differ()}${transposed}: check ${melody!.differingBars?.length ? 'those bars' : 'them'} against the recording.`,
      missing: () => oneSided('the melody', simNotes.length > 0, ref.notes.some((n) => n.f0 !== null), 'Neither recording has notes to compare the melody.')
    }),
    row({
      feature: 'tempo',
      label: 'Tempo',
      group: 'rhythm',
      sim: a.tempoBpm ?? null,
      ref: b.tempoBpm ?? null,
      tolerance: (r) => T.tempoRelative * r,
      unit: 'BPM',
      same: (s, r) => `Same tempo as the original (${Math.round(s)} vs ${Math.round(r)} BPM).`,
      differs: (s, r, higher) => {
        const ratio = s / r
        if (Math.abs(ratio - 2) <= 2 * T.tempoRelative || Math.abs(ratio - 0.5) <= 0.5 * T.tempoRelative)
          return `Ours reads as ${ratio > 1 ? 'double' : 'half'} the original's tempo (${Math.round(s)} vs ${Math.round(r)} BPM): probably the same tempo counted at a different beat, so check by ear before changing it.`
        // Even notes can be heard in threes or fours: a beat of 3 notes against one of 2 or 4.
        const grouping = [
          [3, 2],
          [2, 3],
          [4, 3],
          [3, 4]
        ].find(([p, q]) => Math.abs(ratio - p! / q!) <= (p! / q!) * T.tempoRelative)
        if (grouping)
          return `Ours reads as ${grouping[0]}/${grouping[1]} of the original's tempo (${Math.round(s)} vs ${Math.round(r)} BPM): even notes can be felt in groups of ${grouping[1]} or ${grouping[0]}, so this may be the same speed with a different beat. Check by ear before changing it.`
        return `Ours is ${higher ? 'faster' : 'slower'} than the original (${Math.round(s)} vs ${Math.round(r)} BPM, ${Math.round(Math.abs(ratio - 1) * 100)}%).`
      },
      missing: notMeasured('the tempo (it needs at least 8 notes)')
    }),
    row({
      feature: 'tempoVariance',
      label: 'Tempo steadiness (variation over two bars)',
      group: 'rhythm',
      sim: a.tempoVariance == null ? null : a.tempoVariance * 100,
      ref: b.tempoVariance == null ? null : b.tempoVariance * 100,
      tolerance: (r) => Math.max(T.tempoVarianceRelative * r, T.tempoVarianceFloor * 100),
      unit: '%',
      same: (s, r) => `The tempo is about as steady as the original's (it varies ${fixed(s)}% vs ${fixed(r)}%).`,
      differs: (s, r, higher) =>
        higher
          ? `Our tempo varies more than the original's (${fixed(s)}% vs ${fixed(r)}%).`
          : `Our tempo is steadier than the original's (${fixed(s)}% vs ${fixed(r)}%): the original pushes and holds back the pulse more.`,
      missing: notMeasured('how steady the tempo is (it needs about 16 beats)')
    }),
    row({
      feature: 'noteRate',
      label: 'Notes per second',
      group: 'rhythm',
      sim: sim.notes.length ? a.noteRate : null,
      ref: ref.notes.length ? b.noteRate : null,
      tolerance: (r) => T.noteRateRelative * r,
      unit: 'notes/s',
      same: (s, r) => `Note density matches (${fixed(s)} vs ${fixed(r)} notes per second).`,
      differs: (s, r, higher) => `Ours plays ${higher ? 'more' : 'fewer'} notes per second than the original (${fixed(s)} vs ${fixed(r)}): check the tempo, ornaments and re-bowed notes.`,
      missing: notMeasured('notes')
    }),
    row({
      feature: 'ioiRatio',
      label: 'Rhythm (long ÷ short note)',
      group: 'rhythm',
      sim: a.ioiRatio ?? null,
      ref: b.ioiRatio ?? null,
      tolerance: (r) => T.ioiRatioRelative * r,
      unit: '',
      within: (s, r) => Math.abs(s - r) <= T.ioiRatioRelative * r && peaksAgree,
      same: (s, r) => (even(s) && even(r) ? 'Both play an even rhythm.' : `The rhythm pattern matches (long notes ${fixed(s, 2)}× the short ones vs ${fixed(r, 2)}×).`),
      differs: (s, r) =>
        Math.abs(s - r) <= T.ioiRatioRelative * r
          ? `The rhythm differs, though both have long notes ${fixed(s, 2)}× the short ones: successive notes relate as ${ratioList(simPeaks)} in ours but ${ratioList(refPeaks)} in the original (a 1:1:2 gallop has both 1 and 2, a 2:1 amble only 2).`
          : even(r)
            ? `Ours has an uneven long–short rhythm (${fixed(s, 2)}:1) where the original is even.`
            : even(s)
              ? `The original has a long–short rhythm (${fixed(r, 2)}:1, like a gallop or amble) where ours is even.`
              : `Our long notes are ${fixed(s, 2)}× the short ones, the original's ${fixed(r, 2)}×.`,
      missing: notMeasured('the rhythm (it needs at least 8 notes)')
    }),
    row({
      feature: 'vibratoRate',
      label: 'Vibrato speed',
      group: 'expression',
      sim: a.vibratoRateHz,
      ref: b.vibratoRateHz,
      tolerance: () => T.vibratoRateHz,
      unit: 'Hz',
      same: (s, r) => `Vibrato speed matches (${fixed(s)} Hz vs ${fixed(r)} Hz).`,
      differs: (s, r, higher) => `Our vibrato is ${higher ? 'faster' : 'slower'} than the original's (${fixed(s)} Hz vs ${fixed(r)} Hz).`,
      missing: (s, r) =>
        s === null && r === null
          ? 'Neither recording has regular vibrato on its long notes.'
          : s === null
            ? `The original has regular vibrato (${fixed(r!)} Hz) but ours has none on its long notes.`
            : `Ours has vibrato (${fixed(s)} Hz) but the original has no regular vibrato.`
    }),
    row({
      feature: 'vibratoExtent',
      label: 'Vibrato width',
      group: 'expression',
      sim: a.vibratoExtentCents,
      ref: b.vibratoExtentCents,
      tolerance: () => T.vibratoExtentCents,
      unit: '¢',
      same: (s, r) => `Vibrato width matches (±${Math.round(s)} vs ±${Math.round(r)} cents).`,
      differs: (s, r, higher) => `Our vibrato is ${higher ? 'wider' : 'narrower'} than the original's (±${Math.round(s)} vs ±${Math.round(r)} cents).`,
      missing: notMeasured('vibrato (it needs notes of at least a quarter second)')
    }),
    row({
      feature: 'vibratoShare',
      label: 'Long notes with vibrato',
      group: 'expression',
      sim: a.vibratoShare == null ? null : a.vibratoShare * 100,
      ref: b.vibratoShare == null ? null : b.vibratoShare * 100,
      tolerance: () => T.vibratoShare * 100,
      unit: '%',
      same: (s, r) => `About as many long notes have vibrato as in the original (${Math.round(s)}% vs ${Math.round(r)}%).`,
      differs: (s, r, higher) =>
        higher
          ? `More of our long notes have vibrato than the original's (${Math.round(s)}% vs ${Math.round(r)}%): the original leaves more notes plain.`
          : `Fewer of our long notes have vibrato than the original's (${Math.round(s)}% vs ${Math.round(r)}%).`,
      missing: notMeasured('how many notes have vibrato (it needs notes of at least 0.4 s)')
    }),
    row({
      feature: 'vibratoOnset',
      label: 'Vibrato onset (into the note)',
      group: 'expression',
      sim: a.vibratoOnsetMs ?? null,
      ref: b.vibratoOnsetMs ?? null,
      tolerance: (r) => T.vibratoOnsetRelative * r,
      unit: 'ms',
      same: (s, r) => `Vibrato sets in at the same point (${Math.round(s)} ms vs ${Math.round(r)} ms into the note).`,
      differs: (s, r, higher) => `Our vibrato sets in ${higher ? 'later' : 'earlier'} than the original's (${Math.round(s)} ms vs ${Math.round(r)} ms into the note).`,
      missing: onlyOne((inOriginal) => `Could not time the vibrato's onset in ${inOriginal ? 'our version' : 'the original'}.`)
    }),
    row({
      feature: 'amPhase',
      label: 'Vibrato loudness phase (pitch–level correlation)',
      group: 'expression',
      sim: phase(a.amPhase),
      ref: phase(b.amPhase),
      tolerance: () => 1,
      unit: '',
      within: (s, r) => Math.sign(s) === Math.sign(r),
      same: (s) => `In the vibrato, loudness moves ${s > 0 ? 'with the pitch (in phase)' : 'against the pitch (anti-phase)'}, as in the original.`,
      differs: (s) =>
        `In our vibrato loudness moves ${s > 0 ? 'with' : 'against'} the pitch, in the original ${s > 0 ? 'against' : 'with'} it: a lyrical vibrato usually swells in phase, a trill-like shake against it.`,
      missing: onlyOne((inOriginal) => `The vibrato's loudness is too even in ${inOriginal ? 'our version' : 'the original'} to tell its phase.`)
    }),
    row({
      feature: 'trillRate',
      label: 'Trill speed',
      group: 'expression',
      sim: a.trillRateHz ?? null,
      ref: b.trillRateHz ?? null,
      tolerance: () => T.trillRateHz,
      unit: 'Hz',
      same: (s, r) => `Trills alternate as fast as the original's (${fixed(s)} vs ${fixed(r)} cycles per second).`,
      differs: (s, r, higher) => `Our trills are ${higher ? 'faster' : 'slower'} than the original's (${fixed(s)} vs ${fixed(r)} cycles per second).`,
      missing: (s, r) => {
        // A trill under three cycles is counted but too short to time.
        const untimed = (f: AudioFeatures['summary']) => (f.trillCount ?? 0) > 0
        if (s === null && r === null) return untimed(a) || untimed(b) ? 'The trills are too short to time (under 3 cycles).' : ''
        if (s === null) return untimed(a) ? `Our trills are too short to time (under 3 cycles); the original's alternate at ${fixed(r!)} Hz.` : `The original has trills (${fixed(r!)} Hz) but ours has none.`
        return untimed(b) ? `The original's trills are too short to time (under 3 cycles); ours alternate at ${fixed(s)} Hz.` : `Ours has trills (${fixed(s)} Hz) but the original has none.`
      }
    }),
    row({
      feature: 'trillExtent',
      label: 'Trill interval',
      group: 'expression',
      sim: a.trillExtentCents ?? null,
      ref: b.trillExtentCents ?? null,
      tolerance: () => T.trillExtentCents,
      unit: '¢',
      same: (s, r) => `Trills span the same interval as the original's (${fixed(s / 100)} vs ${fixed(r / 100)} semitones).`,
      differs: (s, r, higher) => `Our trills span a ${higher ? 'wider' : 'narrower'} interval than the original's (${fixed(s / 100)} vs ${fixed(r / 100)} semitones).`,
      missing: () => ''
    }),
    row({
      feature: 'glideShare',
      label: 'Sliding between notes',
      group: 'expression',
      sim: sim.notes.length ? a.glideShare * 100 : null,
      ref: ref.notes.length ? b.glideShare * 100 : null,
      tolerance: () => T.glideShare * 100,
      unit: '%',
      same: (s, r) => `Ours slides about as much as the original (${Math.round(s)}% vs ${Math.round(r)}% of the time).`,
      differs: (s, r, higher) => `Ours slides between notes ${higher ? 'more' : 'less'} than the original (${Math.round(s)}% vs ${Math.round(r)}% of the time).`,
      missing: notMeasured('slides')
    }),
    row({
      feature: 'slideLength',
      label: 'Slide length',
      group: 'expression',
      sim: a.slideMs ?? null,
      ref: b.slideMs ?? null,
      tolerance: (r) => T.slideRelative * r,
      unit: 'ms',
      same: (s, r) => `Slides between notes take as long as the original's (median ${Math.round(s)} ms vs ${Math.round(r)} ms).`,
      differs: (s, r, higher) => `Our slides between notes are ${higher ? 'slower' : 'quicker'} than the original's (median ${Math.round(s)} ms vs ${Math.round(r)} ms).`,
      missing: onlyOne((inOriginal) => (inOriginal ? 'The original slides between notes but ours does not.' : 'Ours slides between notes but the original does not.'))
    }),
    row({
      feature: 'slideInterval',
      label: 'Slide interval',
      group: 'expression',
      sim: a.slideSemitones ?? null,
      ref: b.slideSemitones ?? null,
      tolerance: (r) => T.slideRelative * r,
      unit: 'st',
      same: (s, r) => `Slides cover the same intervals as the original's (median ${fixed(s)} vs ${fixed(r)} semitones).`,
      differs: (s, r, higher) => `Our slides cover ${higher ? 'larger' : 'smaller'} intervals than the original's (median ${fixed(s)} vs ${fixed(r)} semitones).`,
      missing: () => ''
    }),
    row({
      feature: 'attack',
      label: 'Note attack (10–90 % rise)',
      group: 'expression',
      sim: a.attackMs,
      ref: b.attackMs,
      tolerance: (r) => T.attackRelative * r,
      unit: 'ms',
      same: (s, r) => `Notes start the same way (attack ${Math.round(s)} ms vs ${Math.round(r)} ms).`,
      differs: (s, r, higher) => `Our notes start ${higher ? 'more slowly and softly' : 'more abruptly'} than the original's (attack ${Math.round(s)} ms vs ${Math.round(r)} ms).`,
      missing: notMeasured('note attacks (they need separately bowed notes)')
    }),
    row({
      feature: 'h2h1',
      label: '2nd harmonic vs fundamental',
      group: 'timbre',
      sim: balance(a, 1),
      ref: balance(b, 1),
      tolerance: () => T.harmonicBalanceDb,
      unit: 'dB',
      same: () => 'The balance of the fundamental and the 2nd harmonic matches.',
      differs: (s, r, higher) =>
        higher
          ? `Ours has a stronger 2nd harmonic relative to the fundamental (${signedDb(s)} vs ${signedDb(r)}): the low body of the tone is weaker than in the original.`
          : `Ours has a weaker 2nd harmonic relative to the fundamental (${signedDb(s)} vs ${signedDb(r)}): ours sounds rounder and more hollow than the original.`,
      missing: notMeasured('the harmonics')
    }),
    row({
      feature: 'h3h1',
      label: '3rd harmonic vs fundamental',
      group: 'timbre',
      sim: balance(a, 2),
      ref: balance(b, 2),
      tolerance: () => T.harmonicBalanceDb,
      unit: 'dB',
      same: () => 'The balance of the fundamental and the 3rd harmonic matches.',
      differs: (s, r, higher) =>
        higher
          ? `Ours has a stronger 3rd harmonic relative to the fundamental (${signedDb(s)} vs ${signedDb(r)}): ours sounds more nasal than the original.`
          : `Ours has a weaker 3rd harmonic relative to the fundamental (${signedDb(s)} vs ${signedDb(r)}): ours sounds softer and less nasal than the original.`,
      missing: notMeasured('the harmonics')
    }),
    row({
      feature: 'centroid',
      label: 'Brightness (spectral centroid)',
      group: 'timbre',
      sim: a.centroidHz,
      ref: b.centroidHz,
      tolerance: (r) => T.centroidRelative * r,
      unit: 'Hz',
      within: (s, r) => brightnessWithin(s, r) || brightnessScaled(s, r),
      inform: register,
      same: (s, r) =>
        brightnessScaled(s, r)
          ? `Brightness matches for the key (centroid ${hz(s)}, between the original's ${hz(r)} and the ${hz(r * keyRatio)} it would have scaled into our key).`
          : `Brightness matches (centroid ${hz(s)} vs ${hz(r)}).`,
      differs: (s, r, higher) =>
        register
          ? `Centroid ${hz(s)} vs ${hz(r)}, not scored: the original is ${semitones(transposition!)} ${transposition! > 0 ? 'lower' : 'higher'}, and brightness changes with the register.`
          : `Ours is ${higher ? 'brighter' : 'darker'} than the original (centroid ${hz(s)} vs ${hz(r)}).`,
      missing: notMeasured('the brightness')
    }),
    row({
      feature: 'ltas',
      label: 'Long-term spectrum (mean band difference)',
      group: 'timbre',
      sim: spectrum?.mean ?? null,
      ref: spectrum ? 0 : null,
      tolerance: () => T.ltasMeanDb,
      unit: 'dB',
      within: () => spectrum!.mean <= T.ltasMeanDb && spectrum!.max <= T.ltasMaxDb,
      same: () =>
        `The long-term spectrum matches (${otherKey ? `half-octave-smoothed, as the keys or octaves differ${spectrumMoved ? ', with the original moved into our key' : ''}` : '1/6-octave bands'}: ${fixed(spectrum!.mean)} dB apart on average, at most ${fixed(spectrum!.max)} dB).`,
      differs: () =>
        `Our long-term spectrum differs from the original's by ${fixed(spectrum!.mean)} dB per band on average${otherKey ? ` (half-octave-smoothed, as the keys or octaves differ${spectrumMoved ? ', with the original moved into our key' : ''})` : ''}, most around ${hz(spectrum!.worstHz)}, where ours is ${fixed(Math.abs(spectrum!.worstDb))} dB ${spectrum!.worstDb > 0 ? 'stronger' : 'weaker'}.`,
      missing: () =>
        oneSided('the long-term spectrum (it needs notes of at least 0.4 s)', bandsIn(a.ltasDb) > 0, bandsIn(b.ltasDb) > 0, 'Neither recording has notes of at least 0.4 s to measure the long-term spectrum.') ||
        'The two long-term spectra share too few bands to compare.'
    }),
    row({
      feature: 'hnr',
      label: 'Tone vs bow noise (HNR)',
      group: 'timbre',
      sim: a.hnrDb,
      ref: b.hnrDb,
      tolerance: () => T.hnrDb,
      unit: 'dB',
      inform: register,
      same: (s, r) => `The amount of horsehair and bow noise matches (HNR ${fixed(s)} dB vs ${fixed(r)} dB).`,
      differs: (s, r, higher) =>
        register
          ? `HNR ${fixed(s)} dB vs ${fixed(r)} dB, not scored: the original is ${semitones(transposition!)} ${transposition! > 0 ? 'lower' : 'higher'}, and low notes with vibrato read a lower HNR.`
          : higher
            ? `Ours is cleaner than the original: less horsehair rasp and bow noise (HNR ${fixed(s)} dB vs ${fixed(r)} dB; room echo and recording noise in the original count as noise too${s >= ANALYSIS.hnrCeilingDb - 0.05 ? `, and ${ANALYSIS.hnrCeilingDb} dB is the most this measures` : ''}).`
            : `Ours is noisier than the original: more horsehair rasp and bow noise (HNR ${fixed(s)} dB vs ${fixed(r)} dB).`,
      missing: notMeasured('the bow noise')
    }),
    row({
      feature: 'dynamicRange',
      label: 'Loudness range (loud − soft)',
      group: 'dynamics',
      sim: a.dynamicRangeDb ?? null,
      ref: b.dynamicRangeDb ?? null,
      tolerance: () => T.dynamicRangeDb,
      unit: 'dB',
      same: (s, r) => `The loudness range matches (${fixed(s)} dB vs ${fixed(r)} dB between loud and soft).`,
      differs: (s, r, higher) =>
        higher
          ? `Ours varies more in loudness than the original (${fixed(s)} dB vs ${fixed(r)} dB between loud and soft).`
          : `Ours is more even in loudness than the original (${fixed(s)} dB vs ${fixed(r)} dB between loud and soft): the original swells and fades more.`,
      missing: notMeasured('the loudness range')
    })
  ]
  const kept = REFERENCE_ROWS[referenceKind]
  const shown = kept ? rows.filter((r) => kept.includes(r.feature)) : rows
  const comparable = shown.filter((r) => r.ok !== null)
  return {
    rows: shown,
    score: comparable.length ? comparable.filter((r) => r.ok).length / comparable.length : null,
    referenceKind,
    transposition,
    melody
  }
}
