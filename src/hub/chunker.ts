/**
 * 消息分段发送
 * 从 cc2wx.ts:217-233 搬迁
 */

const MAX_CHUNK = 2000

export function splitIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > MAX_CHUNK) {
    let cutAt = remaining.lastIndexOf('\n\n', MAX_CHUNK)
    if (cutAt <= 0) cutAt = remaining.lastIndexOf('\n', MAX_CHUNK)
    if (cutAt <= 0) cutAt = MAX_CHUNK
    chunks.push(remaining.slice(0, cutAt))
    remaining = remaining.slice(cutAt).replace(/^\n+/, '')
  }
  if (remaining) chunks.push(remaining)

  return chunks
}

export function formatChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}]\n${chunk}`)
}
