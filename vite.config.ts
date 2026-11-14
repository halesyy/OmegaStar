import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;
// scripts/side-by-side.sh gives each test copy a port of its own, so several can run at once.
const port = Number(process.env.OMEGA_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react()],
  // A desktop app loads its bundle from disk, so one large chunk costs nothing.
  build: { chunkSizeWarningLimit: 1000 },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
