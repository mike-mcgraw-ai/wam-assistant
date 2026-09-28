import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import { screensPage } from './tools/screens-plugin'

/**
 * The app's own version, baked in from app.json.
 *
 * Shown on the glasses so there is never any doubt about which build is
 * actually running. Packing without uploading, or uploading without
 * reinstalling, both look identical from the outside otherwise.
 */
const APP_VERSION = JSON.parse(readFileSync(new URL('./app.json', import.meta.url), 'utf8')).version

/**
 * LAN_IP matters for QR sideload: the phone fetches from your laptop, so the
 * dev server has to listen on every interface and HMR has to advertise the LAN
 * address. Left unset, HMR tells the phone to connect to "localhost" — which is
 * the phone itself, and the page loads once then never updates.
 *
 *   LAN_IP=$(ipconfig getifaddr en0) npm run dev
 */
const LAN_IP = process.env.LAN_IP

export default defineConfig({
  // Every screen as real pixels at http://localhost:5173/screens.html.
  // Dev server only (`apply: 'serve'`); the build never sees it.
  plugins: [screensPage()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    hmr: LAN_IP ? { host: LAN_IP, protocol: 'ws' } : undefined,
  },
  build: {
    target: 'es2022',
    // One file keeps the .ehpk small and the BLE install quick.
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
})
