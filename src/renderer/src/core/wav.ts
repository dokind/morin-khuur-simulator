/** 16-bit PCM WAV encoder. Takes plain channel arrays so it works with any AudioBuffer source. */

export interface PcmAudio {
  sampleRate: number
  channels: Float32Array[]
}

export function encodeWav({ sampleRate, channels }: PcmAudio): Uint8Array {
  const channelCount = channels.length
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = 2
  const dataSize = frames * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const s = Math.max(-1, Math.min(1, channels[c]![i]!))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      offset += 2
    }
  }
  return new Uint8Array(buffer)
}
