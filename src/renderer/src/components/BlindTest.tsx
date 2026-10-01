import { Eye, Loader2, Play, Shuffle, Square, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { StyleId } from '@renderer/core/performance/types'
import {
  blindLines,
  blindSummary,
  createBlindTrial,
  styleName,
  type BlindAnswer,
  type BlindMode,
  type BlindSource,
  type BlindTrial
} from '@renderer/core/playlist'

/** An answer to one question: excerpt 1 or 2, or "can't tell". */
type Choice = 0 | 1 | 'none'

type Phase = 'idle' | 'preparing' | 'listening' | 'revealed'

const GAP_MS = 700
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Bumped by every new playback sequence and on unmount; a sequence stops when it changes. */
let sequence = 0

/** What an answered trial looks like after it is revealed. */
interface Revealed {
  trial: BlindTrial
  moreReal: Choice
  guessedOurs: Choice | null
}

/**
 * Blind listening (ABX-style) for one playlist entry: two excerpts in random order — our version
 * against the loaded original, or two playing styles of ours — and the listener says which sounds
 * more like a real morin khuur (and, against the original, which one is ours). Answers are kept
 * with the entry's feedback; what was which is shown only after answering.
 */
export function BlindTest({
  unavailable,
  styles,
  blindStyles,
  onBlindStyles,
  answers,
  melodySeconds,
  prepare,
  play,
  stop,
  onAnswer,
  onClear,
  disabled
}: {
  /** Why a mode cannot run now (null: it can). */
  unavailable: Record<BlindMode, string | null>
  /** Styles to choose from for style trials; empty hides style trials. */
  styles: readonly { id: StyleId; name: string }[]
  blindStyles: [StyleId, StyleId]
  onBlindStyles(styles: [StyleId, StyleId]): void
  answers: readonly BlindAnswer[]
  /** Seconds of melody both sources have, from their melody start. */
  melodySeconds(sources: readonly BlindSource[]): number
  /** Renders what the trial needs before anything plays (so no loading state gives a source away). */
  prepare(sources: readonly BlindSource[]): Promise<boolean>
  /** Plays one excerpt; resolves true when it played to the end. */
  play(source: BlindSource, excerpt: { at: number; seconds: number }): Promise<boolean>
  /** Stops a blind excerpt that is playing (and nothing else). */
  stop(): void
  onAnswer(answer: Pick<BlindAnswer, 'mode' | 'order' | 'excerpt' | 'moreReal' | 'guessedOurs'>): void
  onClear(): void
  disabled: boolean
}) {
  const [mode, setMode] = useState<BlindMode>(unavailable['ours-vs-original'] === null || unavailable['style-vs-style'] !== null || !styles.length ? 'ours-vs-original' : 'style-vs-style')
  const [trial, setTrial] = useState<BlindTrial | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [playing, setPlaying] = useState<0 | 1 | null>(null)
  const [moreReal, setMoreReal] = useState<Choice | null>(null)
  const [guessedOurs, setGuessedOurs] = useState<Choice | null>(null)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  // A trial of another piece (or a closed view) plays nothing more.
  useEffect(
    () => () => {
      sequence++
    },
    []
  )

  const reason = unavailable[mode]
  const summary = blindSummary(answers)
  const lines = blindLines(summary)

  const sourcesFor = (m: BlindMode): [BlindSource, BlindSource] => (m === 'ours-vs-original' ? ['original', 'ours'] : blindStyles)

  /** Plays excerpt `from`, then (when `both`) the other one after a short gap. */
  const playSequence = async (t: BlindTrial, from: 0 | 1, both: boolean) => {
    const id = ++sequence
    for (const i of both ? ([from, from === 0 ? 1 : 0] as const) : ([from] as const)) {
      setPlaying(i)
      const ended = await play(t.order[i], { at: t.at, seconds: t.seconds })
      if (sequence !== id) return
      setPlaying(null)
      if (!ended) return
      if (both && i === from) await wait(GAP_MS)
      if (sequence !== id) return
    }
  }

  const start = async () => {
    const sources = sourcesFor(mode)
    const t = createBlindTrial(mode, sources, melodySeconds(sources))
    const id = ++sequence
    setTrial(t)
    setMoreReal(null)
    setGuessedOurs(null)
    setRevealed(null)
    setPhase('preparing')
    const ok = await prepare(sources)
    if (sequence !== id) return
    if (!ok) {
      setTrial(null)
      setPhase('idle')
      return
    }
    setPhase('listening')
    await playSequence(t, 0, true)
  }

  const submit = () => {
    if (!trial || moreReal === null) return
    const source = (p: Choice | null) => (p === null || p === 'none' ? null : trial.order[p])
    onAnswer({ mode: trial.mode, order: trial.order, excerpt: { at: trial.at, seconds: trial.seconds }, moreReal: source(moreReal), guessedOurs: trial.mode === 'ours-vs-original' ? source(guessedOurs) : null })
    sequence++
    stop()
    setPlaying(null)
    setRevealed({ trial, moreReal, guessedOurs: trial.mode === 'ours-vs-original' ? guessedOurs : null })
    setPhase('revealed')
  }

  const stopPlaying = () => {
    sequence++
    stop()
    setPlaying(null)
  }

  const needsGuess = trial?.mode === 'ours-vs-original'
  const canSubmit = phase === 'listening' && moreReal !== null && (!needsGuess || guessedOurs !== null)
  const label = (s: BlindSource) => (s === 'original' ? 'the original recording' : s === 'ours' ? 'ours' : `ours in the ${styleName(s)} style`)

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="What to compare" className="flex gap-1.5">
          {(styles.length ? (['ours-vs-original', 'style-vs-style'] as const) : (['ours-vs-original'] as const)).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className="btn btn-sm"
              data-on={mode === m}
              onClick={() => setMode(m)}
              disabled={phase === 'preparing' || phase === 'listening'}
              title={unavailable[m] ?? undefined}
            >
              {m === 'ours-vs-original' ? 'Ours vs the original' : 'Style vs style'}
            </button>
          ))}
        </div>
        {mode === 'style-vs-style' && (
          <span className="flex items-center gap-1.5 text-muted">
            <StyleSelect label="First style" value={blindStyles[0]} styles={styles} onChange={(s) => onBlindStyles([s, blindStyles[1]])} disabled={phase === 'preparing' || phase === 'listening'} />
            vs
            <StyleSelect label="Second style" value={blindStyles[1]} styles={styles} onChange={(s) => onBlindStyles([blindStyles[0], s])} disabled={phase === 'preparing' || phase === 'listening'} />
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm ml-auto"
          onClick={() => void start()}
          disabled={reason !== null || disabled || phase === 'preparing' || (mode === 'style-vs-style' && blindStyles[0] === blindStyles[1])}
          title="Two excerpts of 8–10 s in random order"
        >
          {phase === 'preparing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
          {phase === 'idle' ? 'Start a blind trial' : 'New trial'}
        </button>
      </div>
      {reason !== null && <p className="text-faint">{reason}</p>}
      {mode === 'style-vs-style' && reason === null && blindStyles[0] === blindStyles[1] && <p className="text-faint">Choose two different styles.</p>}

      {trial && phase !== 'idle' && (
        <div className="rounded-lg border border-line-2 bg-panel-2/60 p-3">
          {phase === 'preparing' ? (
            <div className="flex items-center gap-2 text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing both excerpts…
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                {([0, 1] as const).map((i) => (
                  <button key={i} type="button" className="btn btn-sm" data-on={playing === i} onClick={() => void playSequence(trial, i, false)}>
                    <Play className="h-3.5 w-3.5" /> Excerpt {i + 1}
                  </button>
                ))}
                {playing !== null && (
                  <button type="button" className="btn btn-sm" onClick={stopPlaying} aria-label="Stop">
                    <Square className="h-3.5 w-3.5 fill-current" />
                  </button>
                )}
                <span className="ml-auto text-faint">{trial.seconds.toFixed(1)} s from the same point of the melody, at the same loudness</span>
              </div>
              {phase === 'listening' && (
                <div className="mt-3 flex flex-col gap-2">
                  <Question label="Which sounds more like a real morin khuur?" value={moreReal} onChange={setMoreReal} />
                  {needsGuess && <Question label="Which is ours?" value={guessedOurs} onChange={setGuessedOurs} />}
                  <div>
                    <button type="button" className="btn btn-sm" onClick={submit} disabled={!canSubmit}>
                      <Eye className="h-4 w-4" /> Answer and reveal
                    </button>
                  </div>
                </div>
              )}
              {phase === 'revealed' && revealed && (
                <div className="mt-3 flex flex-col gap-1 text-muted">
                  <p>
                    Excerpt 1 was {label(revealed.trial.order[0])}; excerpt 2 was {label(revealed.trial.order[1])}.
                  </p>
                  {revealed.guessedOurs !== null && (
                    <p className={revealed.guessedOurs === 'none' ? '' : revealed.trial.order[revealed.guessedOurs] === 'original' ? 'text-go' : 'text-[#f6c945]'}>
                      {revealed.guessedOurs === 'none'
                        ? 'You could not tell which was ours.'
                        : revealed.trial.order[revealed.guessedOurs] === 'original'
                          ? 'You took the original for ours: ours passed this trial.'
                          : 'You recognised ours.'}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <div className="flex items-start gap-2">
          <ul className="min-w-0 flex-1 list-disc pl-5 text-muted">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <button type="button" className="btn btn-sm" onClick={onClear} disabled={phase === 'preparing' || phase === 'listening'} title="Delete this piece’s blind-test answers">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
      {lines.length === 0 && phase === 'idle' && reason === null && (
        <Hint>Listen without knowing which is which, then answer. Several trials show whether ours can be told apart from a real player; the answers go into Export feedback.</Hint>
      )}
    </div>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-faint">{children}</p>
}

function Question({ label, value, onChange }: { label: string; value: Choice | null; onChange(p: Choice): void }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 min-w-56 text-text">{label}</span>
      {([0, 1, 'none'] as const).map((p) => (
        <button key={p} type="button" role="radio" aria-checked={value === p} className="btn btn-sm" data-on={value === p} onClick={() => onChange(p)}>
          {p === 'none' ? 'Can’t tell' : `Excerpt ${p + 1}`}
        </button>
      ))}
    </div>
  )
}

function StyleSelect({ label, value, styles, onChange, disabled }: { label: string; value: StyleId; styles: readonly { id: StyleId; name: string }[]; onChange(s: StyleId): void; disabled: boolean }) {
  return (
    <select aria-label={label} className="field h-8" value={value} onChange={(e) => onChange(e.target.value as StyleId)} disabled={disabled}>
      {styles.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  )
}
