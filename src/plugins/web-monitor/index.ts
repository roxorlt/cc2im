import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'

const DEFAULT_PORT = 3721

export function createWebMonitorPlugin(port = DEFAULT_PORT): Cc2imPlugin {
  return {
    name: 'web-monitor',
    async init(_ctx: HubContext) {
      const { startWeb } = await import('./server.js')
      await startWeb({ port })
      console.log(`[web-monitor] Dashboard at http://127.0.0.1:${port}`)
    },
    async destroy() {
      // startWeb currently manages its own lifecycle (signal handlers).
      // TODO: refactor startWeb to return a shutdown handle.
    },
  }
}
