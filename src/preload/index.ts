import { contextBridge, ipcRenderer } from "electron"
import { IPC, type VttApi } from "../shared/ipc"

const api: VttApi = {
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
  listWorlds: () => ipcRenderer.invoke(IPC.listWorlds),
  createWorld: (input) => ipcRenderer.invoke(IPC.createWorld, input),
  openWorld: (id) => ipcRenderer.invoke(IPC.openWorld, id),
  closeWorld: () => ipcRenderer.invoke(IPC.closeWorld),
  revealWorld: (id) => ipcRenderer.invoke(IPC.revealWorld, id),
}

contextBridge.exposeInMainWorld("vtt", api)
