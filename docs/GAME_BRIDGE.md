# The game bridge — how a song made here becomes a Malchin asset

Malchin (the steppe life-sim in `C:\Users\ADMIN\projects\malchingameconcept`) will one day use music
made in this simulator. This page is the route a song takes from here into the game: what file
leaves, at what rate and level, under what name, with what record of where it came from, and in
what words it is described. Written 2026-10-02 (Malchin nightly run 6, K2). **It is a proposal
until the developer signs it off.** Nothing in Malchin reads a simulator file today.

## 1. What may cross

| Source | Crosses? | Why |
|---|---|---|
| `songs/*.mkhuur.json` (the bundled etudes) | yes | Original etudes, written for this project |
| A new song written for the game | yes | The same, once it is in `songs/` and passes `library.test.ts` |
| A transcription with a verifiable `source` (e.g. Van Oost 1908) | only by the developer's ruling | Public domain is not the same as "fine to sell"; the game's words rule (§6) still applies |
| `local-songs/` (private, copyrighted works) | **never** | Personal use only; never into `songs/`, never into a build |
| `references/` recordings | **never** | Analysis only (their manifest says what each one is) |

## 2. Rendering

Two renderers exist; use the fuller one for anything that ships.

- **The app (Studio → export WAV)** — the whole chain: both strings, soundbox, room, plucks,
  ornaments, vibrato curves, limiter. This is the one for a finished cue.
- **Node, `npm run render -- <song> [out.wav] --rate=44100`** (`scripts/render-song.mjs`) — the
  bowed strings through the soundbox, in a terminal, no browser. Since 2026-10-02 it includes the
  body (`--body=wood|hide|none`, default `wood`); it still has no room, no plucks or percussion,
  and no vibrato or ornament curves. Good for drafts, CI and measuring; drier than the app.

**Rate: 44.1 kHz, not 48.** The game's own score is rendered at 44 100 Hz
(`tools/audio/boss_music/engine.py`, `SR = 44100`), and a cue at another rate is resampled on
import for nothing. Pass `--rate=44100` to the Node renderer. The app exports at its audio
context's rate (`offline.ts` writes `buffer.sampleRate`), which is usually 48 kHz on Windows:
the game's mastering step resamples it to 44.1 kHz, and the provenance row says it did.
Hand over **16-bit (or float) mono WAV**. Do not encode to Ogg here.

## 3. Level

The game masters, not the simulator. Its score's targets (`tools/audio/boss_music/engine.py`):

| | Game target | What a simulator render is |
|---|---|---|
| Integrated loudness | **−16 LUFS** (`TARGET_LUFS`, measured by ffmpeg's `ebur128`) | not normalised for loudness; RMS −10 to −12 dBFS on the etudes (2026-10-02), so roughly 4–6 dB too loud |
| Peak | **−1.2 dBTP true peak** (`CEILING_DBTP`) | −1.0 dBFS **sample** peak, which can be over the game's true-peak ceiling |
| Encoding | Ogg Vorbis q6 (`VORBIS_Q`), by the game's Python | WAV |

So a render goes into the game's mastering step (measure with `ebur128`, gain to −16 LUFS, check
true peak ≤ −1.2 dBTP, encode Vorbis q6), never straight into `assets/`. A loop must also pass
that pipeline's seam test (no onset within 6 ms of the join).

## 4. Naming

- Game file: `assets/audio/music/<context>/<id>.ogg`, `<id>` lower `snake_case`, ASCII only —
  Malchin's rule: code ids are the ASCII fold of the romanised word (`khuur`, not `xuur` or
  `хуур`; `ö`/`ü` fold to `o`/`u`).
- Proposed `<id>`: `khuur_` + the song file's stem with dashes to underscores, e.g.
  `songs/05-long-song-phrase.mkhuur.json` → `khuur_05_long_song_phrase.ogg`.
- Display text (credits, store) uses the game's romanisation: **kh** for х, keep **ö/ü**, keep
  double vowels; *morin khuur*, never "horsehead fiddle" alone, never "yurt" for ger.

## 5. Provenance

Malchin records every audio file it did not synthesise itself, with a hash
(`tools/audio/sfx/provenance.json` is the shape). A simulator cue gets the same row:

```json
{
  "file": "assets/audio/music/<context>/khuur_05_long_song_phrase.ogg",
  "source": "Morinkhuursimulator songs/05-long-song-phrase.mkhuur.json",
  "simulator_commit": "<git rev-parse HEAD in the simulator>",
  "render": "Studio export | npm run render -- songs/05-long-song-phrase.mkhuur.json out.wav --rate=44100 --style=khalkh-stage",
  "wav_sha256": "<sha256 of the handed-over WAV>",
  "licence": "original work of the developer",
  "words": "original, synthesised for the game, inspired by the morin khuur"
}
```

The simulator is a local git repository from 2026-10-01 so `simulator_commit` means something;
commit before rendering a cue that will ship.

## 6. The words

Malchin's public wording for its music is fixed (its handbook, AGENTS.md → Audio): **"original
score, synthesised for the game, inspired by the morin khuur, tovshuur, khöömii and khengereg"**.
A simulator cue is described the same way. **Never** "traditional", "folk" or "authentic", never
UNESCO, never a shaman or a monastery — and that holds even for a cue built from a public-domain
transcription, because the performance is still a synthesis. Commissioning real players stays the
developer's call.

## 7. Checklist for one cue

1. The song is in `songs/`, `npm test` green (it verifies and its pitches pass).
2. Commit the simulator; note the sha.
3. Render: the app's Studio for a shipping cue (resampled to 44.1 kHz in step 4), or Node with
   `--rate=44100` for a draft.
4. In Malchin: master to −16 LUFS / −1.2 dBTP, Vorbis q6, seam test for loops.
5. Name it `khuur_<stem>.ogg`; add the provenance row with both hashes.
6. Public words as §6. The developer listens before it ships.
