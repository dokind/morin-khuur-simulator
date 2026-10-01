import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSong } from './parse'
import { verifySong } from './verify'

// Every song shipped in /songs must be physically playable as written.
const SONGS_DIR = join(__dirname, '../../../../../songs')
const files = readdirSync(SONGS_DIR).filter((f) => f.endsWith('.mkhuur.json'))

describe('bundled song library', () => {
  it('is not empty', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s parses and verifies without errors or warnings', (file) => {
    const { song, issues } = parseSong(JSON.parse(readFileSync(join(SONGS_DIR, file), 'utf8')))
    expect(issues).toEqual([])
    const report = verifySong(song!)
    const problems = [...report.songIssues, ...report.checks.flatMap((c) => c.issues)].filter((i) => i.severity !== 'info')
    expect(problems).toEqual([])
    expect(report.score).toBe(1)
  })
})
