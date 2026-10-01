import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'

describe('encodeWav', () => {
  it('writes a valid 16-bit stereo PCM header and clamps samples', () => {
    const left = new Float32Array([0, 1, -1, 2])
    const right = new Float32Array([0, 0.5, -0.5, -2])
    const bytes = encodeWav({ sampleRate: 48000, channels: [left, right] })
    const view = new DataView(bytes.buffer)
    const text = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n))

    expect(bytes.length).toBe(44 + 4 * 2 * 2)
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 4)).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44 + 4, true)).toBe(0x7fff) // left[1]
    expect(view.getInt16(44 + 12, true)).toBe(0x7fff) // left[3] clamped
    expect(view.getInt16(44 + 14, true)).toBe(-0x8000) // right[3] clamped
  })
})
