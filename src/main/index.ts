import { app, BrowserWindow, nativeImage, session, shell, Tray, Menu, nativeTheme } from 'electron'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { AppContext, resolvePaths } from './context'
import { createServices, type Services } from './services'
import { registerHandlers } from './ipc/handlers'
import { APP_NAME } from '@shared/defaults'

// node:sqlite is still flagged experimental in Node 22; silence the one-line warning in production logs.
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return
  console.warn(w)
})

let ctx: AppContext | null = null
let services: Services | null = null
let tray: Tray | null = null
let quitting = false

const isDev = !app.isPackaged
const resourcesDir = isDev ? join(process.cwd(), 'resources') : process.resourcesPath

// Isolated user-data directory for automated (e2e) runs. Must be set before the single-instance
// lock and `ready`, because both derive from the userData path.
if (process.env.MINUTES_USER_DATA) app.setPath('userData', process.env.MINUTES_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = ctx?.mainWindow
    if (w) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
  })
}

app.setAppUserModelId('com.dexteritydesign.minutes')

function createMainWindow(): BrowserWindow {
  const settings = ctx!.settings.get()
  const bounds = ctx!.settings.getValue<{ x?: number; y?: number; width: number; height: number; maximized?: boolean }>('windowBounds', { width: 1180, height: 760 })
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: APP_NAME,
    backgroundColor: nativeTheme.shouldUseDarkColors && settings.theme !== 'light' ? '#1c1b19' : '#fbfaf7',
    titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset',
    titleBarOverlay: process.platform === 'win32' ? { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#d6d2c9' : '#4a4740', height: 38 } : undefined,
    icon: existsSync(join(resourcesDir, '..', 'build', 'icon.png')) ? join(resourcesDir, '..', 'build', 'icon.png') : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      backgroundThrottling: false // keep audio capture + timers steady when minimized
    }
  })
  ctx!.mainWindow = win
  services!.shortcuts.attach(win)

  if (bounds.maximized) win.maximize()
  win.once('ready-to-show', () => {
    if (!(settings.startMinimized && process.argv.includes('--hidden'))) win.show()
  })

  const persistBounds = (): void => {
    if (win.isDestroyed()) return
    const b = win.getNormalBounds()
    ctx!.settings.setValue('windowBounds', { ...b, maximized: win.isMaximized() })
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('maximize', () => ctx!.emit('windowState', { maximized: true, focused: win.isFocused() }))
  win.on('unmaximize', () => ctx!.emit('windowState', { maximized: false, focused: win.isFocused() }))
  win.on('focus', () => ctx!.emit('windowState', { maximized: win.isMaximized(), focused: true }))
  win.on('blur', () => ctx!.emit('windowState', { maximized: win.isMaximized(), focused: false }))

  win.on('close', (e) => {
    // Never let a window close interrupt an in-progress recording silently: ask the renderer to stop.
    const rec = services?.recording.getState()
    if (!quitting && rec && (rec.status === 'recording' || rec.status === 'paused')) {
      e.preventDefault()
      ctx!.emit('captureCommand', { command: 'stop', noteId: rec.noteId ?? undefined })
      win.webContents.send('evt:log', { level: 'info', message: 'Recording stopped before closing.' })
      setTimeout(() => {
        quitting = true
        win.close()
      }, 1500)
      return
    }
    persistBounds()
  })
  win.on('closed', () => {
    if (ctx) ctx.mainWindow = null
  })

  // Security: no navigation away from the app, external links open in the OS browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

function configureSession(): void {
  const ses = session.defaultSession
  const devHosts = isDev ? " http://localhost:* ws://localhost:* http://127.0.0.1:*" : ''
  const csp = [
    "default-src 'self'",
    `script-src 'self' blob:${devHosts}`,
    `style-src 'self' 'unsafe-inline'`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${devHosts}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })

  // Only microphone + display capture (for system-audio loopback) are ever granted.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || (permission as string) === 'display-capture')

  // System audio: on Windows, Chromium's WASAPI loopback is exposed through getDisplayMedia with audio:'loopback'.
  // Chromium insists that a getDisplayMedia request carries video, and answering with audio only makes the
  // request fail with AbortError (seen on the first Windows installation, 2026-10-20). The cheapest video
  // source Electron accepts is the requesting web frame itself — no screen capture, no picker — and the
  // renderer stops that video track the moment the stream arrives, so only the loopback audio is kept.
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      if (process.platform === 'win32') callback({ video: request.frame ?? undefined, audio: 'loopback' })
      else callback({})
    },
    { useSystemPicker: false }
  )
}

function createTray(): void {
  const iconPath = join(resourcesDir, process.platform === 'win32' ? 'tray-icon-16.png' : 'tray-icon.png')
  if (!existsSync(iconPath)) return
  tray = new Tray(nativeImage.createFromPath(iconPath))
  tray.setToolTip(APP_NAME)
  const show = (): void => {
    const w = ctx?.mainWindow ?? createMainWindow()
    w.show()
    w.focus()
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_NAME}`, click: show },
      { label: 'New Note', click: () => { show(); ctx?.emit('shortcut', 'note.new') } },
      { label: 'Start / Stop Recording', click: () => { show(); ctx?.emit('shortcut', 'rec.toggle') } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit() } }
    ])
  )
  tray.on('click', show)
}

export function setTrayRecording(active: boolean): void {
  if (!tray) return
  const name = active ? 'tray-icon-recording' : 'tray-icon'
  const p = join(resourcesDir, process.platform === 'win32' ? `${name}-16.png` : `${name}.png`)
  if (existsSync(p)) tray.setImage(nativeImage.createFromPath(p))
}

app.whenReady().then(() => {
  const paths = resolvePaths()
  ctx = new AppContext(paths)
  services = createServices(ctx)
  ctx.log.info('startup', { version: app.getVersion(), electron: process.versions.electron, db: paths.database })

  configureSession()
  registerHandlers(ctx, services)
  services.transcription.on('liveStatus', (st) => ctx!.emit('transcriptionStatus', st))
  services.transcription.on('jobs', (jobs) => ctx!.emit('jobsChanged', jobs))
  services.transcription.on('models', (models) => ctx!.emit('modelsChanged', models))
  services.transcription.kickJobs()
  services.shortcuts.apply()
  services.recording.cleanupTemp()
  const purged = ctx.notes.purgeExpiredTrash()
  if (purged) ctx.log.info('purged expired trash', { purged })

  services.backup.onRestoreApplied = () => {
    quitting = true
    app.relaunch()
    app.exit(0)
  }

  // Tray reflects recording state.
  const origEmit = ctx.emit.bind(ctx)
  ctx.emit = (name, payload) => {
    if (name === 'recordingState') setTrayRecording((payload as { status: string }).status === 'recording')
    origEmit(name, payload)
  }

  createMainWindow()
  createTray()
  services.calendar.startAutoRefresh()
  services.updater.startBackgroundChecks()

  // Nightly-style safety: an automatic backup at most once per day on launch, pruned to the last 10.
  const lastAuto = ctx.settings.getValue<number>('lastAutoBackupAt', 0)
  if (Date.now() - lastAuto > 86_400_000 && ctx.notes.counts().all > 0) {
    try {
      services.backup.create('auto')
      services.backup.prune(10)
      ctx.settings.setValue('lastAutoBackupAt', Date.now())
    } catch (err) {
      ctx.log.error('auto backup failed', err)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // Windows/Linux: keep running in the tray only while a recording is active; otherwise quit.
  const rec = services?.recording.getState()
  if (process.platform !== 'darwin' && !(rec && rec.status === 'recording')) app.quit()
})

app.on('will-quit', () => {
  services?.shortcuts.dispose()
  services?.calendar.stop()
  services?.updater.stop()
  void services?.recording.end('quit')
  void services?.transcription.shutdown()
  try {
    ctx?.close()
  } catch {
    /* ignore */
  }
})
