import type { MkhuurBridge, OpenFileRequest, OpenedFile, SaveFileRequest } from '@shared/ipc'

declare global {
  interface Window {
    /** Present when running inside the Electron shell (see src/preload). */
    mkhuur?: MkhuurBridge
  }
}

/** The Electron bridge, or null when the renderer runs in a plain browser (`npm run dev:web`). */
export const bridge: MkhuurBridge | null = typeof window !== 'undefined' ? (window.mkhuur ?? null) : null

export const isDesktop = bridge !== null

export async function saveFile(req: SaveFileRequest): Promise<string | null> {
  if (bridge) return bridge.saveFile(req)
  const part: BlobPart = typeof req.data === 'string' ? req.data : new Uint8Array(req.data)
  const url = URL.createObjectURL(new Blob([part]))
  const a = document.createElement('a')
  a.href = url
  a.download = req.defaultName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return req.defaultName
}

export async function openFile(req: OpenFileRequest): Promise<OpenedFile | null> {
  if (bridge) return bridge.openFile(req)
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = [...new Set((req.filters ?? []).flatMap((f) => f.extensions.map((e) => `.${e}`)))].join(',')
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      try {
        resolve({ name: file.name, data: req.asText ? await file.text() : new Uint8Array(await file.arrayBuffer()) })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(`Could not read ${file.name}.`))
      }
    }
    input.click()
  })
}

export function openExternal(url: string): void {
  if (bridge) void bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener')
}
