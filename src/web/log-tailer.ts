/**
 * Log Tailer — watch log files and emit new lines
 */

import { watch, readFileSync, existsSync, statSync } from 'node:fs'

export class LogTailer {
  private watchers = new Map<string, ReturnType<typeof watch>>()
  private offsets = new Map<string, number>()
  private onLine: (source: string, line: string) => void

  constructor(onLine: (source: string, line: string) => void) {
    this.onLine = onLine
  }

  /** Start tailing a file. `source` is the label (e.g. "hub", "brain"). */
  tail(source: string, filePath: string) {
    if (!existsSync(filePath)) return
    if (this.watchers.has(source)) return

    // Load last 50 lines as initial context, then tail new lines
    const stat = statSync(filePath)
    const INITIAL_BYTES = Math.min(stat.size, 8192) // Read last 8KB for initial lines
    const startOffset = Math.max(0, stat.size - INITIAL_BYTES)
    try {
      const buf = Buffer.alloc(INITIAL_BYTES)
      const fd = require('fs').openSync(filePath, 'r')
      require('fs').readSync(fd, buf, 0, INITIAL_BYTES, startOffset)
      require('fs').closeSync(fd)
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim())
      for (const line of lines.slice(-50)) {
        this.onLine(source, line)
      }
    } catch {}
    this.offsets.set(source, stat.size)

    const watcher = watch(filePath, () => {
      this.readNewLines(source, filePath)
    })

    // Also poll every 2s as fallback (fs.watch can miss events)
    const interval = setInterval(() => this.readNewLines(source, filePath), 2000)

    watcher.on('close', () => clearInterval(interval))
    this.watchers.set(source, watcher)
  }

  private readNewLines(source: string, filePath: string) {
    try {
      const stat = statSync(filePath)
      const offset = this.offsets.get(source) || 0
      if (stat.size <= offset) {
        // File was truncated or no new data
        if (stat.size < offset) this.offsets.set(source, 0)
        return
      }

      const buf = Buffer.alloc(stat.size - offset)
      const fd = require('fs').openSync(filePath, 'r')
      require('fs').readSync(fd, buf, 0, buf.length, offset)
      require('fs').closeSync(fd)

      this.offsets.set(source, stat.size)

      const text = buf.toString('utf8')
      for (const line of text.split('\n')) {
        if (line.trim()) {
          this.onLine(source, line)
        }
      }
    } catch {
      // File might be rotated or deleted
    }
  }

  stop() {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }
}
