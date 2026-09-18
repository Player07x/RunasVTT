import type { VttApi } from "../shared/ipc"

declare global {
  interface Window {
    /** Ausente quando a interface roda num navegador comum (desenvolvimento). */
    vtt?: VttApi
  }
}

export {}
