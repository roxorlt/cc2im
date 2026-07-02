/**
 * Pure formatters for the channel health block. Kept dependency-free and
 * separate from React so they can be unit-tested without a DOM.
 */

/** Relative time like "12s 前" / "3m 前" / "2h 前" / "刚刚"; undefined → "—". */
export function relativeTime(iso: string | undefined, nowMs: number): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return '—'
  const diff = Math.max(0, nowMs - t)
  const sec = Math.floor(diff / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec}s 前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m 前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h 前`
  const day = Math.floor(hr / 24)
  return `${day}d 前`
}

/** Human duration for connectedSince → "已连接 2h 13m"; undefined → "—". */
export function uptimeLabel(connectedSince: string | undefined, nowMs: number): string {
  if (!connectedSince) return '—'
  const t = Date.parse(connectedSince)
  if (Number.isNaN(t)) return '—'
  const sec = Math.max(0, Math.floor((nowMs - t) / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export type HealthLevel = 'ok' | 'warn' | 'bad'

/** Traffic-light level from health counters — drives the dot color. */
export function healthLevel(h: {
  status: string
  consecutiveErrors: number
  stallCount: number
}): HealthLevel {
  if (h.status === 'expired' || h.status === 'disconnected') return 'bad'
  if (h.consecutiveErrors >= 3 || h.stallCount > 0) return 'warn'
  return 'ok'
}
