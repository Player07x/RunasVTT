import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { PlayerView } from "./PlayerView"
import "./styles.css"

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode><PlayerView /></StrictMode>)
