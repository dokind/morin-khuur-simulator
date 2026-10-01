import { useEffect, useRef, useState } from 'react'
import { Accidental, Articulation, BarlineType, Beam, Dot, Formatter, Modifier, SVGContext, Stave, StaveNote, StaveTie, Tuplet, Voice } from 'vexflow/bravura'
import { staffKey, staffMeasures, staffRange, type Song, type StaffItem, type StaffMeasure } from '@renderer/core/notation'
import type { TechniqueId } from '@renderer/core/techniques'
import { memoLast } from '@renderer/memo'

/** VexFlow draws a 10-unit staff space; on screen it is 8.5 px. */
const SCALE = 0.85
const SPACE = 10
/**
 * Staff spaces a system keeps above its top line and below its bottom line: VexFlow's usual four
 * above and a little more below to part the systems. It grows for what reaches further (see
 * systemExtent): the notes as drawn (heads, stems, flags, accidentals, harmonic circles), HEAD_INK
 * spaces past the outermost noteheads for ties, TIP_INK past stem tips for beams, and TUPLET_INK
 * either side of a tuplet's bracket line for its number, above or below the notes.
 */
const ROOM_ABOVE = 4
const ROOM_BELOW = 4.4
const HEAD_INK = 2
const TIP_INK = 1
const TUPLET_INK = 2
/** Units kept free at the right edge for the final barline. */
const EDGE = 2
/** Measure widths: VexFlow's tightest layout loosened, plus right padding, never below a minimum. */
const LOOSEN = 1.4
const MEASURE_PAD = 18
const MIN_MEASURE = 64
/** A window drag resizes the host every frame; the staff is redrawn once the width has settled. */
const RESIZE_SETTLE_MS = 150
const HARMONICS: ReadonlySet<TechniqueId> = new Set(['tsatsal_harmonic', 'artificial_harmonic'])

// Everything is drawn in currentColor (VexFlow's defaults sit on the <svg> and on a few elements),
// so a note's colour is its group's CSS `color`. The SVG is drawn at the host's width; until a
// resize has settled (or when one measure is wider than the page) it scales down to fit.
const STYLE = `
.mk-staff svg { fill: currentColor; stroke: currentColor; max-width: 100%; height: auto }
.mk-staff svg [fill]:not([fill='none']) { fill: currentColor }
.mk-staff svg [stroke]:not([stroke='none']) { stroke: currentColor }
.mk-staff .vf-stave, .mk-staff .vf-stavebarline { color: var(--color-muted) }
.mk-staff [data-note] { transition: color 120ms }
.mk-staff [data-note].is-failed { color: var(--color-rec) }
.mk-staff [data-note].is-current { color: #fff }
.mk-staff .mk-staff-cursor { fill: color-mix(in srgb, var(--color-arga) 80%, transparent); stroke: none }
`

const measuresFor = memoLast(staffMeasures)

/** Harmonic circles go on the first piece of each harmonic note (of each part of it the staff shows). */
const harmonicsFor = memoLast((song: Song): Set<StaffItem> => {
  const techniques = new Map(song.notes.map((n) => [n.index, n.technique]))
  const harmonics = new Set<StaffItem>()
  let tied = false
  for (const item of measuresFor(song).flatMap((m) => m.items)) {
    if (item.kind === 'note' && !tied && HARMONICS.has(techniques.get(item.noteIndex)!)) harmonics.add(item)
    tied = item.kind === 'note' && item.tie
  }
  return harmonics
})

/** Each measure's natural width. It does not depend on the page width, so redraws after a resize reuse it. */
const naturalWidthsFor = memoLast((song: Song): number[] => measuresFor(song).map((m) => naturalWidth(buildMeasure(m, song, harmonicsFor(song)))))

/** VexFlow measures glyphs with its bundled Bravura font, so the first layout waits until it has loaded. */
const fontsReady: Promise<unknown> = Promise.all([document.fonts.load('30px Bravura'), document.fonts.load('12px Academico')]).catch(() => undefined)

interface Built {
  notes: StaveNote[]
  voice: Voice
  beams: Beam[]
  tuplets: Tuplet[]
}

function staveNote(item: StaffItem, harmonic: boolean): StaveNote {
  if (item.kind === 'rest') {
    // Measure rests are the conventional whole rest, whatever the meter.
    if (item.measureRest) return new StaveNote({ keys: ['d/5'], duration: 'wr', alignCenter: true })
    const rest = new StaveNote({ keys: [item.duration === 'w' ? 'd/5' : 'b/4'], duration: `${item.duration}r`, dots: item.dots })
    for (let i = 0; i < item.dots; i++) Dot.buildAndAttach([rest], { all: true })
    return rest
  }
  const note = new StaveNote({ keys: [item.percussion ? `${item.key}/x` : item.key], duration: item.duration, dots: item.dots, autoStem: true })
  if (item.accidental) note.addModifier(new Accidental(item.accidental), 0)
  for (let i = 0; i < item.dots; i++) Dot.buildAndAttach([note], { all: true })
  if (harmonic) note.addModifier(new Articulation('ah').setPosition(Modifier.Position.ABOVE), 0)
  return note
}

/** VexFlow objects for one measure. Built twice (to measure, then to draw) because formatting binds notes to a stave. */
function buildMeasure(m: StaffMeasure, song: Song, harmonics: Set<StaffItem>): Built {
  const notes = m.items.map((item) => staveNote(item, harmonics.has(item)))
  // 3:2 brackets over runs of triplet values that add up to whole quarter notes.
  const tuplets: Tuplet[] = []
  let run: number[] = []
  let length = 0
  const close = () => {
    // Beamed triplets show just the number; brackets for rests and unbeamed values.
    const bracketed = run.some((i) => m.items[i]!.kind === 'rest' || ['w', 'h', 'q'].includes(m.items[i]!.duration))
    if (run.length) tuplets.push(new Tuplet(run.map((i) => notes[i]!), { numNotes: 3, notesOccupied: 2, ratioed: false, bracketed }))
    run = []
    length = 0
  }
  m.items.forEach((item, i) => {
    if (!item.triplet) return close()
    run.push(i)
    length += item.beats
    if (Math.abs(length - Math.round(length)) < 1e-9) close()
  })
  close()
  const { beats, unit } = song.timeSignature
  const voice = new Voice({ numBeats: beats, beatValue: unit })
  if (m.items[0]?.kind === 'rest' && m.items[0].measureRest) voice.setMode(Voice.Mode.SOFT)
  voice.addTickables(notes)
  const beams = Beam.generateBeams(notes, { groups: Beam.getDefaultBeamGroups(`${beats}/${unit}`) })
  return { notes, voice, beams, tuplets }
}

/** Narrowest comfortable width of a measure's notes. */
function naturalWidth(b: Built): number {
  const stave = new Stave(0, 0, 1000)
  b.notes.forEach((n) => n.setStave(stave))
  return Math.max(MIN_MEASURE, new Formatter().joinVoices([b.voice]).preCalculateMinTotalWidth([b.voice]) * LOOSEN + MEASURE_PAD)
}

/**
 * Top and bottom (VexFlow y) of what a drawn system covers, so it can be placed without being
 * clipped or running into its neighbours. `range` is the system's notehead range (staffRange).
 */
function systemExtent(stave: Stave, built: Built[], range: { highest: number; lowest: number } | null): { top: number; bottom: number } {
  const topLine = stave.getYForLine(0)
  const bottomLine = stave.getYForLine(4)
  let top = topLine - ROOM_ABOVE * SPACE
  let bottom = bottomLine + ROOM_BELOW * SPACE
  if (range) {
    top = Math.min(top, topLine - (range.highest - 5 + HEAD_INK) * SPACE)
    bottom = Math.max(bottom, bottomLine + (1 - range.lowest + HEAD_INK) * SPACE)
  }
  for (const b of built) {
    for (const note of b.notes) {
      // What VexFlow drew for the note (stems as long as the beams made them), a quarter space clear.
      // Rests count too: inside a tuplet VexFlow moves a rest onto its neighbour's line, so a short
      // rest beside a low note hangs well below the staff.
      const box = note.getBoundingBox()
      top = Math.min(top, box.getY() - SPACE / 4)
      bottom = Math.max(bottom, box.getY() + box.getH() + SPACE / 4)
      if (note.isRest() || !note.hasStem()) continue
      const tip = note.getStemExtents().topY
      top = Math.min(top, tip - TIP_INK * SPACE)
      bottom = Math.max(bottom, tip + TIP_INK * SPACE)
    }
    // A tuplet sits above the notes, or below them when its first stem points down (as the beams
    // decide), with its number centred on the bracket line; the bound on the other side is always
    // inside the staff, so both are applied.
    for (const tuplet of b.tuplets) {
      const y = tuplet.getYPosition()
      top = Math.min(top, y - TUPLET_INK * SPACE)
      bottom = Math.max(bottom, y + TUPLET_INK * SPACE)
    }
  }
  return { top, bottom }
}

/** Where notes start in a measure with these modifiers. */
function headerWidth(key: string | null, time: string | null): number {
  const stave = new Stave(0, 0, 1000)
  if (key) stave.addClef('treble').addKeySignature(key)
  if (time) stave.addTimeSignature(time)
  return stave.getNoteStartX()
}

/** Lays the staff out for `width` px and draws it into `paper`, replacing what was there. */
function drawStaff(paper: HTMLDivElement, song: Song, width: number): void {
  paper.replaceChildren()
  const measures = measuresFor(song)
  const harmonics = harmonicsFor(song)
  const naturals = naturalWidthsFor(song)
  const key = staffKey(song).name
  const time = `${song.timeSignature.beats}/${song.timeSignature.unit}`

  // Greedy line breaking; every line opens with clef and key, the first also with the meter.
  const avail = width / SCALE - EDGE
  const first = headerWidth(key, time)
  const lineStart = headerWidth(key, null)
  const plain = headerWidth(null, null)
  const lines: { index: number; header: number; natural: number }[][] = []
  let row: (typeof lines)[number] = []
  let used = 0
  naturals.forEach((natural, index) => {
    if (row.length > 0 && used + plain + natural > avail) {
      lines.push(row)
      row = []
      used = 0
    }
    const header = row.length > 0 ? plain : index === 0 ? first : lineStart
    row.push({ index, header, natural })
    used += header + natural
  })
  lines.push(row)

  const widths = lines.map((slots, li) => {
    const natural = slots.reduce((sum, s) => sum + s.natural, 0)
    const extra = Math.max(0, avail - slots.reduce((sum, s) => sum + s.header + s.natural, 0))
    // A short last line is loosened a little instead of being stretched across the page.
    const fill = li === lines.length - 1 && extra > avail * 0.3 ? Math.min(extra, natural * 0.4) : extra
    return slots.map((s) => s.header + s.natural + (fill * s.natural) / natural)
  })
  const drawnWidth = widths.reduce((max, w) => Math.max(max, w.reduce((a, b) => a + b, 0)), avail)

  const ctx = new SVGContext(paper)
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  cursor.setAttribute('class', 'mk-staff-cursor')
  cursor.setAttribute('rx', '6')
  cursor.setAttribute('visibility', 'hidden')
  ctx.svg.prepend(cursor)

  // Each system is drawn at the top of the page in its own group, measured, and then moved down to
  // just below the one before: as tall as its ledger notes, beams and tuplets need.
  const placed: { item: StaffItem; note: StaveNote }[] = []
  const withCursor = new Set<number>()
  const ends = { firstIndexes: [0], lastIndexes: [0] }
  let height = 0
  lines.forEach((slots, li) => {
    const group = ctx.openGroup('system')
    const firstPlaced = placed.length
    const cursors: { group: SVGElement; left: number; right: number }[] = []
    let x = 0
    const drawn = slots.map((slot, k) => {
      const m = measures[slot.index]!
      const stave = new Stave(x, 0, widths[li]![k]!)
      x += widths[li]![k]!
      if (k === 0) stave.addClef('treble').addKeySignature(key)
      if (slot.index === 0) stave.addTimeSignature(time)
      if (slot.index === measures.length - 1) stave.setEndBarType(BarlineType.END)
      stave.setDefaultLedgerLineStyle({ strokeStyle: 'currentColor', lineWidth: 1.4 })
      stave.setContext(ctx).draw()

      const b = buildMeasure(m, song, harmonics)
      new Formatter().joinVoices([b.voice]).formatToStave([b.voice], stave, { stave })
      b.voice.draw(ctx, stave)
      b.beams.forEach((beam) => beam.setContext(ctx).draw())
      b.tuplets.forEach((tuplet) => tuplet.setContext(ctx).draw())

      m.items.forEach((item, i) => {
        const note = b.notes[i]!
        placed.push({ item, note })
        if (item.kind !== 'note') return
        // The note's own <g id="vf-…">, found by id rather than by scanning the growing SVG.
        const noteGroup = note.getSVGElement()
        if (!noteGroup) return
        noteGroup.dataset.note = String(item.noteIndex)
        if (withCursor.has(item.noteIndex)) return
        // The cursor box sits on a note's first piece.
        withCursor.add(item.noteIndex)
        cursors.push({ group: noteGroup, left: note.getNoteHeadBeginX() - 6, right: note.getNoteHeadEndX() + 6 })
      })
      return { stave, built: b }
    })

    // Ties inside the system; one that crosses to the next line is drawn in two halves, one per system.
    const carried = placed[firstPlaced - 1]
    if (carried?.item.kind === 'note' && carried.item.tie && placed[firstPlaced]) {
      new StaveTie({ lastNote: placed[firstPlaced]!.note, ...ends }).setContext(ctx).draw()
    }
    for (let k = firstPlaced; k < placed.length; k++) {
      const p = placed[k]!
      if (p.item.kind !== 'note' || !p.item.tie) continue
      const next = placed[k + 1]
      const tie = next ? new StaveTie({ firstNote: p.note, lastNote: next.note, ...ends }) : new StaveTie({ firstNote: p.note, ...ends })
      tie.setContext(ctx).draw()
    }
    ctx.closeGroup()

    const stave = drawn[0]!.stave
    const range = staffRange(slots.map((s) => measures[s.index]!))
    const extent = systemExtent(stave, drawn.map((d) => d.built), range)
    const dy = height - extent.top
    group.setAttribute('transform', `translate(0 ${dy})`)
    height += extent.bottom - extent.top
    // The cursor covers three spaces beyond the staff and the outermost noteheads, in page units;
    // staffRange lines count up from the bottom line (1) to the top line (5).
    const lineY = (line: number) => stave.getYForLine(0) + dy + (5 - line) * SPACE
    const top = lineY(Math.max(8, (range?.highest ?? 0) + 1))
    const bottom = lineY(Math.min(-2, (range?.lowest ?? 0) - 1))
    for (const c of cursors) c.group.dataset.cursor = `${c.left} ${top} ${c.right - c.left} ${bottom - top}`
  })

  // Exactly the host's width, unless one measure alone is wider than the page.
  ctx.resize(drawnWidth > avail + 1e-6 ? Math.ceil((drawnWidth + EDGE) * SCALE) : width, Math.ceil(height * SCALE))
  ctx.scale(SCALE, SCALE)
}

/** Toggles note classes and moves the cursor; no re-layout. */
function highlight(paper: HTMLDivElement, current: number | null, failed: Set<number>): void {
  for (const el of paper.querySelectorAll<SVGGElement>('[data-note]')) {
    const index = Number(el.dataset.note)
    el.classList.toggle('is-current', index === current)
    el.classList.toggle('is-failed', index !== current && failed.has(index))
  }
  const cursor = paper.querySelector('.mk-staff-cursor')
  const target = current === null ? null : paper.querySelector<SVGGElement>(`[data-cursor][data-note="${current}"]`)
  if (!cursor) return
  if (!target) {
    cursor.setAttribute('visibility', 'hidden')
    return
  }
  const [x, y, w, h] = target.dataset.cursor!.split(' ')
  cursor.setAttribute('x', x!)
  cursor.setAttribute('y', y!)
  cursor.setAttribute('width', w!)
  cursor.setAttribute('height', h!)
  cursor.removeAttribute('visibility')
}

/**
 * Treble-staff notation of a song, drawn with VexFlow and wrapped to the container width.
 * `current` and `failed` are `SongNote.index` values; changing them only restyles the drawn notes.
 */
export function StaffView({ song, current, failed }: { song: Song; current: number | null; failed: Set<number> }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const paperRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [drawCount, setDrawCount] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let timer = 0
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry!.contentRect.width)
      // The first width draws at once; later changes wait until the width stops changing.
      setWidth((drawn) => drawn || next)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setWidth(next), RESIZE_SETTLE_MS)
    })
    observer.observe(host)
    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const paper = paperRef.current
    if (!paper || width <= 0) return
    let cancelled = false
    void fontsReady.then(() => {
      if (cancelled) return
      drawStaff(paper, song, width)
      setDrawCount((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [song, width])

  useEffect(() => {
    const paper = paperRef.current
    if (paper) highlight(paper, current, failed)
  }, [drawCount, current, failed])

  // Keep the current note in view while a song plays.
  useEffect(() => {
    if (current === null) return
    paperRef.current?.querySelector(`[data-cursor][data-note="${current}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [drawCount, current])

  return (
    <div ref={hostRef} className="mk-staff w-full min-w-0 text-text">
      <style href="mk-staff-view" precedence="default">
        {STYLE}
      </style>
      <div ref={paperRef} />
    </div>
  )
}
