import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { IPC, type OpenFileRequest, type OpenedFile, type SaveFileRequest } from '@shared/ipc'
import { PROJECT_REPO_URL, UNESCO_URL } from '@shared/project'

// An instrument must respond the instant a key is pressed; don't wait for a user gesture
// before the AudioContext is allowed to start.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f0d0b',
    title: 'Morin Khuur Simulator',
    autoHideMenuBar: true,
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Never open new Electron windows; hand http(s) links to the user's browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Only accept IPC from our own top-level page. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('Untrusted IPC sender')
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.saveFile, async (event, req: SaveFileRequest): Promise<string | null> => {
    assertTrustedSender(event)
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: req.title,
      defaultPath: req.defaultName,
      filters: req.filters
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, typeof req.data === 'string' ? req.data : Buffer.from(req.data))
    return result.filePath
  })

  ipcMain.handle(IPC.openFile, async (event, req: OpenFileRequest): Promise<OpenedFile | null> => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: req.title,
      filters: req.filters,
      properties: ['openFile']
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return null
    const data = req.asText ? await readFile(path, 'utf8') : new Uint8Array(await readFile(path))
    return { name: basename(path), data }
  })

  ipcMain.handle(IPC.openExternal, async (event, url: string) => {
    assertTrustedSender(event)
    if (/^https:\/\//.test(url)) await shell.openExternal(url)
  })
}

function configurePermissions(): void {
  // Web MIDI lets musicians play the simulator from a MIDI keyboard. Nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'midi')
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'midi')
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'fileMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as const))
      ]
    },
    {
      label: 'Help',
      submenu: [
        ...(PROJECT_REPO_URL
          ? [{ label: 'Open-source project', click: () => void shell.openExternal(PROJECT_REPO_URL) }]
          : []),
        { label: 'UNESCO: Traditional music of the Morin Khuur', click: () => void shell.openExternal(UNESCO_URL) }
      ]
    }
  ]
  if (process.platform === 'darwin') template.unshift({ role: 'appMenu' })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('mn.morinkhuur.simulator')
    configurePermissions()
    registerIpc()
    buildMenu()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
