/**
 * The comparison playlist: well-known morin khuur pieces (and the project's own etudes) with links
 * to original performances, so our playback can be heard — and measured — next to the real thing.
 * Pure data and helpers; the view lives in views/Playlist.tsx, feedback in state/playlist.ts.
 */
import type { ComparisonRow, ReferenceKind } from './analysis'
import { STYLES } from './performance'
import type { StyleId } from './performance/types'
import { isTechniqueId } from './techniques'

export type PlaylistKind = 'instrumental' | 'long-song' | 'short-song' | 'modern' | 'etude'

/**
 * - `public-domain`: the melody is free to transcribe and bundle (recordings and arrangements are not)
 * - `copyrighted`: a protected work; the user imports a score they may use
 * - `unknown`: rights not established
 * - `original`: written for this project
 */
export type PlaylistRights = 'public-domain' | 'copyrighted' | 'unknown' | 'original'

/**
 * What an original recording is, which decides the comparison rows that make sense: timbre and
 * vibrato rows only for a morin khuur, melody and rhythm rows for a voice or piano, tempo and rhythm
 * for an ensemble. The analysis owns the type (its REFERENCE_ROWS filter the rows).
 */
export type { ReferenceKind } from './analysis'

export const REFERENCE_KINDS: readonly ReferenceKind[] = ['fiddle', 'voice', 'piano', 'ensemble']

export const REFERENCE_KIND_INFO: Record<ReferenceKind, { label: string; description: string }> = {
  fiddle: { label: 'Morin khuur', description: 'A morin khuur (or matouqin) recording: every row of the comparison is meaningful.' },
  voice: { label: 'Voice (sung)', description: 'A sung original: only the tempo, melody, note-density and sliding rows are meaningful, not timbre or vibrato.' },
  piano: { label: 'Piano', description: 'A piano original: only the tempo, melody and note-density rows are meaningful.' },
  ensemble: { label: 'Ensemble', description: 'Several instruments at once: only the tempo and rhythm rows are meaningful.' }
}

export interface PlaylistLink {
  label: string
  /** https only; opened in the external browser. */
  url: string
}

export interface PlaylistEntry {
  id: string
  /** Mongolian title in Cyrillic (the Latin or Chinese title while the Cyrillic one is unverified). */
  titleMn: string
  titleLatin: string
  kind: PlaylistKind
  /** 'Traditional' for folk pieces. */
  composer: string
  rights: PlaylistRights
  /** Bundled song id (a `songs/*.mkhuur.json` file name without the extension), or null when the user must import a score. */
  songId: string | null
  /** Original performances to listen to (protected recordings: listening links only). */
  originals: PlaylistLink[]
  /** Known recordings without a listening link (albums, LP tracks). */
  recordings?: string[]
  /** What the piece exercises: technique ids from core/techniques.ts, or short free-text labels. */
  techniques: string[]
  /** Playing style our version should use (core/performance). */
  style: StyleId
  /** What the listed originals are, as the default for a loaded recording. */
  referenceKind: ReferenceKind
  notes?: string
  /** Title keywords (any script) that auto-link an imported song to this entry. */
  match?: string[]
}

export const KIND_INFO: Record<PlaylistKind, { label: string; mongolian: string }> = {
  instrumental: { label: 'Instrumental', mongolian: 'Хөгжмийн зохиол' },
  'long-song': { label: 'Long song', mongolian: 'Уртын дуу' },
  'short-song': { label: 'Short song', mongolian: 'Богино дуу' },
  modern: { label: 'Modern', mongolian: 'Орчин үеийн' },
  etude: { label: 'Etude', mongolian: 'Дасгал' }
}

export const RIGHTS_INFO: Record<PlaylistRights, { label: string; description: string }> = {
  'public-domain': { label: 'Public domain', description: 'The melody is public domain; recordings and arrangements of it are not.' },
  copyrighted: { label: 'Copyrighted', description: 'A protected work: import a score you are allowed to use to compare.' },
  unknown: { label: 'Rights unclear', description: 'Rights not established: import a score you are allowed to use to compare.' },
  original: { label: 'Project original', description: 'Written for this simulator.' }
}

const youtube = (id: string) => `https://www.youtube.com/watch?v=${id}`

const ETUDE_COMPOSER = 'Morin Khuur Simulator contributors'

/**
 * Playlist order is play-all order. To add a piece: give it a unique id, both titles, `songId: null`
 * unless a verified score is bundled, and https links to performances in `originals`.
 * Further tatlaga titles known from the national heritage register (e.g. Хуурын магнай, Зээний аяз,
 * Жороо морины явдал) can be added as entries without originals.
 */
export const PLAYLIST: PlaylistEntry[] = [
  // Traditional instrumental pieces (tatlaga): public-domain melodies, protected recordings.
  {
    id: 'jonon-khar',
    titleMn: 'Жонон хар морины явдал',
    titleLatin: 'Jonon Khar Moriny Yavdal (Gait of Jonon Khar)',
    kind: 'instrumental',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [
      { label: 'A. Möngön (Udshiin khemnel STUDIO)', url: youtube('AB3aRSbwaGI') },
      { label: 'P. Temüüjin (SHOW MONGOLIA)', url: youtube('w2SUhR7qkt4') },
      { label: 'Jonon khar, Khalkh version (Battulga’s Mongol melodies)', url: youtube('mPeFu5jPkF4') },
      { label: 'Говийн Жонон, Gobi version (Монгол хуур төв)', url: youtube('i0SVv7g9iEk') }
    ],
    recordings: ['Baterdene, “The Gallop of Jonon Khar”, Smithsonian Folkways SFW40438, track 16'],
    techniques: ['gallop', 'double_stop', 'Horse-gait rhythm'],
    style: 'tatlaga',
    referenceKind: 'fiddle',
    notes: 'The central Khalkh tatlaga, with local variants (Khalkh and Gobi). No public-domain score exists: import one you are allowed to use, or your own transcription.',
    match: ['jonon khar', 'жонон хар', 'говийн жонон', 'goviin jonon']
  },
  {
    id: 'jingiin-tsuvaa',
    titleMn: 'Жингийн цуваа',
    titleLatin: 'Jingiin Tsuvaa (Camel Caravan)',
    kind: 'instrumental',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [],
    recordings: ['State Morin Khuur Ensemble, “Mongol Melody” LP, track A2 (4:05)'],
    techniques: ['double_stop', 'Caravan gait'],
    style: 'tatlaga',
    referenceKind: 'ensemble',
    notes: 'Traditional according to the LP’s tatlaga annotation; the ensemble arrangement is protected.',
    match: ['jingiin tsuvaa', 'жингийн цуваа', 'camel caravan']
  },

  // Long songs (urtiin duu): traditional melodies, protected recordings.
  {
    id: 'ertnii-saikhan',
    titleMn: 'Эртний сайхан',
    titleLatin: 'Ertnii Saikhan',
    kind: 'long-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [
      { label: 'D. Ganbaatar with O. Narmandakh (morin khuur), 2007', url: youtube('RpmCELHfOT8') },
      { label: 'G. Enkhbaatar', url: youtube('n-npM6MKIVg') }
    ],
    techniques: ['vibrato', 'gulsuulakh_glissando', 'Free rhythm'],
    style: 'urtiin-duu',
    referenceKind: 'voice',
    notes: 'Aizam (state) long song. Both videos are user uploads; the singer leads, so compare melody and rhythm rather than timbre.',
    match: ['ertnii saikhan', 'эртний сайхан']
  },
  {
    id: 'uyakhan-zambuu',
    titleMn: 'Уяхан замбуу тивийн наран',
    titleLatin: 'Uyakhan Zambuu Tiviin Naran',
    kind: 'long-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [{ label: 'N. Norovbanzad (re-upload)', url: youtube('Yc2XjWdpDtM') }],
    techniques: ['vibrato', 'gulsuulakh_glissando', 'Free rhythm'],
    style: 'urtiin-duu',
    referenceKind: 'voice',
    notes: 'Aizam long song from Deren sum, Dundgovi.',
    match: ['uyakhan zambuu', 'уяхан замбуу']
  },
  {
    id: 'ulemjiin-chanar',
    titleMn: 'Үлэмжийн чанар',
    titleLatin: 'Ülemjiin Chanar',
    kind: 'long-song',
    composer: 'Words: D. Danzanravjaa (1803–1856); melody traditional',
    rights: 'public-domain',
    songId: null,
    originals: [{ label: 'N. Norovbanzad (re-upload; same video as Uyakhan Zambuu)', url: youtube('Yc2XjWdpDtM') }],
    techniques: ['vibrato', 'gulsuulakh_glissando', 'Free rhythm'],
    style: 'urtiin-duu',
    referenceKind: 'voice',
    notes: 'The words are public domain; the melody is traditional or attributed. The spec names this piece as a test song.',
    match: ['ulemjiin chanar', 'үлэмжийн чанар']
  },
  {
    id: 'kherlengiin-bariyaa',
    titleMn: 'Хэрлэнгийн барьяа',
    titleLatin: 'Kherlengiin Bariyaa (The River Herlen)',
    kind: 'long-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [],
    recordings: ['Khongorzul (voice) and Baterdene (morin khuur), Smithsonian Folkways SFW40438, track 18'],
    techniques: ['vibrato', 'gulsuulakh_glissando', 'Free rhythm'],
    style: 'urtiin-duu',
    referenceKind: 'voice',
    match: ['kherlengiin bariyaa', 'хэрлэнгийн барьяа', 'river herlen']
  },
  {
    id: 'onchin-tsagaan-botgo',
    titleMn: 'Өнчин цагаан ботго',
    titleLatin: 'Önchin Tsagaan Botgo',
    kind: 'long-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [],
    techniques: ['vibrato', 'Free rhythm'],
    style: 'urtiin-duu',
    referenceKind: 'voice',
    notes: 'Belongs to the practice of coaxing a mother camel to accept her calf. Regional variants exist.',
    match: ['onchin tsagaan botgo', 'өнчин цагаан ботго']
  },
  {
    id: 'saruul-tal',
    titleMn: 'Саруул тал',
    titleLatin: 'Saruul Tal (Splendid Steppe)',
    kind: 'long-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [],
    recordings: ['State Morin Khuur Ensemble, “Mongol Melody” LP, track A1 (4:04)'],
    techniques: ['vibrato', 'double_stop'],
    style: 'urtiin-duu',
    referenceKind: 'ensemble',
    notes: 'Folk long song; the LP’s ensemble arrangement is protected.',
    match: ['saruul tal', 'саруул тал']
  },
  {
    id: 'tumen-ekh',
    titleMn: 'Түмэн эх',
    titleLatin: 'Tümen Ekh',
    kind: 'long-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [],
    techniques: ['vibrato', 'Free rhythm'],
    style: 'urtiin-duu',
    referenceKind: 'voice',
    notes: 'Statehood long song. The name is also an ensemble’s, so searches often find the ensemble instead.',
    match: ['tumen ekh', 'түмэн эх']
  },

  // Folk short songs.
  {
    id: 'tsonkhon-deer',
    titleMn: 'Цонхон дээр суусан ялаа',
    titleLatin: 'Tsonkhon Deer Suusan Yalaa (Fly on the Window)',
    kind: 'short-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [],
    recordings: ['State Morin Khuur Ensemble, “Mongol Melody” LP, track A4 (2:13)'],
    techniques: ['cuticle_side_stop'],
    style: 'khalkh-stage',
    referenceKind: 'ensemble',
    notes: 'The genre is disputed: the LP calls it a folk song (ардын дуу), other sources a long song (уртын дуу).',
    match: ['tsonkhon deer', 'цонхон дээр']
  },
  {
    id: 'khonin-joroo',
    titleMn: 'Хонин жороо морь',
    titleLatin: 'Khonin Joroo Mori',
    kind: 'short-song',
    composer: 'Traditional',
    rights: 'public-domain',
    songId: null,
    originals: [{ label: 'Altai Khangai, “Joroo Mori (Ambling Horse)” (may be a different tune)', url: 'https://open.spotify.com/track/3PcOtCX6FgdH9PS5PJvVAD' }],
    techniques: ['Ambling rhythm'],
    style: 'khalkh-stage',
    referenceKind: 'ensemble',
    notes: 'Folk (implied rather than stated); L. Dashnyam’s 1954 choral arrangement is protected. A reference for the amble feel of Etude 3.',
    match: ['khonin joroo', 'хонин жороо']
  },

  // Composed or modern works: protected, never bundled.
  {
    id: 'maamuu-naash-ir',
    titleMn: 'Маамуу нааш ир',
    titleLatin: 'Maamuu Naash Ir',
    kind: 'modern',
    composer: 'Music: Dagvyn Luvsansharav (1927–2014); words: Choijiljavyn Lkhamsüren (1917–1979); 1956',
    rights: 'copyrighted',
    songId: null,
    originals: [
      { label: 'Official “Маамуу” channel (playlist)', url: 'https://www.youtube.com/playlist?list=PLaghGG9rI5tl8_K9Wq9EM2HEW3thZNRcw' },
      { label: 'GoGo, 60th-anniversary report', url: youtube('yc4A-JJJ0Y8') },
      { label: 'Ami (piano), official video', url: youtube('5z4E4vuErxI') },
      { label: 'Recording (Qk3tYhg_F5U)', url: youtube('Qk3tYhg_F5U') },
      { label: 'Recording (9rn2f6Vl5kA)', url: youtube('9rn2f6Vl5kA') },
      { label: 'Recording (vAHN8Sb8Wio)', url: youtube('vAHN8Sb8Wio') },
      { label: 'B. Myagmarsuren, 2023 (Apple Music)', url: 'https://music.apple.com/us/album/maamuu-naash-ir/1719784818' }
    ],
    techniques: ['cuticle_side_stop', 'open'],
    style: 'khalkh-stage',
    referenceKind: 'voice',
    notes:
      'Composed children’s song, first released 25 October 1956 (© the authors’ heirs / Mongol Content LLC), protected until at least the end of 2064. Every original found is sung or played on the piano; no verified morin khuur performance exists. Not bundled: import your own copy (a .mkhuur.json, MIDI or MusicXML you are allowed to use) and it links here automatically. Play it in the stage style.',
    match: ['маамуу', 'maamuu', 'naashir', 'наашир']
  },
  {
    id: 'jonon-khongor',
    titleMn: 'Жонон хонгор морь',
    titleLatin: 'Jonon Khongor Mori',
    kind: 'modern',
    composer: 'L. Dashnyam (1963)',
    rights: 'copyrighted',
    songId: null,
    originals: [],
    techniques: [],
    style: 'khalkh-stage',
    referenceKind: 'voice',
    notes: 'A composed song that is often mistaken for a folk song.',
    match: ['jonon khongor', 'жонон хонгор']
  },
  {
    id: 'sersen-tal',
    titleMn: 'Сэрсэн тал',
    titleLatin: 'Sersen Tal',
    kind: 'modern',
    composer: 'B. Sharav (1952–2019), 1984',
    rights: 'copyrighted',
    songId: null,
    originals: [{ label: 'AldartanMN (unofficial upload)', url: youtube('4Hbp__4awXw') }],
    techniques: [],
    style: 'khalkh-stage',
    referenceKind: 'ensemble',
    notes: 'Protected until at least 2069.',
    match: ['sersen tal', 'сэрсэн тал']
  },
  {
    id: 'tsagaan-suvarga',
    titleMn: 'Цагаан суварга',
    titleLatin: 'Tsagaan Suvarga',
    kind: 'modern',
    composer: 'N. Jantsannorov (born 1949)',
    rights: 'copyrighted',
    songId: null,
    originals: [{ label: 'User upload', url: youtube('Cru4ClW-ELE') }],
    techniques: [],
    style: 'khalkh-stage',
    referenceKind: 'fiddle',
    match: ['tsagaan suvarga', 'цагаан суварга']
  },
  {
    id: 'argamag',
    titleMn: 'Аргамаг хүлгийн хурдаар',
    titleLatin: 'Argamag Khülgiin Khurdaar',
    kind: 'modern',
    composer: 'Kh. Altangerel',
    rights: 'copyrighted',
    songId: null,
    originals: [{ label: 'Channel “AltanGerel” (not proven to be the composer’s own)', url: youtube('ageR3ZhlAGM') }],
    techniques: ['gallop'],
    style: 'khalkh-stage',
    referenceKind: 'fiddle',
    match: ['argamag', 'аргамаг']
  },
  {
    id: 'wan-ma-benteng',
    titleMn: '万马奔腾',
    titleLatin: 'Wan Ma Benteng (Ten Thousand Galloping Horses)',
    kind: 'modern',
    composer: 'Chi Bulag (born 1944)',
    rights: 'copyrighted',
    songId: null,
    originals: [
      { label: 'CCTV', url: youtube('xDjo1HRf9NI') },
      { label: 'CCTV (another performance)', url: youtube('LVsRQDE2PHE') },
      { label: 'CCTV Spring Festival Gala', url: youtube('SKsYXd3fufQ') },
      { label: 'User upload', url: youtube('0OdmL-AYOMg') }
    ],
    techniques: ['gallop', 'horse_whinny'],
    style: 'inner-mongolian',
    referenceKind: 'ensemble',
    notes: 'Inner Mongolian matouqin piece. The Cyrillic title is not verified yet.',
    match: ['万马奔腾', 'wan ma benteng', 'ten thousand galloping horses']
  },
  {
    id: 'wolf-totem',
    titleMn: 'Wolf Totem',
    titleLatin: 'Wolf Totem',
    kind: 'modern',
    composer: 'The HU',
    rights: 'copyrighted',
    songId: null,
    originals: [{ label: 'The HU, official video (@HunnuRock)', url: youtube('jM8dCGIm6yc') }],
    techniques: [],
    style: 'khalkh-stage',
    referenceKind: 'ensemble',
    notes: 'Folk-rock band with morin khuur. The Mongolian title is not verified yet.',
    match: ['wolf totem']
  },
  {
    id: 'yuve-yuve-yu',
    titleMn: 'Yuve Yuve Yu',
    titleLatin: 'Yuve Yuve Yu',
    kind: 'modern',
    composer: 'The HU',
    rights: 'copyrighted',
    songId: null,
    originals: [{ label: 'The HU, official video (@HunnuRock)', url: youtube('v4xZUr0BEfE') }],
    techniques: [],
    style: 'khalkh-stage',
    referenceKind: 'ensemble',
    notes: 'Folk-rock band with morin khuur. The Mongolian title is not verified yet.',
    match: ['yuve yuve yu']
  },
  {
    id: 'gada-meiren',
    titleMn: '嘎达梅林',
    titleLatin: 'Gada Meiren',
    kind: 'short-song',
    composer: 'Traditional (Khorchin narrative song)',
    rights: 'public-domain',
    songId: null,
    originals: [],
    techniques: [],
    style: 'inner-mongolian',
    referenceKind: 'voice',
    notes: 'The folk melody is public domain; An Bo’s four-stanza version is a protected arrangement. The Cyrillic title is not verified yet.',
    match: ['嘎达梅林', 'gada meiren', 'gada meilin']
  },
  {
    id: 'hongyan',
    titleMn: '鸿雁',
    titleLatin: 'Hongyan (Wild Geese)',
    kind: 'modern',
    composer: 'Original 鸿嘎鲁 attributed to a lama of the Mergen temple; modern version by Lü Yanwei and Zhang Hongguang',
    rights: 'unknown',
    songId: null,
    originals: [],
    techniques: [],
    style: 'inner-mongolian',
    referenceKind: 'voice',
    notes: 'The dates of the original are unknown; the modern version is protected. The Cyrillic title is not verified yet.',
    match: ['鸿雁', '鸿嘎鲁', 'hongyan', 'wild geese']
  },

  // The project's own etudes (bundled).
  {
    id: 'etude-open-strings',
    titleMn: 'Дасгал 1 · Задгай хөвч',
    titleLatin: 'Etude 1 · Open Strings (Arga & Bilag)',
    kind: 'etude',
    composer: ETUDE_COMPOSER,
    rights: 'original',
    songId: '01-open-strings',
    originals: [],
    techniques: ['open', 'double_stop'],
    style: 'khalkh-stage',
    referenceKind: 'fiddle',
    notes: 'Listen to the bow change and the open-string tone.'
  },
  {
    id: 'etude-first-position-scale',
    titleMn: 'Дасгал 2 · Нэгдүгээр байрлалын гамм',
    titleLatin: 'Etude 2 · First-Position Scale',
    kind: 'etude',
    composer: ETUDE_COMPOSER,
    rights: 'original',
    songId: '02-first-position-scale',
    originals: [],
    techniques: ['open', 'cuticle_side_stop'],
    style: 'khalkh-stage',
    referenceKind: 'fiddle',
    notes: 'Stopped notes against open strings: listen for intonation and the stopped-string colour.'
  },
  {
    id: 'etude-joroo-gallop',
    titleMn: 'Дасгал 3 · Жороо хэмнэл',
    titleLatin: 'Etude 3 · Joroo Amble Rhythm',
    kind: 'etude',
    composer: ETUDE_COMPOSER,
    rights: 'original',
    songId: '03-joroo-gallop',
    originals: [],
    techniques: ['gallop', 'body_tap', 'col_legno', 'cuticle_side_stop', 'vibrato'],
    style: 'tatlaga',
    referenceKind: 'fiddle',
    notes: 'The gallop bowing: listen to the accents and the length of each stroke.'
  },
  {
    id: 'etude-tsatsal-harmonics',
    titleMn: 'Дасгал 4 · Цацал (флажолет)',
    titleLatin: 'Etude 4 · Tsatsal Harmonics',
    kind: 'etude',
    composer: ETUDE_COMPOSER,
    rights: 'original',
    songId: '04-tsatsal-harmonics',
    originals: [],
    techniques: ['open', 'tsatsal_harmonic', 'artificial_harmonic'],
    style: 'khalkh-stage',
    referenceKind: 'fiddle',
    notes: 'Harmonics should sound pure and airy, without the fundamental.'
  },
  {
    id: 'etude-long-song-phrase',
    titleMn: 'Дасгал 5 · Уртын дууны хэллэг',
    titleLatin: 'Etude 5 · Long-Song Phrase',
    kind: 'etude',
    composer: ETUDE_COMPOSER,
    rights: 'original',
    songId: '05-long-song-phrase',
    originals: [],
    techniques: ['cuticle_side_stop', 'gulsuulakh_glissando', 'vibrato', 'double_stop'],
    style: 'urtiin-duu',
    referenceKind: 'fiddle',
    notes: 'Urtiin duu style: vibrato width and speed, slides and the closing drone.'
  },
  {
    id: 'etude-hooves-whinny',
    titleMn: 'Дасгал 6 · Туурай, чимхэлт, янцгаалт',
    titleLatin: 'Etude 6 · Hooves, Plucks & Whinny',
    kind: 'etude',
    composer: ETUDE_COMPOSER,
    rights: 'original',
    songId: '06-whinny-and-percussion',
    originals: [],
    techniques: ['body_tap', 'string_slap', 'col_legno', 'pizzicato', 'horse_whinny', 'double_stop'],
    style: 'tatlaga',
    referenceKind: 'fiddle',
    notes: 'Percussion and the horse whinny.'
  }
]

export function isStyleId(value: unknown): value is StyleId {
  return STYLES.some((s) => s.id === value)
}

export function isReferenceKind(value: unknown): value is ReferenceKind {
  return REFERENCE_KINDS.includes(value as ReferenceKind)
}

/** Problems with playlist data (duplicate ids, unknown bundled songs, non-https links…); empty when valid. */
export function validatePlaylist(entries: readonly PlaylistEntry[], songIds: readonly string[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const known = new Set(songIds)
  for (const e of entries) {
    const where = e.id || '(no id)'
    if (!e.id.trim()) problems.push('An entry has no id.')
    else if (seen.has(e.id)) problems.push(`Duplicate id “${e.id}”.`)
    seen.add(e.id)
    if (!e.titleMn.trim() || !e.titleLatin.trim()) problems.push(`${where}: both titles are required.`)
    if (!e.composer.trim()) problems.push(`${where}: composer is empty (use 'Traditional').`)
    if (e.songId !== null && !known.has(e.songId)) problems.push(`${where}: bundled song “${e.songId}” does not exist.`)
    const urls = new Set<string>()
    for (const o of e.originals) {
      if (!o.label.trim()) problems.push(`${where}: a link has no label.`)
      if (!isHttpsUrl(o.url)) problems.push(`${where}: “${o.url}” is not an https URL.`)
      else if (urls.has(o.url)) problems.push(`${where}: “${o.url}” is listed twice.`)
      urls.add(o.url)
    }
    for (const t of e.techniques) {
      if (!t.trim()) problems.push(`${where}: empty technique.`)
      else if (/^[a-z]+(_[a-z]+)*$/.test(t) && !isTechniqueId(t)) problems.push(`${where}: unknown technique id “${t}”.`)
    }
    if (!isStyleId(e.style)) problems.push(`${where}: unknown style “${String(e.style)}”.`)
    if (!isReferenceKind(e.referenceKind)) problems.push(`${where}: unknown reference kind “${String(e.referenceKind)}”.`)
    if (e.match?.some((m) => !normalizeTitle(m))) problems.push(`${where}: empty match keyword.`)
  }
  return problems
}

export function isHttpsUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Lower-case, accents removed, punctuation and spaces dropped — so "Maamuu naash ir",
 * "MAAMUU-NAASHIR" and "Маамуу нааш ир!" compare by their letters only.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Keywords this short match too much by accident; two Chinese characters are already a word. */
const isSpecificKey = (key: string) => key.length >= 4 || /^\p{Script=Han}{2,}$/u.test(key)

/** True when `title` contains one of the entry's match keywords (or either of its titles). */
export function titleMatches(entry: PlaylistEntry, title: string): boolean {
  const t = normalizeTitle(title)
  if (!t) return false
  return [...(entry.match ?? []), entry.titleMn, entry.titleLatin].some((k) => {
    const key = normalizeTitle(k)
    return isSpecificKey(key) && t.includes(key)
  })
}

/**
 * The user's link from an entry to a song: a song id, `false` when they unlinked it on purpose
 * (no automatic matching), or null to match imported songs by title.
 */
export type SongLink = string | false | null

export interface LibrarySong {
  id: string
  title: string
  builtIn: boolean
}

/** Where an entry's score comes from: a linked import, the bundled song, an import matched by title, or nothing yet. */
export type SongSource = { kind: 'linked' | 'bundled' | 'matched'; songId: string } | { kind: 'missing' }

export function resolveSong(entry: PlaylistEntry, link: SongLink | undefined, library: readonly LibrarySong[]): SongSource {
  if (typeof link === 'string' && library.some((s) => s.id === link)) return { kind: 'linked', songId: link }
  if (entry.songId !== null && library.some((s) => s.id === entry.songId)) return { kind: 'bundled', songId: entry.songId }
  if (link !== false) {
    const found = library.find((s) => !s.builtIn && titleMatches(entry, s.title))
    if (found) return { kind: 'matched', songId: found.id }
  }
  return { kind: 'missing' }
}

/** Ids of the entries that can be played, in playlist order. */
export function playableQueue(entries: readonly PlaylistEntry[], sourceOf: (entry: PlaylistEntry) => SongSource): string[] {
  return entries.filter((e) => sourceOf(e).kind !== 'missing').map((e) => e.id)
}

/** The entry after `currentId` in the queue; the first one when `currentId` is not queued; null at the end. */
export function nextInQueue(queue: readonly string[], currentId: string | null): string | null {
  const i = currentId === null ? -1 : queue.indexOf(currentId)
  return queue[i + 1] ?? null
}

/** Longest excerpt of an original recording that is analysed (analysis time grows with length). */
export const MAX_EXCERPT_SECONDS = 90
const MIN_EXCERPT_SECONDS = 20
/** Shortest excerpt length the user can choose. */
const MIN_CHOSEN_EXCERPT_SECONDS = 2

/**
 * The part of an original recording compared with our version: from `start` (where the melody
 * begins), `length` seconds when the user chose a length (a section of a long recording), else a
 * little longer than ours so the whole tune fits even at a slower tempo; at most 90 s.
 */
export function excerptWindow(recordingSeconds: number, start: number, ourSeconds: number, length: number | null = null): { start: number; duration: number } {
  const total = Math.max(0, recordingSeconds)
  const from = Math.min(Math.max(0, Number.isFinite(start) ? start : 0), Math.max(0, total - 1))
  const chosen = length !== null && Number.isFinite(length) && length > 0
  const wanted = chosen
    ? Math.min(MAX_EXCERPT_SECONDS, Math.max(MIN_CHOSEN_EXCERPT_SECONDS, length))
    : Math.min(MAX_EXCERPT_SECONDS, Math.max(MIN_EXCERPT_SECONDS, ourSeconds * 1.25))
  return { start: from, duration: Math.max(0, Math.min(wanted, total - from)) }
}

/**
 * A/B switching keeps the musical position: time since the melody started in one version maps to
 * the same time after the other version's start (clamped to its length).
 */
export function mapAbPosition(position: number, fromOnset: number, toOnset: number, toDuration: number): number {
  return Math.min(Math.max(0, position - fromOnset + toOnset), Math.max(0, toDuration))
}

/**
 * A seconds field as typed: a finite number ≥ 0, or null while it is empty or not a number yet
 * (the stored value stays until the user types one).
 */
export function parseSeconds(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const v = Number(t)
  return Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * Keys to drop from a cache listed least recently used first, so it keeps at most `maxEntries`
 * entries and `maxBytes` bytes. Entries still being made (`bytes: null`) hold nothing yet and are
 * kept, as is the most recent entry.
 */
export function cacheEvictions(entries: readonly { key: string; bytes: number | null }[], { maxEntries, maxBytes }: { maxEntries: number; maxBytes: number }): string[] {
  let count = entries.length
  let bytes = entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0)
  const evict: string[] = []
  for (const e of entries.slice(0, -1)) {
    if (count <= maxEntries && bytes <= maxBytes) break
    if (e.bytes === null) continue
    evict.push(e.key)
    count--
    bytes -= e.bytes
  }
  return evict
}

/** Common A/B listening level (RMS, dBFS), so neither version wins by being louder. */
export const LISTENING_RMS_DB = -20

/**
 * Gain that brings a recording to the common listening level, from the RMS of its audible 50 ms
 * blocks (blocks 40 dB below the loudest are silence and ignored), capped so peaks stay below
 * full scale.
 */
export function listeningGain(channels: readonly Float32Array[], sampleRate: number, targetDb = LISTENING_RMS_DB): number {
  const length = channels[0]?.length ?? 0
  const block = Math.max(1, Math.round(sampleRate * 0.05))
  const powers: number[] = []
  let peak = 0
  let loudest = 0
  for (let start = 0; start < length; start += block) {
    const end = Math.min(length, start + block)
    let sum = 0
    for (const ch of channels) {
      for (let i = start; i < end; i++) {
        const v = ch[i]!
        sum += v * v
        const a = v < 0 ? -v : v
        if (a > peak) peak = a
      }
    }
    const power = sum / ((end - start) * channels.length)
    powers.push(power)
    if (power > loudest) loudest = power
  }
  let sum = 0
  let count = 0
  for (const p of powers) {
    if (p < loudest * 1e-4) continue
    sum += p
    count++
  }
  if (!count || sum <= 0 || peak <= 0) return 1
  const gain = 10 ** (targetDb / 20) / Math.sqrt(sum / count)
  return Math.min(gain, 0.98 / peak, 30)
}

/** How our version is rendered for a comparison: dry, or in the open-steppe room. */
export type CompareRoom = 'dry' | 'steppe'

export interface ComparisonSummary {
  /** ISO timestamp. */
  at: string
  /** File name of the original recording. */
  referenceName: string
  room: CompareRoom
  /** What the original was taken to be (absent in comparisons saved before it existed). */
  referenceKind?: ReferenceKind
  /** Playing style of our version; null when rendered without one. */
  style?: StyleId | null
  /** Seconds of the original that were analysed. */
  excerpt: { start: number; duration: number }
  score: number | null
  rows: ComparisonRow[]
}

// ---------------------------------------------------------------------------------------------
// Blind listening (ABX-style): two sources in random order, the listener says which sounds more
// like a real morin khuur and (against the original) which one is ours.

export type BlindMode = 'ours-vs-original' | 'style-vs-style'

/** A source in a blind trial: the loaded original, our version in the entry's style, or our version in a given style. */
export type BlindSource = 'original' | 'ours' | StyleId

/** Excerpt length of a blind trial, seconds. */
export const BLIND_EXCERPT_SECONDS = { min: 8, max: 10 }

export interface BlindTrial {
  mode: BlindMode
  /** Play order: excerpt 1, then excerpt 2. */
  order: [BlindSource, BlindSource]
  /** Seconds after each version's melody start where both excerpts begin. */
  at: number
  seconds: number
}

/** Rounded down to 0.1 s (so a window never grows past what is available). */
const tenths = (s: number) => Math.floor(s * 10 + 1e-9) / 10

/**
 * A new trial: `sources` in random order, an 8–10 s excerpt (the whole melody when it is shorter)
 * at a random point of the first `melodySeconds` of both versions.
 */
export function createBlindTrial(mode: BlindMode, sources: readonly [BlindSource, BlindSource], melodySeconds: number, random: () => number = Math.random): BlindTrial {
  const order: [BlindSource, BlindSource] = random() < 0.5 ? [sources[0], sources[1]] : [sources[1], sources[0]]
  const available = Math.max(0, Number.isFinite(melodySeconds) ? melodySeconds : 0)
  const { min, max } = BLIND_EXCERPT_SECONDS
  const seconds = tenths(Math.min(available, min + (max - min) * random()))
  const at = tenths(random() * Math.max(0, available - seconds))
  return { mode, order, at, seconds }
}

export interface BlindAnswer {
  /** ISO timestamp. */
  at: string
  mode: BlindMode
  order: [BlindSource, BlindSource]
  excerpt: { at: number; seconds: number }
  /** The source that sounded more like a real morin khuur; null = could not tell. */
  moreReal: BlindSource | null
  /** Ours vs original: the source taken for ours; null = no guess (always null for style trials). */
  guessedOurs: BlindSource | null
  /** Style of our version in an ours-vs-original trial; null when rendered without one. */
  oursStyle: StyleId | null
  /** Ours vs original: the recording's file name. */
  referenceName: string | null
  room: CompareRoom
}

/** Answers kept per entry (oldest dropped first), so feedback stays small in localStorage. */
export const MAX_BLIND_ANSWERS = 200

export function isBlindSource(value: unknown): value is BlindSource {
  return value === 'original' || value === 'ours' || isStyleId(value)
}

function isBlindAnswer(value: unknown): value is BlindAnswer {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Partial<BlindAnswer>
  return (
    typeof a.at === 'string' &&
    (a.mode === 'ours-vs-original' || a.mode === 'style-vs-style') &&
    Array.isArray(a.order) &&
    a.order.length === 2 &&
    a.order.every(isBlindSource) &&
    typeof a.excerpt?.at === 'number' &&
    typeof a.excerpt.seconds === 'number' &&
    (a.moreReal === null || isBlindSource(a.moreReal)) &&
    (a.guessedOurs === null || isBlindSource(a.guessedOurs)) &&
    (a.oursStyle === null || isStyleId(a.oursStyle)) &&
    (a.referenceName === null || typeof a.referenceName === 'string') &&
    (a.room === 'dry' || a.room === 'steppe')
  )
}

/** Chance of at least `k` successes in `n` fair coin flips (one-sided binomial p-value). */
export function binomialTail(k: number, n: number): number {
  if (n <= 0 || k <= 0) return 1
  if (k > n) return 0
  let p = 0.5 ** n
  let tail = 0
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += p
    p *= (n - i) / (i + 1)
  }
  return Math.min(1, tail)
}

export interface BlindSummary {
  /** Ours vs the original recording. */
  original: {
    trials: number
    /** Trials with a guess of which one is ours, and how many guesses were right. */
    guesses: number
    identified: number
    /** Chance of identifying at least that many by guessing (null without guesses): small = ours is recognisable. */
    p: number | null
    oursMoreReal: number
    originalMoreReal: number
    undecided: number
  }
  /** Style against style, one row per pair (ids in alphabetical order). */
  styles: { a: StyleId; b: StyleId; trials: number; aWins: number; bWins: number; undecided: number }[]
}

export function blindSummary(answers: readonly BlindAnswer[]): BlindSummary {
  const original = { trials: 0, guesses: 0, identified: 0, p: null as number | null, oursMoreReal: 0, originalMoreReal: 0, undecided: 0 }
  const pairs = new Map<string, BlindSummary['styles'][number]>()
  for (const a of answers) {
    if (a.mode === 'ours-vs-original') {
      original.trials++
      if (a.guessedOurs !== null) {
        original.guesses++
        if (a.guessedOurs !== 'original') original.identified++
      }
      if (a.moreReal === null) original.undecided++
      else if (a.moreReal === 'original') original.originalMoreReal++
      else original.oursMoreReal++
      continue
    }
    const [x, y] = a.order
    if (!isStyleId(x) || !isStyleId(y) || x === y) continue
    const [s, t] = x < y ? [x, y] : [y, x]
    const key = `${s}|${t}`
    let pair = pairs.get(key)
    if (!pair) pairs.set(key, (pair = { a: s, b: t, trials: 0, aWins: 0, bWins: 0, undecided: 0 }))
    pair.trials++
    if (a.moreReal === s) pair.aWins++
    else if (a.moreReal === t) pair.bWins++
    else pair.undecided++
  }
  original.p = original.guesses ? binomialTail(original.identified, original.guesses) : null
  return { original, styles: [...pairs.values()].sort((p, q) => p.a.localeCompare(q.a) || p.b.localeCompare(q.b)) }
}

// ---------------------------------------------------------------------------------------------

export interface EntryFeedback {
  link: SongLink
  /** 1–5, or null when not rated. */
  rating: number | null
  notes: string
  comparison: ComparisonSummary | null
  /** Where the melody begins in the user's original recording, seconds (A/B alignment, comparison excerpt). */
  originalStart: number
  /** Seconds of the original compared from `originalStart`; null = a little longer than ours. */
  excerptLength: number | null
  /** What the loaded original is; null = the entry's default. */
  referenceKind: ReferenceKind | null
  /** Playing style of our version; null = the entry's default. */
  style: StyleId | null
  /** Blind listening answers, oldest first. */
  blind: BlindAnswer[]
}

export const EMPTY_FEEDBACK: EntryFeedback = {
  link: null,
  rating: null,
  notes: '',
  comparison: null,
  originalStart: 0,
  excerptLength: null,
  referenceKind: null,
  style: null,
  blind: []
}

export function clampRating(rating: number | null): number | null {
  if (rating === null || !Number.isFinite(rating)) return null
  return Math.min(5, Math.max(1, Math.round(rating)))
}

const finiteOr = <T>(v: unknown, fallback: T): number | T => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Feedback as stored by any earlier version (or edited by hand), with every field valid. */
export function normalizeFeedback(value: unknown): EntryFeedback {
  const f = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<keyof EntryFeedback, unknown>>
  const length = finiteOr(f.excerptLength, null)
  return {
    link: typeof f.link === 'string' || f.link === false ? f.link : null,
    rating: clampRating(finiteOr(f.rating, null)),
    notes: typeof f.notes === 'string' ? f.notes : '',
    comparison: typeof f.comparison === 'object' && f.comparison !== null && Array.isArray((f.comparison as ComparisonSummary).rows) ? (f.comparison as ComparisonSummary) : null,
    originalStart: Math.max(0, finiteOr(f.originalStart, 0)),
    excerptLength: length !== null && length > 0 ? length : null,
    referenceKind: isReferenceKind(f.referenceKind) ? f.referenceKind : null,
    style: isStyleId(f.style) ? f.style : null,
    blind: Array.isArray(f.blind) ? f.blind.filter(isBlindAnswer).slice(-MAX_BLIND_ANSWERS) : []
  }
}

/** A measured value with its unit, e.g. "5.6 Hz", "−12.0 dB", "34¢", "—" when missing. */
export function formatMeasure(value: number | null, unit: string, { signed = false } = {}): string {
  if (value === null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  const text = abs.toFixed(digits)
  const sign = value < 0 && Number(text) !== 0 ? '−' : signed && Number(text) !== 0 ? '+' : ''
  const tight = unit === '%' || unit === '¢' || unit === ''
  return `${sign}${text}${tight ? unit : ` ${unit}`}`
}

export const styleName = (id: StyleId): string => STYLES.find((s) => s.id === id)?.name ?? id

export interface FeedbackContext {
  /** ISO timestamp of the export. */
  generatedAt: string
  /** Playback settings that shape the sound (soundboard, vibrato…), for the developer. */
  settings: Record<string, string | number>
  /** Title of a linked or bundled song, for the report. */
  songTitle(id: string): string | null
}

export interface FeedbackExport {
  format: 'mkhuur-playlist-feedback'
  version: 2
  generatedAt: string
  settings: Record<string, string | number>
  entries: {
    id: string
    titleMn: string
    titleLatin: string
    song: { source: SongSource['kind']; id: string | null; title: string | null }
    /** What the loaded original was taken to be, and the style of our version. */
    referenceKind: ReferenceKind
    style: StyleId
    rating: number | null
    notes: string
    comparison: ComparisonSummary | null
    blind: { summary: BlindSummary; answers: BlindAnswer[] }
  }[]
}

/** All ratings, notes, last comparisons and blind-test answers as JSON-ready data. */
export function feedbackData(
  entries: readonly PlaylistEntry[],
  feedback: Readonly<Record<string, EntryFeedback>>,
  sourceOf: (entry: PlaylistEntry) => SongSource,
  ctx: FeedbackContext
): FeedbackExport {
  return {
    format: 'mkhuur-playlist-feedback',
    version: 2,
    generatedAt: ctx.generatedAt,
    settings: ctx.settings,
    entries: entries.map((e) => {
      const f = { ...EMPTY_FEEDBACK, ...feedback[e.id] }
      const src = sourceOf(e)
      const id = src.kind === 'missing' ? null : src.songId
      return {
        id: e.id,
        titleMn: e.titleMn,
        titleLatin: e.titleLatin,
        song: { source: src.kind, id, title: id === null ? null : ctx.songTitle(id) },
        referenceKind: f.referenceKind ?? e.referenceKind,
        style: f.style ?? e.style,
        rating: f.rating,
        notes: f.notes,
        comparison: f.comparison,
        blind: { summary: blindSummary(f.blind), answers: f.blind }
      }
    })
  }
}

const stars = (rating: number | null) => (rating === null ? '—' : `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`)
const percent = (score: number | null) => (score === null ? '—' : `${Math.round(score * 100)}%`)
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
const pValue = (p: number) => (p < 0.001 ? '< 0.001' : p.toFixed(p < 0.01 ? 3 : 2))

/** Plain-language lines for a blind-test summary (empty without answers). */
export function blindLines(summary: BlindSummary): string[] {
  const lines: string[] = []
  const o = summary.original
  if (o.trials) {
    const guessed = o.guesses ? `picked ours correctly in ${o.identified} of ${o.guesses} (by chance: p = ${pValue(o.p ?? 1)})` : 'no guesses of which one is ours'
    lines.push(
      `Ours vs the original, ${o.trials} blind trial${o.trials === 1 ? '' : 's'}: ${guessed}; more like a real morin khuur: ours ${o.oursMoreReal}, the original ${o.originalMoreReal}, can’t tell ${o.undecided}.`
    )
  }
  for (const s of summary.styles) {
    lines.push(`${styleName(s.a)} vs ${styleName(s.b)}, ${s.trials} blind trial${s.trials === 1 ? '' : 's'}: more like a real morin khuur: ${styleName(s.a)} ${s.aWins}, ${styleName(s.b)} ${s.bWins}, can’t tell ${s.undecided}.`)
  }
  return lines
}

/**
 * A Markdown report to send to the developer: an overview table, each piece's notes, last
 * comparison and blind-test results, and the same data as JSON at the end (for tooling).
 */
export function feedbackMarkdown(
  entries: readonly PlaylistEntry[],
  feedback: Readonly<Record<string, EntryFeedback>>,
  sourceOf: (entry: PlaylistEntry) => SongSource,
  ctx: FeedbackContext
): string {
  const data = feedbackData(entries, feedback, sourceOf, ctx)
  const lines: string[] = [
    '# Morin Khuur Simulator — playlist feedback',
    '',
    `Exported ${ctx.generatedAt}.`,
    '',
    ...Object.entries(ctx.settings).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '| Piece | Score source | Rating | Similarity | Blind trials |',
    '| --- | --- | --- | --- | --- |',
    ...data.entries.map(
      (e) =>
        `| ${cell(`${e.titleMn} (${e.titleLatin})`)} | ${cell(e.song.title ?? e.song.source)} | ${stars(e.rating)} | ${percent(e.comparison?.score ?? null)} | ${e.blind.answers.length || '—'} |`
    )
  ]
  for (const e of data.entries) {
    if (e.rating === null && !e.notes.trim() && !e.comparison && !e.blind.answers.length) continue
    lines.push('', `## ${e.titleMn} (${e.titleLatin})`, '')
    if (e.rating !== null) lines.push(`Rating: ${stars(e.rating)} (${e.rating}/5)`, '')
    if (e.notes.trim()) lines.push(...e.notes.trim().split('\n').map((l) => `> ${l}`), '')
    const c = e.comparison
    if (c) {
      const kind = c.referenceKind ? `, taken as ${REFERENCE_KIND_INFO[c.referenceKind].label.toLowerCase()}` : ''
      const style = c.style ? `, style ${styleName(c.style)}` : ''
      lines.push(
        `Compared ${c.at} with “${c.referenceName}” (${c.excerpt.start.toFixed(1)}–${(c.excerpt.start + c.excerpt.duration).toFixed(1)} s${kind}), our version ${c.room === 'dry' ? 'dry' : 'in the steppe room'}${style}: similarity ${percent(c.score)}.`,
        '',
        '| Feature | Ours | Original | Difference | OK |',
        '| --- | --- | --- | --- | --- |',
        ...c.rows.map(
          (r) =>
            `| ${cell(r.label)} | ${formatMeasure(r.sim, r.unit)} | ${formatMeasure(r.ref, r.unit)} | ${formatMeasure(r.delta, r.unit, { signed: true })} | ${r.ok === null ? (r.informational ? 'not scored' : '—') : r.ok ? 'yes' : 'no'} |`
        )
      )
      const hints = [...c.rows.filter((r) => r.ok === false && r.hint), ...c.rows.filter((r) => r.ok === null && r.hint)]
      // Informational rows were measured; their hints already say they are not scored.
      if (hints.length) lines.push('', ...hints.map((r) => `- ${r.ok === null && !r.informational ? '(not measured) ' : ''}${r.hint}`))
    }
    const blind = blindLines(e.blind.summary)
    if (blind.length) lines.push('', ...blind.map((l) => `- ${l}`))
  }
  lines.push('', '## Data', '', '```json', JSON.stringify(data, null, 2), '```', '')
  return lines.join('\n')
}
