import { useRef, useState } from 'react'
import { BOW_INFO, SCREEN_DIRECTION, type BowDirection } from '@renderer/core/techniques'
import type { BowInput } from '@renderer/audio/bowed-voice'
import { useAnimationFrame } from '@renderer/hooks'

interface BowPadProps {
  /** Bow contact point: −1 sul tasto … +1 sul ponticello. */
  position: number
  /** Direction/activity from the performer, used to animate keyboard (auto) bowing. */
  autoBowing: boolean
  direction: BowDirection
  onBow(input: BowInput, direction: BowDirection): void
  onBowEnd(): void
}

const LEFT: BowDirection = SCREEN_DIRECTION.tatakh < 0 ? 'tatakh' : 'tülekhe'
const RIGHT: BowDirection = LEFT === 'tatakh' ? 'tülekhe' : 'tatakh'
const STROKE_COLOR: Record<BowDirection, string> = { tatakh: 'var(--color-arga)', tülekhe: 'var(--color-bilag)' }
/** Pad widths per second that count as a full-speed stroke. */
const FULL_SPEED = 1.5
/** Half the bow's usable travel, as a fraction of the pad width. */
const TRAVEL = 0.4
/** Seconds a keyboard-driven stroke takes to cross the full bow (matches the performer's run-out). */
const AUTO_STROKE_SECONDS = 3.2

/**
 * Bow gesture pad (spec §3 rows 8–9): drag horizontally to bow. Drag speed is bow velocity, drag
 * direction picks Tatakh / Tülekhe, height is hair pressure. The bow has finite length — at the
 * end of its travel it stops sounding until you reverse.
 */
export function BowPad({ position, autoBowing, direction, onBow, onBowEnd }: BowPadProps) {
  const [dragging, setDragging] = useState(false)
  const padRef = useRef<HTMLDivElement>(null)
  const bowRef = useRef<SVGGElement>(null)
  const speedRef = useRef<HTMLDivElement>(null)
  const pressureRef = useRef<HTMLDivElement>(null)
  const s = useRef({
    active: false,
    samples: [] as { x: number; t: number }[],
    offset: 0,
    lastX: 0,
    pressure: 0.55,
    direction: RIGHT as BowDirection,
    speed: 0,
    atEnd: false
  })

  const emit = () => {
    const st = s.current
    onBow({ speed: st.atEnd ? 0 : st.speed, pressure: st.pressure, position }, st.direction)
  }

  const localPoint = (e: React.PointerEvent) => {
    const rect = padRef.current!.getBoundingClientRect()
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height }
  }

  useAnimationFrame((dt) => {
    const st = s.current
    const now = performance.now()
    if (st.active) {
      // Speed decays when the pointer stops moving: a still bow makes no sound.
      const recent = st.samples.filter((p) => now - p.t < 70)
      st.samples = recent
      if (recent.length < 2) {
        st.speed *= 0.8
        if (st.speed > 0.005) emit()
      }
    } else if (autoBowing) {
      // Keyboard bowing: slide the bow steadily in the current direction, bouncing at the ends.
      const step = (SCREEN_DIRECTION[direction] * (dt / 1000) * 2 * TRAVEL) / AUTO_STROKE_SECONDS
      st.offset = Math.max(-TRAVEL, Math.min(TRAVEL, st.offset + step))
    }
    if (bowRef.current) bowRef.current.style.transform = `translateX(${st.offset * 100}%)`
    if (speedRef.current) speedRef.current.style.transform = `scaleX(${st.active ? st.speed : autoBowing ? 0.6 : 0})`
    if (pressureRef.current) pressureRef.current.style.transform = `scaleX(${st.pressure})`
  })

  return (
    <div className="flex items-center gap-6">
      <DirectionLabel dir={LEFT} side="left" active={(dragging || autoBowing) && direction === LEFT} />
      <div className="relative flex-1">
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 px-4 py-1 rounded-t-lg bg-panel-2 border border-b-0 border-line text-[11px] tracking-[0.18em] text-muted">
          BOW GESTURE PAD
        </div>
        <div
          ref={padRef}
          className="relative h-32 rounded-2xl overflow-hidden border border-line-2 cursor-grab active:cursor-grabbing touch-none"
          style={{
            background:
              `linear-gradient(90deg, color-mix(in srgb, ${STROKE_COLOR[LEFT]} 34%, #0e1116) 0%, #11141a 46%, #17130e 54%, color-mix(in srgb, ${STROKE_COLOR[RIGHT]} 34%, #1a130a) 100%)`,
            boxShadow: 'inset 0 0 40px rgb(0 0 0 / 0.6)'
          }}
          role="application"
          aria-label="Bow gesture pad: drag left or right to bow, up and down for pressure"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            const p = localPoint(e)
            const st = s.current
            st.active = true
            st.samples = [{ x: p.x, t: performance.now() }]
            st.lastX = p.x
            st.pressure = Math.min(1, Math.max(0.1, 0.15 + p.y * 0.85))
            st.speed = 0
            st.atEnd = false
            setDragging(true)
            emit()
          }}
          onPointerMove={(e) => {
            const st = s.current
            if (!st.active) return
            const p = localPoint(e)
            const now = performance.now()
            const dx = p.x - st.lastX
            st.lastX = p.x
            st.pressure = Math.min(1, Math.max(0.1, 0.15 + p.y * 0.85))
            if (Math.abs(dx) > 0.0005) {
              const dir = dx < 0 ? LEFT : RIGHT
              if (dir !== st.direction) st.atEnd = false
              st.direction = dir
              const next = st.offset + dx
              st.atEnd = next > TRAVEL || next < -TRAVEL
              st.offset = Math.max(-TRAVEL, Math.min(TRAVEL, next))
            }
            st.samples.push({ x: p.x, t: now })
            const first = st.samples.find((q) => now - q.t < 70) ?? st.samples[0]!
            const dt = Math.max(0.008, (now - first.t) / 1000)
            st.speed = Math.min(1, Math.abs(p.x - first.x) / dt / FULL_SPEED)
            emit()
          }}
          onPointerUp={() => {
            s.current.active = false
            s.current.speed = 0
            setDragging(false)
            onBowEnd()
          }}
          onPointerCancel={() => {
            s.current.active = false
            setDragging(false)
            onBowEnd()
          }}
        >
          <div className="absolute inset-y-4 left-1/2 border-l border-dashed border-white/25" />
          <svg viewBox="0 0 1000 160" className="absolute inset-0 w-full h-full pointer-events-none" preserveAspectRatio="none">
            <g ref={bowRef} style={{ transformBox: 'view-box' }}>
              {/* Curved stick, horsehair ribbon and frog of the khuuryn num */}
              <path d="M170 96 Q500 60 880 92" fill="none" stroke="#6b3a1c" strokeWidth={9} strokeLinecap="round" />
              <path d="M170 96 Q500 60 880 92" fill="none" stroke="#a8683a" strokeWidth={3} strokeLinecap="round" />
              <line x1={176} y1={110} x2={860} y2={110} stroke="#f3ead8" strokeWidth={4} opacity={0.9} />
              <rect x={800} y={88} width={70} height={30} rx={6} fill="#22150c" stroke="#caa77a" strokeWidth={1.5} />
              <circle cx={850} cy={103} r={4} fill="#caa77a" />
              <rect x={755} y={94} width={40} height={10} rx={2} fill="#d9d4cc" />
            </g>
          </svg>
          <div className="absolute bottom-2 left-4 right-4 flex gap-6 text-[10px] text-white/60 pointer-events-none">
            <Meter label="Speed" barRef={speedRef} color="#fff" />
            <Meter label="Pressure" barRef={pressureRef} color="var(--color-bilag)" />
          </div>
        </div>
        <div className="mt-2 text-center text-xs text-muted">Drag to bow · speed = loudness · height = hair pressure</div>
      </div>
      <DirectionLabel dir={RIGHT} side="right" active={(dragging || autoBowing) && direction === RIGHT} />
    </div>
  )
}

function Meter({ label, barRef, color }: { label: string; barRef: React.RefObject<HTMLDivElement | null>; color: string }) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <span className="w-14">{label}</span>
      <div className="h-1 flex-1 rounded bg-white/10 overflow-hidden">
        <div ref={barRef} className="h-full origin-left" style={{ background: color, transform: 'scaleX(0)' }} />
      </div>
    </div>
  )
}

function DirectionLabel({ dir, side, active }: { dir: BowDirection; side: 'left' | 'right'; active: boolean }) {
  const color = STROKE_COLOR[dir]
  const info = BOW_INFO[dir]
  return (
    <div className={`w-36 flex flex-col items-center gap-2 transition-opacity ${active ? 'opacity-100' : 'opacity-60'}`}>
      <svg width="90" height="22" viewBox="0 0 90 22" style={{ transform: side === 'left' ? 'scaleX(-1)' : undefined }} aria-hidden>
        <path d="M4 11 H76 M64 3 L80 11 L64 19" fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="text-xl font-bold tracking-wide uppercase" style={{ color }}>
        {info.name}
      </div>
      <div className="text-xs" style={{ color }}>
        ({info.english.toLowerCase()} to the {side})
      </div>
    </div>
  )
}
