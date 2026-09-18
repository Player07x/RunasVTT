import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { external: ["node:sqlite"] } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Dois preloads independentes: a interface do VTT (index) e a ponte
        // dos sites (bridge). O da ponte não importa nada além do electron,
        // então não surgem chunks compartilhados, que o sandbox não carregaria.
        input: { index: resolve(__dirname, "src/preload/index.ts"), bridge: resolve(__dirname, "src/preload/bridge.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
  },
})
