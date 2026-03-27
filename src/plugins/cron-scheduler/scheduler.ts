import { Cron } from 'croner'
import type { HubContext } from '../../shared/plugin.js'
import type { HubToSpokeMessage } from '../../shared/types.js'
import { getEnabledJobs, updateJob, recordRun, cleanupRuns } from './db.js'

const TICK_INTERVAL_MS = 10_000          // check every 10s
const CLEANUP_INTERVAL_MS = 60 * 60_000  // cleanup old runs every hour

export class CronScheduler {
  private ctx: HubContext
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(ctx: HubContext) {
    this.ctx = ctx
  }

  start() {
    this.recalcAll()
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS)
    this.cleanupTimer = setInterval(() => {
      const deleted = cleanupRuns()
      if (deleted > 0) {
        console.log(`[cron] cleaned up ${deleted} old run records`)
      }
    }, CLEANUP_INTERVAL_MS)
    console.log('[cron] scheduler started')
  }

  stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    console.log('[cron] scheduler stopped')
  }

  /**
   * Calculate next run time for a given schedule.
   * Public so hub management handler can use it when creating/updating jobs.
   */
  calcNextRun(
    type: 'cron' | 'once' | 'interval',
    value: string,
    timezone: string,
  ): string | null {
    switch (type) {
      case 'cron': {
        const job = new Cron(value, { timezone })
        const next = job.nextRun()
        return next ? next.toISOString() : null
      }
      case 'once': {
        const d = new Date(value)
        return d.getTime() > Date.now() ? d.toISOString() : null
      }
      case 'interval': {
        const ms = parseInt(value, 10)
        if (isNaN(ms) || ms <= 0) return null
        return new Date(Date.now() + ms).toISOString()
      }
      default:
        return null
    }
  }

  /**
   * Recalculate nextRun for all enabled jobs. Called on startup.
   */
  recalcAll() {
    const jobs = getEnabledJobs()
    let updated = 0
    for (const job of jobs) {
      const nextRun = this.calcNextRun(job.scheduleType, job.scheduleValue, job.timezone)
      if (nextRun !== job.nextRun) {
        updateJob(job.id, { nextRun })
        updated++
      }
    }
    if (updated > 0) {
      console.log(`[cron] recalculated nextRun for ${updated} jobs`)
    }
  }

  // --- private ---

  private tick() {
    const now = new Date().toISOString()
    const jobs = getEnabledJobs()

    for (const job of jobs) {
      if (!job.nextRun) continue
      if (job.nextRun > now) continue  // ISO string comparison works for future dates
      this.fire(job)
    }
  }

  private fire(job: import('../../shared/types.js').CronJob) {
    const msg: HubToSpokeMessage = {
      type: 'message',
      userId: `cron:${job.name}`,
      text: job.message,
      msgType: 'text',
      timestamp: new Date().toISOString(),
    }

    const delivered = this.ctx.deliverToAgent(job.agentId, msg)
    const status = delivered ? 'delivered' as const : 'queued' as const

    recordRun(job.id, status, delivered ? undefined : 'agent offline, queued for replay')
    console.log(`[cron] fired job "${job.name}" → ${job.agentId} (${status})`)

    // Recalculate next run
    let nextRun: string | null
    if (job.scheduleType === 'once') {
      // One-shot job: disable after firing
      nextRun = null
      updateJob(job.id, { nextRun, enabled: false })
    } else {
      nextRun = this.calcNextRun(job.scheduleType, job.scheduleValue, job.timezone)
      updateJob(job.id, { nextRun })
    }

    // Broadcast monitor event
    this.ctx.broadcastMonitor({
      kind: 'cron_fired',
      agentId: job.agentId,
      timestamp: new Date().toISOString(),
      userId: `cron:${job.name}`,
      text: job.message,
    })
  }
}
