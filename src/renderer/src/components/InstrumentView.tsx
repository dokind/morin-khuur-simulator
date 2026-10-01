import { useEffect, useId, useRef } from 'react'
import {
  FINGER_LABEL,
  harmonicNodes,
  openMidi,
  stopFraction,
  STRING_IDS,
  type Finger,
  type HarmonicNode,
  type StringId,
  type Tuning
} from '@renderer/core/instrument'
import { midiToName, prettyNoteName } from '@renderer/core/pitch'
import { SCREEN_DIRECTION, type BowDirection } from '@renderer/core/techniques'
import { useAnimationFrame } from '@renderer/hooks'

// Geometry (viewBox units). The vibrating length runs from the nut to the bridge.
const VIEWBOX = '28 54 1330 396'
const NUT_X = 392
const BRIDGE_X = 1122
const TAIL_X = 1160
const BOX_LEFT = 935
const VIB_LEN = BRIDGE_X - NUT_X
const STRING_Y: Record<StringId, number> = { male: 234, female: 266 }
const COLOR: Record<StringId, string> = { male: 'var(--color-arga)', female: 'var(--color-bilag)' }
const OPEN_PAD_X = NUT_X + 16
const BOW_X = 1030

const stopX = (stop: number) => (stop <= 0 ? OPEN_PAD_X : NUT_X + VIB_LEN * stopFraction(stop))
const xToStop = (x: number) => -12 * Math.log2(1 - Math.min(0.7, Math.max(0, (x - NUT_X) / VIB_LEN)))
const nodeX = (n: HarmonicNode) => NUT_X + VIB_LEN * n.nodeFraction

export interface FingerMarker {
  string: StringId
  stop: number
  finger: Finger | null
  /** Harmonic partial; the marker sits on that node instead of a stop. */
  partial?: number | null
  emphasis: 'now' | 'next'
}

export interface InstrumentActivity {
  stops: Record<StringId, number>
  bowed: Record<StringId, boolean>
  activeString: StringId
  direction: BowDirection
  harmonics?: Record<StringId, HarmonicNode | null>
}

interface Props {
  tuning: Tuning
  /** Stop pads to draw per string (0 = open). */
  pads?: Record<StringId, number[]>
  showHarmonics?: boolean
  activity?: InstrumentActivity
  markers?: FingerMarker[]
  levels?: () => Record<StringId, number>
  onPress?(string: StringId, stop: number, harmonic: boolean): void
  onSlide?(string: StringId, stop: number): void
  onRelease?(): void
  className?: string
}

function HorseHead({ fill }: { fill: string }) {
  return (
    <g>
      <path
        d="M262 226 C250 205 246 180 236 160 C231 148 228 138 226 128 L234 94 L214 118 C205 124 196 128 186 131 C160 138 132 150 108 166
           C90 178 72 190 62 203 C56 211 56 221 62 227 C68 233 76 236 86 236 C92 240 98 246 108 247 C124 249 136 244 150 248
           C170 254 186 268 204 276 C222 282 242 280 262 274 Z"
        fill={fill}
        stroke="#2a170a"
        strokeWidth={2}
      />
      {/* mane */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <path
          key={i}
          d={`M${256 - i * 5} ${222 - i * 16} q 14 -6 10 -18`}
          fill="none"
          stroke="#3b220f"
          strokeWidth={2.5}
          strokeLinecap="round"
          opacity={0.8}
        />
      ))}
      <circle cx={172} cy={226} r={24} fill="none" stroke="#3b220f" strokeWidth={2} opacity={0.55} />
      <path d="M96 196 C120 192 146 196 170 204" fill="none" stroke="#3b220f" strokeWidth={2} opacity={0.6} />
      <ellipse cx={148} cy={168} rx={7.5} ry={4.5} transform="rotate(-22 148 168)" fill="#1c0f06" />
      <circle cx={146} cy={166.5} r={1.4} fill="#f0d9b5" />
      <ellipse cx={70} cy={213} rx={4.5} ry={3.2} fill="#1c0f06" />
      <path d="M64 229 Q76 233 88 234" fill="none" stroke="#1c0f06" strokeWidth={2} strokeLinecap="round" />
    </g>
  )
}

function Peg({ x, up, fill }: { x: number; up: boolean; fill: string }) {
  const d = up
    ? `M${x - 7} 226 L${x - 7} 132 C${x - 14} 118 ${x - 13} 88 ${x - 8} 76 C${x - 4} 64 ${x + 4} 64 ${x + 8} 76 C${x + 13} 88 ${x + 14} 118 ${x + 7} 132 L${x + 7} 226 Z`
    : `M${x - 7} 274 L${x - 7} 368 C${x - 14} 382 ${x - 13} 412 ${x - 8} 424 C${x - 4} 436 ${x + 4} 436 ${x + 8} 424 C${x + 13} 412 ${x + 14} 382 ${x + 7} 368 L${x + 7} 274 Z`
  return <path d={d} fill={fill} stroke="#2a170a" strokeWidth={1.5} />
}

function CloudCurl({ transform }: { transform: string }) {
  return (
    <path
      transform={transform}
      d="M0 0 C8 -14 28 -12 28 2 C28 12 16 14 13 7 C11 2 17 -1 19 3 M0 0 C-2 14 10 26 22 22"
      fill="none"
      stroke="#3b220f"
      strokeWidth={3}
      strokeLinecap="round"
      opacity={0.75}
    />
  )
}

/** Horizontal Morin Khuur with side-stop pads, tsatsal nodes and vibrating strings. */
export function InstrumentView({ tuning, pads, showHarmonics = false, activity, markers = [], levels, onPress, onSlide, onRelease, className = '' }: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const svgRef = useRef<SVGSVGElement>(null)
  const lensRefs = useRef<Record<StringId, SVGPathElement | null>>({ male: null, female: null })
  const activityRef = useRef(activity)
  const drag = useRef<{ string: StringId; startX: number; sliding: boolean } | null>(null)

  useEffect(() => {
    activityRef.current = activity
  })

  useAnimationFrame(() => {
    const lv = levels?.()
    for (const s of STRING_IDS) {
      const el = lensRefs.current[s]
      if (!el) continue
      const level = lv?.[s] ?? 0
      if (level < 0.01) {
        el.setAttribute('d', '')
        continue
      }
      const stop = activityRef.current?.stops[s] ?? 0
      const x0 = stop <= 0 ? NUT_X : NUT_X + VIB_LEN * stopFraction(stop)
      const y = STRING_Y[s]
      const amp = 1.5 + level * 7
      const xm = (x0 + BRIDGE_X) / 2
      el.setAttribute('d', `M${x0} ${y} Q${xm} ${y - amp * 2} ${BRIDGE_X} ${y} Q${xm} ${y + amp * 2} ${x0} ${y} Z`)
    }
  })

  const toLocal = (e: React.PointerEvent) => {
    const svg = svgRef.current!
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM()!.inverse())
    return { x: pt.x, y: pt.y }
  }

  const handleDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const target = (e.target as Element).closest('[data-string]')
    if (!target || !onPress) return
    const string = target.getAttribute('data-string') as StringId
    const { x } = toLocal(e)
    const stopAttr = target.getAttribute('data-stop')
    const harmonic = target.hasAttribute('data-harmonic')
    const stop = stopAttr !== null ? Number(stopAttr) : Math.round(xToStop(x))
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { string, startX: x, sliding: false }
    onPress(string, stop, harmonic)
  }

  const handleMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d || !onSlide) return
    const { x } = toLocal(e)
    if (!d.sliding && Math.abs(x - d.startX) < 6) return
    d.sliding = true
    // No fingerboard: the finger can glide to any point along the hovering string.
    onSlide(d.string, xToStop(x))
  }

  const handleUp = () => {
    if (!drag.current) return
    drag.current = null
    onRelease?.()
  }

  const wood = `wood-${uid}`
  const box = `box-${uid}`
  const neck = `neck-${uid}`
  const glow = `glow-${uid}`

  return (
    <svg
      ref={svgRef}
      viewBox={VIEWBOX}
      className={`w-full touch-none ${className}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
      role="group"
      aria-label="Morin Khuur neck and strings"
    >
      <defs>
        <linearGradient id={wood} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c98f55" />
          <stop offset="55%" stopColor="#9a6331" />
          <stop offset="100%" stopColor="#6b411d" />
        </linearGradient>
        <radialGradient id={box} cx="45%" cy="45%" r="70%">
          <stop offset="0%" stopColor="#d59a5c" />
          <stop offset="60%" stopColor="#a86c36" />
          <stop offset="100%" stopColor="#6e431e" />
        </radialGradient>
        <linearGradient id={neck} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4a2c15" />
          <stop offset="100%" stopColor="#23140a" />
        </linearGradient>
        <filter id={glow} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <ellipse cx={720} cy={450} rx={640} ry={16} fill="#000" opacity={0.45} />

      {/* Pegs (chikhi) and neck (khüzüü) — no fingerboard: the strings hover above it. */}
      <Peg x={300} up fill={`url(#${wood})`} />
      <Peg x={344} up={false} fill={`url(#${wood})`} />
      <path d={`M${NUT_X - 6} 239 L${BOX_LEFT + 10} 236 L${BOX_LEFT + 10} 264 L${NUT_X - 6} 261 Z`} fill={`url(#${neck})`} />

      {/* Pegbox and carved horse head (matgar tolgoi). */}
      <rect x={250} y={226} width={NUT_X - 250} height={48} rx={10} fill={`url(#${wood})`} stroke="#2a170a" strokeWidth={1.5} />
      <rect x={270} y={236} width={NUT_X - 290} height={28} rx={6} fill="#2a170a" opacity={0.75} />
      <HorseHead fill={`url(#${wood})`} />

      {/* Soundbox (gashaa): side shading, face, border, f-holes and cloud ornaments. */}
      <path d="M958 118 L1324 78 Q1344 76 1344 98 L1344 418 Q1344 440 1324 438 L958 398 Q943 396 943 380 L943 136 Q943 120 958 118 Z" fill="#3a220f" />
      <path
        d="M950 110 L1316 70 Q1336 68 1336 90 L1336 410 Q1336 432 1316 430 L950 390 Q935 388 935 372 L935 128 Q935 112 950 110 Z"
        fill={`url(#${box})`}
        stroke="#2a170a"
        strokeWidth={2}
      />
      <path
        d="M962 126 L1306 88 Q1320 87 1320 102 L1320 398 Q1320 413 1306 412 L962 374 Q951 373 951 362 L951 138 Q951 127 962 126 Z"
        fill="none"
        stroke="#4a2a12"
        strokeWidth={2}
        opacity={0.7}
      />
      {[false, true].map((flip) => (
        <g key={String(flip)} transform={flip ? 'translate(0 500) scale(1 -1)' : undefined}>
          <path d="M1022 128 C1040 110 1066 118 1058 140 C1050 162 1030 170 1040 188 C1048 202 1074 196 1082 182" fill="none" stroke="#1c0f06" strokeWidth={7} strokeLinecap="round" />
          <circle cx={1022} cy={128} r={5} fill="#1c0f06" />
          <circle cx={1082} cy={182} r={5} fill="#1c0f06" />
        </g>
      ))}
      <CloudCurl transform="translate(975 146)" />
      <CloudCurl transform="translate(975 354) scale(1 -1)" />
      <CloudCurl transform="translate(1290 116) scale(-1 1)" />
      <CloudCurl transform="translate(1290 384) scale(-1 -1)" />

      {/* Bridge (teew) and tailpiece (kharuul). */}
      <path d="M1150 240 Q1150 232 1160 232 L1290 242 Q1300 250 1290 258 L1160 268 Q1150 268 1150 260 Z" fill="#2a170a" />
      <path d={`M${BRIDGE_X - 10} 280 L${BRIDGE_X - 7} 222 Q${BRIDGE_X} 216 ${BRIDGE_X + 7} 222 L${BRIDGE_X + 10} 280 Z`} fill="#ecd2a6" stroke="#8a6a3e" />
      <rect x={NUT_X - 5} y={220} width={9} height={60} rx={3} fill="#ecd2a6" stroke="#8a6a3e" />

      {/* Bow hair contact point. */}
      {activity && (activity.bowed.male || activity.bowed.female) && (
        <g filter={`url(#${glow})`}>
          <rect
            x={BOW_X + SCREEN_DIRECTION[activity.direction] * 6}
            y={200}
            width={5}
            height={100}
            rx={2.5}
            fill={activity.direction === 'tatakh' ? 'var(--color-arga)' : 'var(--color-bilag)'}
            opacity={0.8}
          />
        </g>
      )}

      {/* Strings: shadow on the neck (they hover), vibration envelope, the string itself. */}
      {STRING_IDS.map((s) => {
        const y = STRING_Y[s]
        const startX = s === 'male' ? 300 : 344
        return (
          <g key={s}>
            <line x1={NUT_X} y1={y + 6} x2={BOX_LEFT} y2={y + 6} stroke="#000" strokeOpacity={0.35} strokeWidth={s === 'male' ? 3 : 2.2} />
            <path ref={(el) => void (lensRefs.current[s] = el)} fill={COLOR[s]} opacity={0.28} filter={`url(#${glow})`} />
            <line x1={startX} y1={y} x2={TAIL_X} y2={y} stroke="#efe6d2" strokeWidth={s === 'male' ? 3 : 2.2} />
            <rect data-string={s} x={NUT_X + 24} y={y - 14} width={BOX_LEFT - NUT_X - 24} height={28} fill="transparent" className={onPress ? 'cursor-pointer' : ''} />
          </g>
        )
      })}

      {pads && <StopPads tuning={tuning} pads={pads} activity={activity} glow={glow} />}
      {showHarmonics && <HarmonicBadges tuning={tuning} activity={activity} />}

      {markers.map((m, i) => {
        const x = m.partial ? NUT_X + VIB_LEN / m.partial : stopX(m.stop)
        const y = STRING_Y[m.string]
        const now = m.emphasis === 'now'
        const label = m.partial ? '◇' : m.finger ? FINGER_LABEL[m.finger] : '0'
        return (
          <g key={i} filter={now ? `url(#${glow})` : undefined} opacity={now ? 1 : 0.55}>
            <circle cx={x} cy={y} r={now ? 10 : 8} fill={now ? COLOR[m.string] : 'none'} stroke={COLOR[m.string]} strokeWidth={2.5} />
            <text x={x} y={m.string === 'male' ? y - 20 : y + 30} textAnchor="middle" fontSize={15} fontWeight={700} fill={COLOR[m.string]}>
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function StopPads({ tuning, pads, activity, glow }: { tuning: Tuning; pads: Record<StringId, number[]>; activity?: InstrumentActivity; glow: string }) {
  return (
    <g>
      {STRING_IDS.map((s) => {
        const y = STRING_Y[s]
        const dir = s === 'male' ? -1 : 1
        let prevLabelX = -Infinity
        let staggered = false
        return pads[s].map((stop) => {
          const x = stopX(stop)
          staggered = x - prevLabelX < 34 ? !staggered : false
          prevLabelX = x
          const labelY = y + dir * (staggered ? 64 : 40)
          const name = prettyNoteName(midiToName(openMidi(tuning, s) + stop))
          const on = activity !== undefined && activity.stops[s] === stop && !activity.harmonics?.[s] && (activity.bowed[s] || activity.activeString === s)
          return (
            <g key={`${s}-${stop}`} data-string={s} data-stop={stop} className="cursor-pointer" aria-label={`${name} on the ${s} string`}>
              <line x1={x} y1={y} x2={x} y2={labelY - dir * 10} stroke={COLOR[s]} strokeOpacity={0.25} strokeWidth={1} />
              <rect
                x={x - 6}
                y={y - 13}
                width={12}
                height={26}
                rx={6}
                fill={COLOR[s]}
                fillOpacity={on ? 1 : 0.35}
                stroke={COLOR[s]}
                strokeWidth={1.5}
                filter={on ? `url(#${glow})` : undefined}
              />
              <rect x={x - 19} y={labelY - 10} width={38} height={21} rx={5} fill="#15110d" stroke={COLOR[s]} strokeOpacity={on ? 1 : 0.55} />
              <text x={x} y={labelY + 5} textAnchor="middle" fontSize={12.5} fontWeight={600} fill={on ? '#fff' : COLOR[s]}>
                {name}
              </text>
            </g>
          )
        })
      })}
    </g>
  )
}

function HarmonicBadges({ tuning, activity }: { tuning: Tuning; activity?: InstrumentActivity }) {
  const nodes = harmonicNodes(5)
  return (
    <g>
      {STRING_IDS.map((s) =>
        nodes.map((n) => {
          // The 1/5 and 1/4 nodes sit close together, so odd partials use an outer row.
          const offset = n.partial % 2 === 1 ? 128 : 100
          const y = STRING_Y[s] + (s === 'male' ? -offset : offset)
          const x = nodeX(n)
          const sounding = prettyNoteName(midiToName(openMidi(tuning, s) + Math.round(n.soundingSemitones)))
          const on = activity?.harmonics?.[s]?.partial === n.partial
          return (
            <g key={`${s}-${n.partial}`} data-string={s} data-stop={n.positionSemitones} data-harmonic="" className="cursor-pointer">
              <title>{`Tsatsal: touch the 1/${n.partial} node — sounds ${sounding}`}</title>
              <line x1={x} y1={STRING_Y[s]} x2={x} y2={y} stroke="#e8e0d0" strokeOpacity={0.12} strokeDasharray="3 4" />
              <rect x={x - 25} y={y - 11} width={50} height={22} rx={11} fill={on ? '#e8f4ff' : '#15110d'} stroke="#cfe6ff" strokeOpacity={on ? 1 : 0.45} />
              <text x={x} y={y + 4.5} textAnchor="middle" fontSize={11} fontWeight={600} fill={on ? '#0e0c0a' : '#cfe6ff'}>
                ◇ {sounding}
              </text>
            </g>
          )
        })
      )}
    </g>
  )
}
