/** The 4×4 Beat Maker pad kit (design_references/morin_khuur_beatmaker_ui.jpg). Metadata only. */

export type PadId =
  | 'colLegno'
  | 'bodyTap'
  | 'pizzicato'
  | 'whinny'
  | 'maleOpen'
  | 'femaleOpen'
  | 'tsatsal'
  | 'tremolo'
  | 'sub808'
  | 'snare'
  | 'hihat'
  | 'clap'
  | 'kick'
  | 'cymbal'
  | 'shamanDrum'
  | 'bells'

export interface PadInfo {
  id: PadId
  label: string
  sub: string
  /** Pads sourced from the fiddle itself vs. the accompanying percussion kit. */
  source: 'morin' | 'drum'
  /** Alternating amber / teal columns, as in the mockup. */
  tone: 'amber' | 'teal'
  /** MPC-style computer-keyboard trigger. */
  key: string
}

const P = (id: PadId, label: string, sub: string, source: PadInfo['source'], tone: PadInfo['tone'], key: string): PadInfo => ({
  id,
  label,
  sub,
  source,
  tone,
  key
})

export const PADS: readonly PadInfo[] = [
  P('colLegno', 'Col Legno', 'Bow stick hit', 'morin', 'amber', '1'),
  P('bodyTap', 'Body Tap', 'Hoof sound', 'morin', 'teal', '2'),
  P('pizzicato', 'Pizzicato', 'Pluck', 'morin', 'amber', '3'),
  P('whinny', 'Horse Whinny', 'Insee', 'morin', 'teal', '4'),
  P('maleOpen', 'Male String', 'Open', 'morin', 'amber', 'q'),
  P('femaleOpen', 'Female String', 'Open', 'morin', 'teal', 'w'),
  P('tsatsal', 'Tsatsal', 'Harmonic', 'morin', 'amber', 'e'),
  P('tremolo', 'Tremolo', 'Flutter', 'morin', 'teal', 'r'),
  P('sub808', '808', 'Sub-bass', 'drum', 'amber', 'a'),
  P('snare', 'Snare', 'Traditional', 'drum', 'teal', 's'),
  P('hihat', 'Hi-Hat', 'Gallop', 'drum', 'amber', 'd'),
  P('clap', 'Clap', 'Wood', 'drum', 'teal', 'f'),
  P('kick', 'Kick', 'Deep', 'drum', 'amber', 'z'),
  P('cymbal', 'Cymbal', 'Metal', 'drum', 'teal', 'x'),
  P('shamanDrum', 'Shaman Drum', 'Khets', 'drum', 'amber', 'c'),
  P('bells', 'Bells', 'Percussion 2', 'drum', 'teal', 'v')
]

export const PAD_IDS: readonly PadId[] = PADS.map((p) => p.id)

export function padInfo(id: PadId): PadInfo {
  return PADS.find((p) => p.id === id)!
}

/**
 * MIDI export mapping. Fiddle pads become pitched notes on a melodic track (standard F–B♭
 * tuning); percussion pads use General MIDI drum numbers on channel 10.
 */
export const PAD_MIDI: Record<PadId, { track: 'morin' | 'drums'; note: number }> = {
  colLegno: { track: 'drums', note: 37 }, // side stick
  bodyTap: { track: 'drums', note: 76 }, // hi wood block
  pizzicato: { track: 'morin', note: 58 },
  whinny: { track: 'morin', note: 77 },
  maleOpen: { track: 'morin', note: 53 },
  femaleOpen: { track: 'morin', note: 58 },
  tsatsal: { track: 'morin', note: 70 },
  tremolo: { track: 'morin', note: 65 },
  sub808: { track: 'drums', note: 35 },
  snare: { track: 'drums', note: 38 },
  hihat: { track: 'drums', note: 42 },
  clap: { track: 'drums', note: 39 },
  kick: { track: 'drums', note: 36 },
  cymbal: { track: 'drums', note: 49 },
  shamanDrum: { track: 'drums', note: 41 },
  bells: { track: 'drums', note: 81 }
}
