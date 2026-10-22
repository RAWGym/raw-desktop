// Безопасный мост между веб-приложением и Windows: только перечисленные функции, без доступа к Node.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rawDesktop', {
  isDesktop: true,
  platform: process.platform,
  notify: (title, body, route, silent) => ipcRenderer.send('raw:notify', { title, body, route, silent }),
  setBadge: (count, image) => ipcRenderer.send('raw:badge', { count, image }),
  setTheme: (bg, fg) => ipcRenderer.send('raw:theme', { bg, fg }),
  openExternal: (url) => ipcRenderer.send('raw:open-external', url),
  getAutostart: () => ipcRenderer.invoke('raw:get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('raw:set-autostart', on),
  checkUpdates: () => ipcRenderer.invoke('raw:check-updates'),
  installUpdate: () => ipcRenderer.send('raw:install-update'),
  retry: () => ipcRenderer.send('raw:retry'),
  onNavigate: (cb) => {
    const h = (_e, route) => cb(route)
    ipcRenderer.on('raw:navigate', h)
    return () => ipcRenderer.removeListener('raw:navigate', h)
  },
  onUpdate: (cb) => {
    const h = (_e, info) => cb(info)
    ipcRenderer.on('raw:update', h)
    return () => ipcRenderer.removeListener('raw:update', h)
  },
})
