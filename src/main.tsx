import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./design/tokens.css";
import "./design/base.css";
import { applyTheme } from "./lib/theme";
import { applyPanelWidth } from "./lib/panelWidth";
import App from "./App";

applyTheme();
applyPanelWidth();

// A file dropped anywhere but the chat must not navigate the window to it.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (e) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
