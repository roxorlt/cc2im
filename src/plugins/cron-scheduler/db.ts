import Database from 'better-sqlite3'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SOCKET_DIR } from '../../shared/socket.js'
import type { CronJob, CronRun } from '../../shared/types.js'

const DB_PATH = join(SOCKET_DIR, 'cc2im.db')
const RUNS_TTL_DAYS = 30

let db: Database.Database | null = null

export function openCronDb(): Database.Database {
  if (db) return db
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('cron', 'once', 'interval')),
      schedule_value TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
      message TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'dashboard'
    );
    CREATE INDEX IF NOT EXISTS idx_cron_next ON cron_jobs(next_run) WHERE enabled = 1;

    CREATE TABLE IF NOT EXISTS cron_runs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('delivered', 'queued', 'failed')),
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_job ON cron_runs(job_id, fired_at);
  `)

  return db
}

export function closeCronDb() {
  db?.close()
  db = null
}

// --- helpers ---

function rowToJob(row: Record<string, unknown>): CronJob {
  return {
    id: row.id as string,
    name: row.name as string,
    agentId: row.agent_id as string,
    scheduleType: row.schedule_type as CronJob['scheduleType'],
    scheduleValue: row.schedule_value as string,
    timezone: row.timezone as string,
    message: row.message as string,
    enabled: row.enabled === 1,
    nextRun: (row.next_run as string) ?? null,
    createdAt: row.created_at as string,
    createdBy: row.created_by as string,
  }
}

function rowToRun(row: Record<string, unknown>): CronRun {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    firedAt: row.fired_at as string,
    status: row.status as CronRun['status'],
    detail: (row.detail as string) ?? undefined,
  }
}

// --- CRUD ---

export function createJob(
  job: Omit<CronJob, 'id' | 'createdAt'>
): CronJob {
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  openCronDb().prepare(`
    INSERT INTO cron_jobs (id, name, agent_id, schedule_type, schedule_value, timezone, message, enabled, next_run, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    job.name,
    job.agentId,
    job.scheduleType,
    job.scheduleValue,
    job.timezone,
    job.message,
    job.enabled ? 1 : 0,
    job.nextRun ?? null,
    createdAt,
    job.createdBy,
  )
  return { ...job, id, createdAt }
}

export function deleteJob(id: string): boolean {
  const result = openCronDb()
    .prepare('DELETE FROM cron_jobs WHERE id = ?')
    .run(id)
  return result.changes > 0
}

export function updateJob(
  id: string,
  updates: Partial<Pick<CronJob, 'enabled' | 'nextRun' | 'name' | 'message' | 'scheduleValue' | 'scheduleType' | 'timezone'>>
): boolean {
  const setClauses: string[] = []
  const values: unknown[] = []

  if (updates.enabled !== undefined) {
    setClauses.push('enabled = ?')
    values.push(updates.enabled ? 1 : 0)
  }
  if (updates.nextRun !== undefined) {
    setClauses.push('next_run = ?')
    values.push(updates.nextRun)
  }
  if (updates.name !== undefined) {
    setClauses.push('name = ?')
    values.push(updates.name)
  }
  if (updates.message !== undefined) {
    setClauses.push('message = ?')
    values.push(updates.message)
  }
  if (updates.scheduleValue !== undefined) {
    setClauses.push('schedule_value = ?')
    values.push(updates.scheduleValue)
  }
  if (updates.scheduleType !== undefined) {
    setClauses.push('schedule_type = ?')
    values.push(updates.scheduleType)
  }
  if (updates.timezone !== undefined) {
    setClauses.push('timezone = ?')
    values.push(updates.timezone)
  }

  if (setClauses.length === 0) return false

  values.push(id)
  const result = openCronDb()
    .prepare(`UPDATE cron_jobs SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values)
  return result.changes > 0
}

export function listJobs(agentId?: string): CronJob[] {
  const d = openCronDb()
  const rows = agentId
    ? d.prepare('SELECT * FROM cron_jobs WHERE agent_id = ? ORDER BY created_at DESC').all(agentId)
    : d.prepare('SELECT * FROM cron_jobs ORDER BY created_at DESC').all()
  return (rows as Record<string, unknown>[]).map(rowToJob)
}

export function getEnabledJobs(): CronJob[] {
  const rows = openCronDb()
    .prepare('SELECT * FROM cron_jobs WHERE enabled = 1 ORDER BY next_run ASC')
    .all()
  return (rows as Record<string, unknown>[]).map(rowToJob)
}

export function recordRun(jobId: string, status: CronRun['status'], detail?: string): string {
  const id = randomUUID()
  const firedAt = new Date().toISOString()
  openCronDb().prepare(`
    INSERT INTO cron_runs (id, job_id, fired_at, status, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, jobId, firedAt, status, detail ?? null)
  return id
}

export function getRecentRuns(jobId: string, limit = 20): CronRun[] {
  const rows = openCronDb()
    .prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY fired_at DESC LIMIT ?')
    .all(jobId, limit)
  return (rows as Record<string, unknown>[]).map(rowToRun)
}

export function cleanupRuns(): number {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - RUNS_TTL_DAYS)
  const result = openCronDb()
    .prepare('DELETE FROM cron_runs WHERE fired_at < ?')
    .run(cutoff.toISOString())
  return result.changes
}
