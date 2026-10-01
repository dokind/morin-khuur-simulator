import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react'
import type { ComparisonRow } from '@renderer/core/analysis'
import { formatMeasure } from '@renderer/core/playlist'
import { AccuracyGauge } from './AccuracyGauge'

/**
 * Passing rows whose hint says more than the table does: a melody that mostly matches still names
 * the bars where it differs. The other passing hints only restate the numbers, so they stay hidden.
 */
const PASSING_DETAIL: Partial<Record<string, (r: ComparisonRow) => boolean>> = {
  melody: (r) => r.sim !== null && r.ref !== null && r.sim < r.ref
}

const tellsMore = (r: ComparisonRow) => r.ok === true && !!r.hint && !!PASSING_DETAIL[r.feature]?.(r)

/**
 * Our playback measured against an original recording: similarity score, one row per feature
 * (ours, original, difference, within tolerance?) and plain-language hints for what differs, for
 * what could not be measured in one of them, and for details of rows that pass.
 */
export function ComparisonReport({
  rows,
  score,
  caption,
  progress
}: {
  rows: readonly ComparisonRow[]
  score: number | null
  /** What was compared, and when. */
  caption?: string
  /** Shown instead of the table while a comparison runs. */
  progress?: { label: string; fraction: number } | null
}) {
  // Differences first, then what one recording lacks (e.g. vibrato in the original but not ours) or
  // is only reported (`informational`: the key, register-dependent timbre), then what passing rows
  // still point out.
  const hints = [...rows.filter((r) => r.ok === false && r.hint), ...rows.filter((r) => r.ok === null && r.hint), ...rows.filter(tellsMore)]
  const measured = rows.filter((r) => r.ok !== null)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <AccuracyGauge value={progress ? null : score} label="Similarity" sub={progress ? progress.label : measured.length ? `${measured.filter((r) => r.ok).length}/${measured.length} features close to the original` : 'nothing comparable yet'} />
        {caption && <p className="min-w-0 flex-1 text-xs text-faint">{caption}</p>}
      </div>
      {progress ? (
        <div className="flex items-center gap-3 text-sm text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3">
            <div className="h-full rounded-full bg-bilag transition-[width] duration-300" style={{ width: `${Math.round(progress.fraction * 100)}%` }} />
          </div>
          <span className="w-10 text-right tabular-nums">{Math.round(progress.fraction * 100)}%</span>
        </div>
      ) : (
        rows.length > 0 && (
          <>
            <table className="w-full text-left text-xs">
              <thead className="text-[11px] text-faint">
                <tr className="border-b border-line">
                  <th className="py-1.5 pr-2 font-medium">Feature</th>
                  <th className="px-2 py-1.5 text-right font-medium">Ours</th>
                  <th className="px-2 py-1.5 text-right font-medium">Original</th>
                  <th className="px-2 py-1.5 text-right font-medium">Difference</th>
                  <th className="py-1.5 pl-2 text-center font-medium" aria-label="Within tolerance" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.feature} className="border-b border-line/60 last:border-0" title={`Close enough within ±${formatMeasure(r.tolerance, r.unit)}`}>
                    <td className="py-1.5 pr-2">{r.label}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{formatMeasure(r.sim, r.unit)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted">{formatMeasure(r.ref, r.unit)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums ${r.ok === false ? 'text-rec' : 'text-muted'}`}>{formatMeasure(r.delta, r.unit, { signed: true })}</td>
                    <td className="py-1.5 pl-2">
                      {r.ok === null ? (
                        <span className="block text-center text-faint" title={r.informational ? 'Shown for information, not scored' : 'Could not be measured in one of the recordings'}>
                          —
                        </span>
                      ) : r.ok ? (
                        <CheckCircle2 className="mx-auto h-3.5 w-3.5 text-go" aria-label="close" />
                      ) : (
                        <XCircle className="mx-auto h-3.5 w-3.5 text-rec" aria-label="different" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hints.length > 0 && (
              <ul className="flex flex-col gap-1.5 text-xs">
                {hints.map((r) => (
                  <li key={r.feature} className={`flex gap-2 ${r.ok === false ? '' : 'text-muted'}`}>
                    {r.ok === null ? (
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                    ) : r.ok ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-go/70" aria-label="within tolerance" />
                    ) : (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#f6c945]" />
                    )}
                    <span>{r.hint}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}
    </div>
  )
}
