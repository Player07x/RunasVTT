// Gera build/icon.png (512×512) a partir da runa "R" da interface.
// Uso: npx electron scripts/make-icon.cjs
const { app, BrowserWindow } = require("electron")
const { mkdirSync, writeFileSync } = require("node:fs")
const { join } = require("node:path")

const html = `<!doctype html><html><body style="margin:0;background:transparent">
<div style="width:512px;height:512px;display:grid;place-items:center">
  <div style="width:448px;height:448px;border-radius:50%;display:grid;place-items:center;
    background:radial-gradient(circle at 50% 40%, #2a2426, #0d0b0c 72%);
    border:14px solid #82aaa6;box-shadow:inset 0 0 90px rgba(130,170,166,.35);
    color:#82aaa6;font:700 250px 'Cascadia Mono','Consolas',monospace;line-height:1">R</div>
</div></body></html>`

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } })
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const directory = join(__dirname, "..", "build")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "icon.png"), image.resize({ width: 512, height: 512 }).toPNG())
  console.log("build/icon.png gerado")
  app.quit()
})
