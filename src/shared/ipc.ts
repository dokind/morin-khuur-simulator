/**
 * Contract between the Electron main process, the preload bridge and the renderer.
 * The renderer never touches Node APIs directly; everything goes through `window.mkhuur`.
 */

export const IPC = {
  saveFile: 'file:save',
  openFile: 'file:open',
  openExternal: 'shell:open-external'
} as const

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface SaveFileRequest {
  title?: string
  defaultName: string
  filters?: FileFilter[]
  /** Raw bytes (WAV, MIDI) or UTF-8 text (JSON). */
  data: Uint8Array | string
}

export interface OpenFileRequest {
  title?: string
  filters?: FileFilter[]
  /** Return file contents as UTF-8 text instead of bytes. */
  asText?: boolean
}

export interface OpenedFile {
  name: string
  data: Uint8Array | string
}

export interface MkhuurBridge {
  platform: string
  versions: { electron: string; chrome: string }
  /** Resolves to the saved path, or null if the user cancelled. */
  saveFile(req: SaveFileRequest): Promise<string | null>
  /** Resolves to the chosen file, or null if the user cancelled. */
  openFile(req: OpenFileRequest): Promise<OpenedFile | null>
  openExternal(url: string): Promise<void>
}
