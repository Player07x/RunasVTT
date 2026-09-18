import { contextBridge, ipcRenderer } from "electron"
import { IPC, type BrowserState, type DocumentChange, type PlayerState, type VttApi } from "../shared/ipc"

const api: VttApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  listWorlds: () => ipcRenderer.invoke(IPC.listWorlds),
  createWorld: (input) => ipcRenderer.invoke(IPC.createWorld, input),
  openWorld: (id) => ipcRenderer.invoke(IPC.openWorld, id),
  closeWorld: () => ipcRenderer.invoke(IPC.closeWorld),
  revealWorld: (id) => ipcRenderer.invoke(IPC.revealWorld, id),
  documents: {
    list: (type, parentId) => ipcRenderer.invoke(IPC.documentsList, type, parentId),
    put: (input) => ipcRenderer.invoke(IPC.documentsPut, input),
    remove: (id) => ipcRenderer.invoke(IPC.documentsDelete, id),
    onChange: (listener) => {
      const handler = (_event: unknown, change: DocumentChange) => listener(change)
      ipcRenderer.on(IPC.documentsChanged, handler)
      return () => { ipcRenderer.removeListener(IPC.documentsChanged, handler) }
    },
  },
  table: {
    report: (state) => ipcRenderer.invoke(IPC.tableReport, state),
  },
  player: {
    state: () => ipcRenderer.invoke(IPC.playerState),
    onState: (listener) => {
      const handler = (_event: unknown, state: PlayerState) => listener(state)
      ipcRenderer.on(IPC.playerStateChanged, handler)
      return () => { ipcRenderer.removeListener(IPC.playerStateChanged, handler) }
    },
    displays: () => ipcRenderer.invoke(IPC.playerDisplays),
    start: (port) => ipcRenderer.invoke(IPC.playerStart, port),
    stop: () => ipcRenderer.invoke(IPC.playerStop),
    openWindow: () => ipcRenderer.invoke(IPC.playerOpenWindow),
    setScene: (sceneId) => ipcRenderer.invoke(IPC.playerSetScene, sceneId),
    setFollowMaster: (follow) => ipcRenderer.invoke(IPC.playerSetFollowMaster, follow),
    pullCamera: () => ipcRenderer.invoke(IPC.playerPullCamera),
    setBars: (bars) => ipcRenderer.invoke(IPC.playerSetBars, bars),
    publicLink: () => ipcRenderer.invoke(IPC.playerPublicLink),
    downloadCloudflared: () => ipcRenderer.invoke(IPC.playerDownloadCloudflared),
  },
  assets: {
    import: (kind, fileName, bytes) => ipcRenderer.invoke(IPC.assetsImport, kind, fileName, bytes),
  },
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
