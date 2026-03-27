import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'

const DEFAULT_PORT = 3721

export function createWebMonitorPlugin(port = DEFAULT_PORT): Cc2imPlugin {
  return {
    name: 'web-monitor',
    async init(ctx: HubContext) {
      try {
        const { startWeb } = await import('./server.js')
        await startWeb({ port, ctx })
        console.log(`[web-monitor] Dashboard at http://127.0.0.1:${port}`)
      } catch (err: any) {
        // Don't crash the hub if web server fails to start (e.g., port in use)
        console.error(`[web-monitor] Failed to start: ${err.message}`)
      }
    },
    async destroy() {
      // startWeb currently manages its own lifecycle (signal handlers).
      // TODO: refactor startWeb to return a shutdown handle.
    },
  }
}
