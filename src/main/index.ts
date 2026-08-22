import { app, nativeTheme, powerMonitor, session, shell, BrowserWindow, Menu, Tray } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initAppPaths } from './app-paths'
import { initLogger, getLogger, attachWindowLogMirror } from './logger'
import { AppSettingsStore } from './settings-store'
import { SecretStore } from './secrets'
import { registerIpcHandlers } from './ipc'
import { AppUpdater } from './updater'
import { ClientRelayService } from './client-relay/service'
import { registerClientBridgeIpc } from './server/ipc-server'
import { registerServerBridgeIpc } from './server/ipc-server'
import { ServerController } from './server/controller'
import { SECRET_QBIT_API_KEY } from './server/composition'

// ---------------------------------------------------------------------------
// Window + security
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

function isDev(): boolean {
  return !!process.env['ELECTRON_RENDERER_URL']
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Viking Relay',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Electron security defaults (explicit on purpose):
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Server Mode UX: closing the window hides to tray instead of terminating
  // the relay. Actual exit goes through the tray menu / requestAppExit.
  win.on('close', (event) => {
    if (quitting || settings?.get().mode !== 'server') return
    event.preventDefault()
    win.hide()
  })

  // Reject all navigation away from the app origin. In dev, allow the Vite dev server.
  const devOrigin = process.env['ELECTRON_RENDERER_URL']
    ? new URL(process.env.ELECTRON_RENDERER_URL).origin
    : null
  win.webContents.on('will-navigate', (event, url) => {
    if (devOrigin && url.startsWith(devOrigin)) return
    if (win.webContents.getURL() === url) return
    event.preventDefault()
    getLogger().warn({ url }, 'blocked navigation attempt')
  })

  // Deny window.open entirely; validated http(s) links go to the external browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalSafe(url)
    return { action: 'deny' }
  })

  if (isDev() && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/** Only http(s) URLs may reach the OS browser handler. */
async function openExternalSafe(url: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    await shell.openExternal(url)
  } else {
    getLogger().warn({ url }, 'refused to open non-http(s) URL externally')
  }
}

function applySessionSecurity(): void {
  // Deny every permission request (mic, cam, notifications, ...). None are needed.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    getLogger().warn({ permission }, 'denied permission request')
    callback(false)
  })
}

// ---------------------------------------------------------------------------
// Theme sync (Tailwind v4 class-based dark variant)
// ---------------------------------------------------------------------------

function syncThemeClass(): void {
  const dark = nativeTheme.shouldUseDarkColors
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.executeJavaScript(
      `document.documentElement.classList.toggle('dark', ${dark ? 'true' : 'false'})`,
    ).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

function trayIconPath(): string | null {
  const candidates = [
    join(app.getAppPath(), 'build', 'icon.png'),
    app.isPackaged ? join(process.resourcesPath ?? '', 'icon.png') : ''
  ].filter((p) => p.length > 0)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function createTray(controller: ServerController | null): void {
  if (tray || process.platform !== 'win32') return
  const iconPath = trayIconPath()
  if (!iconPath) {
    getLogger().warn('tray icon unavailable')
    return
  }
  try {
    tray = new Tray(iconPath)
  } catch {
    getLogger().warn('tray icon unavailable')
    return
  }
  const menu = Menu.buildFromTemplate([
    { label: 'Open Viking Relay', click: () => mainWindow?.show() },
    {
      label: controller?.hasActiveTransfer() ? 'Status: transferring' : 'Status: idle',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
  tray.setToolTip('Viking Relay')
  tray.setContextMenu(menu)
  tray.on('double-click', () => mainWindow?.show())
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let settings: AppSettingsStore | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    const paths = initAppPaths()
    const log = initLogger(paths.logsDir, isDev())
    log.info(
      { version: app.getVersion(), electron: process.versions.electron, dev: isDev() },
      'Viking Relay starting'
    )

    settings = new AppSettingsStore(paths.settingsFile, log)
    const secrets = new SecretStore(paths.secretsFile, log)

    // Mirror warn/error logs into every window's DevTools console.
    attachWindowLogMirror(() => BrowserWindow.getAllWindows())

    const updater = new AppUpdater(log, app.getVersion())
    updater.checkOnStartup()

    registerIpcHandlers({
      store: settings,
      secrets,
      log,
      updater,
      logsDir: paths.logsDir,
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron ?? 'unknown',
        chrome: process.versions.chrome ?? 'unknown',
        node: process.versions.node ?? 'unknown'
      }
    })

    // Client Mode backend (token stays in main via safeStorage).
    const clientRelay = new ClientRelayService(settings, secrets, {
      warn: (obj, msg) => log.warn(obj, msg),
    })
    registerClientBridgeIpc(clientRelay)

    // Server Mode composition + bridge.
    let serverController: ServerController | null = null
    serverController = new ServerController({
      host: { settings, secrets, log, userDataDir: paths.userDataDir },
      requestAppExit: () => {
        // Exit confirmation for active transfers happens in the renderer UI;
        // reaching this callback means the user confirmed.
        quitting = true
        app.quit()
      }
    })
    registerServerBridgeIpc(serverController)

    // Auto-start the relay when setup is already complete so paired clients
    // reconnect on their own after an app restart (incl. tray/hidden starts).
    if (settings.get().dataDir && secrets.get(SECRET_QBIT_API_KEY)) {
      void serverController
        .startServer()
        .then((health) => {
          log.info({ online: health.online, address: health.address }, 'server auto-started')
        })
        .catch((err) => {
          log.warn({ err }, 'server auto-start failed; start it manually from the dashboard')
        })
    }

    applySessionSecurity()

    mainWindow = createMainWindow()
    createTray(serverController)
    syncThemeClass()
    nativeTheme.on('updated', syncThemeClass)

    // Release OS sleep blockers cleanly on shutdown.
    powerMonitor.on('shutdown', () => {
      quitting = true
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow()
      else mainWindow?.show()
    })
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    // Server Mode keeps running in the tray; quit only when the user asked.
    if (quitting || settings?.get().mode !== 'server') {
      app.quit()
    }
  })
}
