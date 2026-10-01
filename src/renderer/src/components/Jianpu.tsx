import { FINGER_LABEL } from '@renderer/core/instrument'
import type { JianpuMeasure, JianpuSymbol, SongNote } from '@renderer/core/notation'
import { SCREEN_DIRECTION, TECHNIQUES } from '@renderer/core/techniques'

const TECH_MARK: Partial<Record<SongNote['technique'], string>> = {
  tsatsal_harmonic: '◇',
  artificial_harmonic: '◈',
  pizzicato: 'pizz',
  col_legno: 'c.l.',
  body_tap: 'tap',
  string_slap: 'slap',
  horse_whinny: 'insee',
  gulsuulakh_glissando: 'gliss',
  shuvtrakh_glissando: 'whip',
  shigshikh_glissando: 'shake',
  tsokhilgo: 'ts.',
  erkhii_darakh: 'thumb',
  tremolo: 'trem',
  vibrato: '∿',
  double_stop: 'drone',
  sul_ponticello: 'pont',
  sul_tasto: 'tasto',
  gallop: '>'
}

function Dots({ count, position }: { count: number; position: 'above' | 'below' }) {
  if (count <= 0) return <span className="block h-[7px]" />
  return (
    <span className={`flex h-[7px] justify-center gap-[2px] ${position === 'above' ? 'items-end' : 'items-start'}`}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="h-[4px] w-[4px] rounded-full bg-current" />
      ))}
    </span>
  )
}

function Symbol({ s }: { s: JianpuSymbol }) {
  return (
    <span className="inline-flex items-center">
      <span className="flex flex-col items-center">
        <Dots count={s.octave} position="above" />
        <span className="relative flex items-baseline text-[22px] font-medium leading-none">
          {s.accidental && <span className="mr-[1px] text-[12px] leading-none">{s.accidental === 'b' ? '♭' : '♯'}</span>}
          {s.degree}
          {s.dotted && <span className="ml-[2px] text-[16px]">·</span>}
        </span>
        <span className="mt-[3px] flex w-full flex-col gap-[2px]">
          {Array.from({ length: s.underlines }, (_, i) => (
            <span key={i} className="block h-[1.5px] w-full bg-current" />
          ))}
        </span>
        <Dots count={-s.octave} position="below" />
      </span>
      {Array.from({ length: s.dashes }, (_, i) => (
        <span key={i} className="ml-3 text-[20px] leading-none">
          –
        </span>
      ))}
    </span>
  )
}

/** Numbered notation with a string / finger / bow lane under every note. */
export function JianpuView({ measures, current, failed }: { measures: JianpuMeasure[]; current: number | null; failed: Set<number> }) {
  return (
    <div className="flex flex-wrap items-stretch gap-y-4">
      {measures.map((m) => (
        <div key={m.index} className="flex items-stretch border-r border-line-2 px-3 first:border-l">
          <div className="flex items-end gap-2.5">
            {m.items.map((item, i) => {
              if (item.kind === 'rest') {
                return (
                  <div key={`r${i}`} className="flex flex-col items-center text-faint">
                    <Symbol s={item.symbol} />
                    <span className="mt-1 h-9" />
                  </div>
                )
              }
              const n = item.note
              const isCurrent = current === n.index
              const bad = failed.has(n.index)
              const bowArrow = n.bow ? (SCREEN_DIRECTION[n.bow] < 0 ? '←' : '→') : ''
              return (
                <div
                  key={n.index}
                  title={`#${n.index + 1} · ${TECHNIQUES[n.technique].name}${bad ? ' · failed' : ''}`}
                  className={`flex flex-col items-center rounded-md px-1.5 pt-1 transition-colors ${isCurrent ? 'bg-arga/80 text-white' : bad ? 'text-rec' : 'text-text'}`}
                >
                  <Symbol s={item.symbol} />
                  <span className="mt-1 flex h-9 flex-col items-center text-[10px] leading-tight">
                    <span className={n.string === 'male' ? 'text-arga' : n.string === 'female' ? 'text-bilag' : 'text-faint'} style={isCurrent ? { color: '#fff' } : undefined}>
                      {n.string === 'male' ? 'Эр' : n.string === 'female' ? 'Эм' : '·'}
                      {n.finger ? ` ${FINGER_LABEL[n.finger]}` : ''}
                    </span>
                    <span className="font-bold">
                      {bowArrow}
                      {n.slur ? '⌒' : ''}
                    </span>
                    <span className="text-faint" style={isCurrent ? { color: '#dbeafe' } : undefined}>
                      {TECH_MARK[n.technique] ?? ''}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
