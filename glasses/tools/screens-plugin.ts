/**
 * Dev-server half of the screens page (screens.html). Serve only: nothing here
 * runs during `vite build`, so nothing here can reach the packed .ehpk.
 *
 *   GET /__screens/demo?now=<ms>   every demo frame, rendered by the real
 *                                  render() in Node with the clock held at `now`
 *   GET /__screens/live            the frame the glasses are showing right
 *                                  now, from the hub's /screen mirror
 *
 * The demo frames are rendered here rather than in the browser because the
 * demo state is built from the server's own modules, which need node:fs. The
 * browser gets text and turns it into pixels with the real compactdisplay.ts.
 *
 * Reloading: a change to anything the demo imports (render.ts, format.ts, the
 * server modules, the config JSON) pushes `wam-screens:stale` and the page
 * re-fetches in place. If the same file is also loaded by the app in a browser
 * or on the glasses through QR sideload, Vite's normal reload still happens.
 */
import type { Plugin, ViteDevServer } from 'vite'
import { join } from 'node:path'

/** Where the hub is, from the Mac's point of view. Not the phone's. */
const HUB = (process.env.WAM_LOCAL_HUB || 'http://127.0.0.1:8787').replace(/\/+$/, '')

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Run `fn` with the wall clock held at `at`.
 *
 * render() reads `new Date()` for the header clock and task windows. Holding it
 * still means a frame changes only when the code does, which is what makes the
 * page's change highlighting worth looking at. Safe because `fn` is fully
 * synchronous: nothing else in this process can run until Date is put back.
 */
function atClock<T>(at: number, fn: () => T): T {
  const RealDate = Date
  class HeldDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(at)
      else super(...(args as [string | number | Date]))
    }
    static now(): number {
      return at
    }
  }
  globalThis.Date = HeldDate as DateConstructor
  try {
    return fn()
  } finally {
    globalThis.Date = RealDate
  }
}

export function screensPage(): Plugin {
  let server: ViteDevServer
  let demoEntry = ''
  /** files the demo's SSR graph pulled in, refreshed on every demo request */
  const demoFiles = new Set<string>()
  /** files a browser (the app, or this page) has asked for */
  const clientFiles = new Set<string>()

  function collectDemoFiles(): void {
    const start = server.moduleGraph.getModulesByFile(demoEntry)
    const seen = new Set<unknown>()
    const walk = (mod: any) => {
      if (!mod || seen.has(mod)) return
      seen.add(mod)
      if (mod.file) demoFiles.add(mod.file)
      for (const dep of mod.ssrImportedModules ?? mod.importedModules ?? []) walk(dep)
    }
    for (const mod of start ?? []) walk(mod)
  }

  return {
    name: 'wam-screens-page',
    apply: 'serve',

    configureServer(devServer) {
      server = devServer
      demoEntry = join(server.config.root, 'tools', 'demo-screens.ts')

      server.middlewares.use('/__screens/demo', async (req, res) => {
        try {
          const url = new URL(req.url ?? '', 'http://x')
          const asked = Number(url.searchParams.get('now'))
          const now = Number.isFinite(asked) && asked > 0 ? asked : Date.now()
          const mod = await server.ssrLoadModule(demoEntry)
          const screens = atClock(now, () => mod.demoScreens(now))
          collectDemoFiles()
          send(res, 200, { now, screens })
        } catch (err) {
          if (err instanceof Error) server.ssrFixStacktrace(err)
          send(res, 500, { error: err instanceof Error ? err.stack || err.message : String(err) })
        }
      })

      server.middlewares.use('/__screens/live', async (_req, res) => {
        try {
          const hubRes = await fetch(`${HUB}/screen`, { signal: AbortSignal.timeout(1500) })
          if (!hubRes.ok) throw new Error(`hub answered ${hubRes.status}`)
          const frame = (await hubRes.json()) as { text?: string; at?: number }
          send(res, 200, { hub: HUB, text: frame.text ?? '', at: frame.at ?? 0 })
        } catch (err) {
          send(res, 200, { hub: HUB, error: err instanceof Error ? err.message : String(err) })
        }
      })
    },

    transform(_code, id, options) {
      if (!options?.ssr) clientFiles.add(id.split('?')[0])
      return null
    },

    handleHotUpdate(ctx) {
      if (!demoFiles.has(ctx.file)) return
      ctx.server.ws.send({ type: 'custom', event: 'wam-screens:stale', data: { file: ctx.file } })
      // Only the demo uses this file: re-fetching in place is the whole update,
      // and Vite's fallback would be a full reload that throws away the scroll
      // position. Anything a browser also loaded keeps Vite's normal handling.
      if (!clientFiles.has(ctx.file)) return []
    },
  }
}
