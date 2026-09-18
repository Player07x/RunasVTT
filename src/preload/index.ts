import { contextBridge, ipcRenderer } from "electron"
import { IPC, type BrowserState, type VttApi } from "../shared/ipc"

const api: VttApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  listWorlds: () => ipcRenderer.invoke(IPC.listWorlds),
  createWorld: (input) => ipcRenderer.invoke(IPC.createWorld, input),
  openWorld: (id) => ipcRenderer.invoke(IPC.openWorld, id),
  closeWorld: () => ipcRenderer.invoke(IPC.closeWorld),
  revealWorld: (id) => ipcRenderer.invoke(IPC.revealWorld, id),
  browser: {
    state: () => ipcRenderer.invoke(IPC.browserState),
    onState: (listener) => {
      const handler = (_event: unknown, state: BrowserState) => listener(state)
      ipcRenderer.on(IPC.browserStateChanged, handler)
      return () => { ipcRenderer.removeListener(IPC.browserStateChanged, handler) }
    },
    open: (url) => ipcRenderer.invoke(IPC.browserOpen, url),
    activate: (tabId) => ipcRenderer.invoke(IPC.browserActivate, tabId),
    close: (tabId) => ipcRenderer.invoke(IPC.browserClose, tabId),
    navigate: (tabId, url) => ipcRenderer.invoke(IPC.browserNavigate, tabId, url),
    command: (tabId, command) => ipcRenderer.invoke(IPC.browserCommand, tabId, command),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.browserSetBounds, bounds),
    setForcedOffline: (offline) => ipcRenderer.invoke(IPC.browserSetForcedOffline, offline),
    prepareOffline: () => ipcRenderer.invoke(IPC.browserPrepareOffline),
  },
}

contextBridge.exposeInMainWorld("vtt", api)
