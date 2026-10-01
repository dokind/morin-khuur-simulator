import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MkhuurBridge } from '@shared/ipc'

const bridge: MkhuurBridge = {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome },
  saveFile: (req) => ipcRenderer.invoke(IPC.saveFile, req),
  openFile: (req) => ipcRenderer.invoke(IPC.openFile, req),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url)
}

contextBridge.exposeInMainWorld('mkhuur', bridge)
