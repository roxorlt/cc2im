import Database from 'better-sqlite3'
import { join } from 'node:path'
import { SOCKET_DIR } from '../../shared/socket.js'
import { randomUUID } from 'node:crypto'

const DB_PATH = join(SOCKET_DIR, 'cc2im.db')
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000
const HISTORY_TTL_DAYS = 30
const MAX_ROWS = 100_000

let db: Database.Database | null = null

export function openDb(): Database.Database {
  if (db) return db
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      agent_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      msg_type TEXT DEFAULT 'text',
      media_path TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      expired INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending
      ON messages(agent_id, delivered_at) WHERE delivered_at IS NULL AND expired = 0;
    CREATE INDEX IF NOT EXISTS idx_created
      ON messages(created_at);
  `)

  // Idempotent column add (SQLite doesn't support IF NOT EXISTS for columns)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN channel_id TEXT`)
  } catch {
    // column already exists, ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS nicknames (
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, user_id)
    );
  `)

  return db
}

export function closeDb() {
  db?.close()
  db = null
}

export function storeInbound(
  agentId: string, userId: string, text: string, msgType: string,
  mediaPath?: string, channelId?: string,
): string {
  const id = randomUUID()
  openDb().prepare(`
    INSERT INTO messages (id, direction, agent_id, user_id, text, msg_type, media_path, channel_id, created_at)
    VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, userId, text, msgType, mediaPath ?? null, channelId ?? null, new Date().toISOString())
  return id
}

export function storeOutbound(
  agentId: string, userId: string, text: string,
  channelId?: string,
): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  openDb().prepare(`
    INSERT INTO messages (id, direction, agent_id, user_id, text, channel_id, created_at, delivered_at)
    VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?)
  `).run(id, agentId, userId, text, channelId ?? null, now, now)
  return id
}

export function markDelivered(messageId: string) {
  openDb().prepare(`UPDATE messages SET delivered_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), messageId)
}

export function getPending(agentId: string): Array<{
  id: string; userId: string; text: string; msgType: string; mediaPath: string | null; createdAt: string
}> {
  return openDb().prepare(`
    SELECT id, user_id as userId, text, msg_type as msgType, media_path as mediaPath, created_at as createdAt
    FROM messages
    WHERE agent_id = ? AND direction = 'inbound' AND delivered_at IS NULL AND expired = 0
    ORDER BY created_at ASC
  `).all(agentId) as any[]
}

export function cleanup(): { expired: number; deleted: number } {
  const d = openDb()
  const cutoff = new Date(Date.now() - DELIVERY_TTL_MS).toISOString()
  const expired = d.prepare(`
    UPDATE messages SET expired = 1
    WHERE delivered_at IS NULL AND expired = 0 AND created_at < ?
  `).run(cutoff).changes

  const histCutoff = new Date()
  histCutoff.setDate(histCutoff.getDate() - HISTORY_TTL_DAYS)
  const deleted = d.prepare(`DELETE FROM messages WHERE created_at < ?`)
    .run(histCutoff.toISOString()).changes

  const count = (d.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c
  let extraDeleted = 0
  if (count > MAX_ROWS) {
    extraDeleted = d.prepare(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages ORDER BY created_at ASC LIMIT ?
      )
    `).run(count - MAX_ROWS).changes
  }

  if (expired > 0 || deleted > 0 || extraDeleted > 0) {
    d.exec('VACUUM')
  }
  return { expired, deleted: deleted + extraDeleted }
}

export function getNicknames(): Array<{ channelId: string; userId: string; nickname: string }> {
  return openDb().prepare(
    `SELECT channel_id AS channelId, user_id AS userId, nickname FROM nicknames`
  ).all() as any[]
}

export function setNickname(channelId: string, userId: string, nickname: string): void {
  const now = new Date().toISOString()
  openDb().prepare(`
    INSERT INTO nicknames (channel_id, user_id, nickname, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id, user_id) DO UPDATE SET nickname = excluded.nickname, updated_at = excluded.updated_at
  `).run(channelId, userId, nickname, now)
}
