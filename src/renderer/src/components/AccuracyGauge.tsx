/** Arc gauge for the song tester's accuracy score (0–1), as in the song tester mockup. */
export function AccuracyGauge({ value, label, sub }: { value: number | null; label: string; sub?: string }) {
  const r = 38
  const c = 2 * Math.PI * r
  const sweep = 0.75
  const pct = value === null ? 0 : Math.max(0, Math.min(1, value))
  const color = value === null ? 'var(--color-faint)' : pct >= 0.95 ? 'var(--color-bilag)' : pct >= 0.75 ? '#f6c945' : 'var(--color-rec)'
  return (
    <div className="flex items-center gap-3">
      <div className="whitespace-nowrap text-right">
        <div className="text-sm text-muted">{label}</div>
        {sub && <div className="text-[11px] text-faint">{sub}</div>}
      </div>
      <svg width="96" height="96" viewBox="0 0 96 96" role="img" aria-label={`${label}: ${value === null ? 'not tested' : `${Math.round(pct * 100)}%`}`}>
        <g transform="rotate(135 48 48)">
          <circle cx="48" cy="48" r={r} fill="none" stroke="#2a2520" strokeWidth="7" strokeDasharray={`${c * sweep} ${c}`} strokeLinecap="round" />
          <circle
            cx="48"
            cy="48"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeDasharray={`${c * sweep * pct} ${c}`}
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: 'stroke-dasharray 400ms' }}
          />
        </g>
        <text x="48" y="56" textAnchor="middle" fontSize="24" fontWeight="600" fill="var(--color-text)">
          {value === null ? '—' : `${Math.round(pct * 100)}%`}
        </text>
      </svg>
    </div>
  )
}
