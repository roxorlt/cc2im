import type { Cc2imPlugin, HubContext } from '../../shared/plugin.js'
import { openCronDb, closeCronDb } from './db.js'
import { CronScheduler } from './scheduler.js'

export function createCronSchedulerPlugin(): Cc2imPlugin {
  let scheduler: CronScheduler | null = null

  return {
    name: 'cron-scheduler',
    init(ctx: HubContext) {
      openCronDb()
      console.log('[cron-scheduler] SQLite tables ready')
      scheduler = new CronScheduler(ctx)
      scheduler.start()
    },
    destroy() {
      scheduler?.stop()
      closeCronDb()
      console.log('[cron-scheduler] Stopped')
    },
  }
}

// Re-export for hub management handler
export { createJob, deleteJob, updateJob, listJobs, getRecentRuns } from './db.js'
export { CronScheduler } from './scheduler.js'
