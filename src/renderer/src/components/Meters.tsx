import { useRef } from 'react'
import { engine } from '@renderer/audio/engine'
import { useAnimationFrame } from '@renderer/hooks'

const SEGMENTS = 24
const FLOOR_DB = -48

const segmentColor = (i: number) => (i >= SEGMENTS - 3 ? '#e5484d' : i >= SEGMENTS - 8 ? '#f6c945' : '#46c46a')

/** L/R LED ladder fed from the master meter (as in the playground mockup). */
export function StereoMeter({ className = '' }: { className?: string }) {
  const rows = useRef<(HTMLDivElement | null)[]>([])
  useAnimationFrame(() => {
    const levels = engine.levels()
    levels.forEach((db, ch) => {
      const row = rows.current[ch]
      if (!row) return
      const lit = Math.round(((Math.max(FLOOR_DB, db) - FLOOR_DB) / -FLOOR_DB) * SEGMENTS)
      const cells = row.children
      for (let i = 0; i < cells.length; i++) (cells[i] as HTMLElement).style.opacity = i < lit ? '1' : '0.13'
    })
  })
  return (
    <div className={`flex flex-col gap-1.5 ${className}`} aria-label="Stereo output level">
      {['L', 'R'].map((label, ch) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-3 text-[10px] font-semibold text-muted">{label}</span>
          <div ref={(el) => void (rows.current[ch] = el)} className="flex gap-[2px]">
            {Array.from({ length: SEGMENTS }, (_, i) => (
              <div key={i} className="h-2.5 w-[5px] rounded-[1px]" style={{ background: segmentColor(i), opacity: 0.13 }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Vertical twin VU bars for the Beat Maker master section. */
export function VuMeter({ height = 120 }: { height?: number }) {
  const bars = useRef<(HTMLDivElement | null)[]>([])
  useAnimationFrame(() => {
    engine.levels().forEach((db, ch) => {
      const bar = bars.current[ch]
      if (bar) bar.style.transform = `scaleY(${Math.max(0, (Math.max(FLOOR_DB, db) - FLOOR_DB) / -FLOOR_DB)})`
    })
  })
  return (
    <div className="flex gap-1.5" style={{ height }} aria-label="Master level">
      {[0, 1].map((ch) => (
        <div key={ch} className="relative w-2.5 overflow-hidden rounded-sm bg-[#12100e] border border-line">
          <div
            ref={(el) => void (bars.current[ch] = el)}
            className="absolute inset-0 origin-bottom"
            style={{ background: 'linear-gradient(0deg, #46c46a 0%, #46c46a 65%, #f6c945 82%, #e5484d 100%)', transform: 'scaleY(0)' }}
          />
        </div>
      ))}
    </div>
  )
}

/** Live oscilloscope of the master output. */
export function Oscilloscope({ color = 'var(--color-bilag)', height = 90 }: { color?: string; height?: number }) {
  const path = useRef<SVGPathElement>(null)
  const W = 400
  useAnimationFrame(() => {
    const data = engine.waveform()
    if (!path.current || !data) return
    let d = ''
    const step = data.length / W
    for (let x = 0; x < W; x++) {
      const v = data[Math.floor(x * step)] ?? 0
      d += `${x === 0 ? 'M' : 'L'}${x} ${height / 2 - v * height * 0.9}`
    }
    path.current.setAttribute('d', d)
  })
  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" style={{ height }} preserveAspectRatio="none" aria-hidden>
      <path ref={path} fill="none" stroke={color} strokeWidth={1.6} style={{ filter: `drop-shadow(0 0 5px ${color})` }} />
    </svg>
  )
}
