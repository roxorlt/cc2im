import type { Cc2imPlugin, HubContext } from '../shared/plugin.js'

export class PluginManager {
  private plugins: Cc2imPlugin[] = []

  register(plugin: Cc2imPlugin) {
    this.plugins.push(plugin)
    console.log(`[plugin] Registered: ${plugin.name}`)
  }

  async initAll(ctx: HubContext) {
    for (const plugin of this.plugins) {
      try {
        await plugin.init(ctx)
        console.log(`[plugin] Initialized: ${plugin.name}`)
      } catch (err: any) {
        console.error(`[plugin] Failed to init "${plugin.name}": ${err.message}`)
      }
    }
  }

  async destroyAll() {
    for (const plugin of [...this.plugins].reverse()) {
      try {
        await plugin.destroy()
        console.log(`[plugin] Destroyed: ${plugin.name}`)
      } catch (err: any) {
        console.error(`[plugin] Failed to destroy "${plugin.name}": ${err.message}`)
      }
    }
  }
}
