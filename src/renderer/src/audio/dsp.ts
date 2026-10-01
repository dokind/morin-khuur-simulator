import * as Tone from 'tone'
import bowedStringSource from './worklets/bowed-string.worklet.js?raw'

/**
 * Custom AudioWorklet DSP. Registered per context through the raw `audioWorklet.addModule`
 * (Tone's own `addAudioWorkletModule` caches a single module per context and would clash with
 * Tone's internal worklets). Loaded from a Blob URL, which the production CSP allows.
 */
const modules = new WeakMap<object, Promise<void>>()
const ready = new WeakSet<object>()
let moduleUrl: string | null = null

export const BOWED_STRING = 'mkhuur-bowed-string'

export function loadDsp(context: Tone.BaseContext = Tone.getContext()): Promise<void> {
  const raw = context.rawContext as unknown as { audioWorklet: AudioWorklet }
  let promise = modules.get(raw)
  if (!promise) {
    moduleUrl ??= URL.createObjectURL(new Blob([bowedStringSource], { type: 'text/javascript' }))
    promise = raw.audioWorklet.addModule(moduleUrl).then(() => void ready.add(raw))
    modules.set(raw, promise)
  }
  return promise
}

export function isDspReady(context: Tone.BaseContext = Tone.getContext()): boolean {
  return ready.has(context.rawContext)
}
