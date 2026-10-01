import { useId, useRef } from 'react'

interface KnobProps {
  label: string
  value: number
  min: number
  max: number
  onChange(value: number): void
  defaultValue?: number
  step?: number
  /** Map the value logarithmically (frequencies). */
  log?: boolean
  format?(value: number): string
  size?: number
  color?: string
}

const SWEEP = 270
const START = -135

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function arc(cx: number, cy: number, r: number, from: number, to: number) {
  const a = polar(cx, cy, r, from)
  const b = polar(cx, cy, r, to)
  const large = to - from > 180 ? 1 : 0
  return `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`
}

/** Rotary control: drag vertically, scroll, or use arrow keys; double-click resets. */
export function Knob({ label, value, min, max, onChange, defaultValue, step, log = false, format, size = 52, color = 'var(--color-bilag)' }: KnobProps) {
  const drag = useRef<{ y: number; norm: number } | null>(null)
  const gradientId = `knob${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  const toNorm = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min))
  const fromNorm = (n: number) => {
    const c = Math.min(1, Math.max(0, n))
    const v = log ? min * (max / min) ** c : min + c * (max - min)
    return step ? Math.round(v / step) * step : v
  }
  const norm = Math.min(1, Math.max(0, toNorm(value)))
  const angle = START + norm * SWEEP
  const c = size / 2
  const r = size / 2 - 4
  const tip = polar(c, c, r - 7, angle)

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <svg
        width={size}
        height={size}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Number(value.toFixed(2))}
        aria-valuetext={format ? format(value) : undefined}
        className="cursor-ns-resize touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y: e.clientY, norm }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const delta = (drag.current.y - e.clientY) / (e.shiftKey ? 600 : 160)
          onChange(fromNorm(drag.current.norm + delta))
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
        onWheel={(e) => onChange(fromNorm(norm - Math.sign(e.deltaY) * 0.03))}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowUp' || e.key === 'ArrowRight' ? 0.04 : e.key === 'ArrowDown' || e.key === 'ArrowLeft' ? -0.04 : 0
          if (d) {
            e.preventDefault()
            e.stopPropagation()
            onChange(fromNorm(norm + d))
          }
        }}
      >
        <defs>
          <radialGradient id={gradientId} cx="40%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#3a332c" />
            <stop offset="100%" stopColor="#141110" />
          </radialGradient>
        </defs>
        <path d={arc(c, c, r, START, START + SWEEP)} stroke="#2b2520" strokeWidth={4} fill="none" strokeLinecap="round" />
        {norm > 0.001 && (
          <path
            d={arc(c, c, r, START, angle)}
            stroke={color}
            strokeWidth={4}
            fill="none"
            strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 4px ${color})` }}
          />
        )}
        <circle cx={c} cy={c} r={r - 5} fill={`url(#${gradientId})`} stroke="#000" strokeOpacity={0.6} />
        <line x1={c} y1={c} x2={tip.x} y2={tip.y} stroke="#f2ece4" strokeWidth={2.5} strokeLinecap="round" />
      </svg>
      <div className="text-[11px] font-medium text-muted leading-none">{label}</div>
      {format && <div className="text-[10px] text-faint tabular-nums leading-none">{format(value)}</div>}
    </div>
  )
}
