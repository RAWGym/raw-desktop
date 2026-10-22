// RAW Management для Windows: окно с веб-приложением, трей, уведомления Windows и автообновление.
const { app, BrowserWindow, Tray, Menu, Notification, nativeImage, nativeTheme, ipcMain, shell, globalShortcut, session, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { autoUpdater } = require('electron-updater')

const APP_URL = process.env.RAW_URL || 'https://rawmngnmt.vercel.app'
const APP_ORIGIN = new URL(APP_URL).origin
const APP_ID = 'kz.raw.management'
const UPDATE_EVERY_MS = 4 * 60 * 60 * 1000
const startHidden = process.argv.includes('--hidden')

let win = null
let tray = null
let quitting = false
let updateReady = false
let unread = 0

// ---------------------------------------------------------------------------
// Один экземпляр: повторный запуск просто показывает окно
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}

app.setAppUserModelId(APP_ID)

// ---------------------------------------------------------------------------
// Размер и положение окна между запусками
// ---------------------------------------------------------------------------
const stateFile = () => path.join(app.getPath('userData'), 'window.json')

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
  } catch {
    return { width: 1320, height: 840 }
  }
}

function saveState() {
  if (!win || win.isDestroyed()) return
  const maximized = win.isMaximized()
  const bounds = maximized ? loadState() : win.getBounds()
  try {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...bounds, maximized }))
  } catch {
    /* не критично */
  }
}

// ---------------------------------------------------------------------------
// Окно
// ---------------------------------------------------------------------------
function asset(name) {
  return path.join(__dirname, 'build', name)
}

function createWindow() {
  const state = loadState()
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 920,
    minHeight: 620,
    show: false,
    title: 'RAW Management',
    icon: asset('icon.ico'),
    backgroundColor: '#f6f6f8',
    // Своя шапка в цвет темы, системные кнопки окна остаются справа.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f6f6f8', symbolColor: '#15161a', height: 40 },
    backgroundMaterial: 'mica',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      // В трее окно скрыто, но таймеры напоминаний и realtime должны работать.
      backgroundThrottling: false,
    },
  })
  if (state.maximized) win.maximize()

  win.loadURL(APP_URL)

  win.once('ready-to-show', () => {
    if (!startHidden) win.show()
  })

  // Нет интернета — показываем страницу с повтором.
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: url || APP_URL } })
    if (!win.isVisible() && !startHidden) win.show()
  })

  // Ссылки на другие сайты и файлы — в обычном браузере.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && url !== 'about:blank') shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && !url.startsWith('file:')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })

  // Контекстное меню для полей ввода и текста.
  win.webContents.on('context-menu', (_e, params) => {
    const items = []
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions.slice(0, 4)) items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) })
      if (items.length) items.push({ type: 'separator' })
    }
    if (params.isEditable) {
      items.push({ label: 'Вырезать', role: 'cut', enabled: params.editFlags.canCut })
      items.push({ label: 'Копировать', role: 'copy', enabled: params.editFlags.canCopy })
      items.push({ label: 'Вставить', role: 'paste', enabled: params.editFlags.canPaste })
      items.push({ type: 'separator' }, { label: 'Выделить всё', role: 'selectAll' })
    } else if (params.selectionText) {
      items.push({ label: 'Копировать', role: 'copy' })
    } else if (params.linkURL) {
      items.push({ label: 'Открыть ссылку в браузере', click: () => shell.openExternal(params.linkURL) })
    }
    if (items.length) Menu.buildFromTemplate(items).popup()
  })

  // Крестик сворачивает в трей — уведомления продолжают приходить.
  win.on('close', (e) => {
    saveState()
    if (!quitting) {
      e.preventDefault()
      win.hide()
      maybeHintTray()
    }
  })
  win.on('resize', debounce(saveState, 500))
  win.on('move', debounce(saveState, 500))
  win.on('focus', () => win.flashFrame(false))
}

let trayHintShown = false
function maybeHintTray() {
  if (trayHintShown || !Notification.isSupported()) return
  trayHintShown = true
  new Notification({ title: 'RAW работает в фоне', body: 'Уведомления продолжат приходить. Открыть — значок RAW возле часов.', icon: asset('icon.png'), silent: true }).show()
}

function showWindow(route) {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (route) win.webContents.send('raw:navigate', route)
}

function toggleWindow() {
  if (!win) return
  if (win.isVisible() && win.isFocused()) win.hide()
  else showWindow()
}

// ---------------------------------------------------------------------------
// Трей
// ---------------------------------------------------------------------------
function trayIcon() {
  const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors
  return nativeImage.createFromPath(asset(dark ? 'tray-light.png' : 'tray.png')).resize({ width: 16, height: 16 })
}

function buildTrayMenu() {
  const autostart = app.getLoginItemSettings().openAtLogin
  return Menu.buildFromTemplate([
    { label: 'Открыть RAW', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Новая задача', click: () => showWindow('/tasks?new=1') },
    { label: `Чат${unread ? ` (${unread})` : ''}`, click: () => showWindow('/chat') },
    { label: 'Календарь', click: () => showWindow('/calendar') },
    { type: 'separator' },
    { label: 'Запускать вместе с Windows', type: 'checkbox', checked: autostart, click: (i) => setAutostart(i.checked) },
    updateReady ? { label: 'Перезапустить и обновить', click: installUpdate } : { label: 'Проверить обновления', click: () => checkUpdates(true) },
    { label: `Версия ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Выйти',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('RAW Management')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', toggleWindow)
  nativeTheme.on('updated', () => tray && tray.setImage(trayIcon()))
}

function refreshTray() {
  if (!tray) return
  tray.setContextMenu(buildTrayMenu())
  tray.setToolTip(unread ? `RAW Management — непрочитанных: ${unread}` : 'RAW Management')
}

function setAutostart(on) {
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] })
  refreshTray()
  return app.getLoginItemSettings().openAtLogin
}

// ---------------------------------------------------------------------------
// Автообновление (GitHub Releases публичного репозитория raw-desktop)
// ---------------------------------------------------------------------------
function setupUpdates() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true
    refreshTray()
    win?.webContents.send('raw:update', { status: 'ready', version: info.version })
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Обновление RAW готово', body: `Версия ${info.version}. Нажмите, чтобы перезапустить.`, icon: asset('icon.png') })
      n.on('click', installUpdate)
      n.show()
    }
  })
  autoUpdater.on('update-available', (info) => win?.webContents.send('raw:update', { status: 'downloading', version: info.version }))
  autoUpdater.on('error', (err) => win?.webContents.send('raw:update', { status: 'error', message: String(err?.message ?? err) }))
  checkUpdates(false)
  setInterval(() => checkUpdates(false), UPDATE_EVERY_MS)
}

async function checkUpdates(manual) {
  if (!app.isPackaged) {
    if (manual) dialog.showMessageBox({ message: 'Обновления проверяются только в установленной версии.' })
    return { status: 'dev' }
  }
  try {
    const r = await autoUpdater.checkForUpdates()
    const latest = r?.updateInfo?.version
    const has = latest && latest !== app.getVersion()
    if (manual && !has) dialog.showMessageBox({ message: `У вас последняя версия (${app.getVersion()}).` })
    return { status: has ? 'downloading' : 'latest', version: latest }
  } catch (err) {
    if (manual) dialog.showMessageBox({ type: 'warning', message: 'Не удалось проверить обновления', detail: String(err?.message ?? err) })
    return { status: 'error', message: String(err?.message ?? err) }
  }
}

function installUpdate() {
  quitting = true
  autoUpdater.quitAndInstall(true, true)
}

// ---------------------------------------------------------------------------
// Мост с веб-приложением
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.on('raw:notify', (_e, { title, body, route, silent }) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title: String(title ?? 'RAW'), body: String(body ?? ''), icon: asset('icon.png'), silent: !!silent })
    n.on('click', () => showWindow(route))
    n.show()
    if (win && !win.isFocused()) win.flashFrame(true)
  })

  ipcMain.on('raw:badge', (_e, { count, image }) => {
    unread = Number(count) || 0
    if (win) {
      if (unread && image) win.setOverlayIcon(nativeImage.createFromDataURL(image), `${unread} непрочитанных`)
      else win.setOverlayIcon(null, '')
    }
    refreshTray()
  })

  ipcMain.on('raw:theme', (_e, { bg, fg }) => {
    if (!win) return
    try {
      win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 40 })
      win.setBackgroundColor(bg)
    } catch {
      /* старые Windows */
    }
  })

  ipcMain.on('raw:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:/.test(url)) shell.openExternal(url)
  })

  ipcMain.handle('raw:get-autostart', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('raw:set-autostart', (_e, on) => setAutostart(!!on))
  ipcMain.handle('raw:check-updates', () => checkUpdates(false))
  ipcMain.on('raw:install-update', installUpdate)
  ipcMain.on('raw:retry', () => win?.loadURL(APP_URL))
}

// ---------------------------------------------------------------------------
// Разрешения: микрофон для голосовых и уведомления — только для нашего сайта
// ---------------------------------------------------------------------------
function setupPermissions() {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const url = wc.getURL()
    const ours = url.startsWith(APP_ORIGIN)
    callback(ours && ['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen'].includes(permission))
  })
}

function debounce(fn, ms) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

app.whenReady().then(() => {
  setupPermissions()
  setupIpc()
  createWindow()
  createTray()
  setupUpdates()
  // Ctrl+Shift+R — показать/спрятать RAW из любого приложения.
  globalShortcut.register('CommandOrControl+Shift+R', toggleWindow)
})

app.on('before-quit', () => {
  quitting = true
  saveState()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => {
  /* остаёмся в трее */
})
