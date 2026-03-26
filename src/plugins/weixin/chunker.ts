/**
 * 结构感知的消息分段
 *
 * 设计原则：
 * 1. 以「块」为原子单位 — 代码围栏、表格、列表等结构不在内部切割
 * 2. 安全长度低于 SDK 的 2000 硬切，避免双重分段
 * 3. 对未知内容类型有兜底 — 不依赖穷举所有格式
 */

// SDK chunkText 硬切在 2000，[1/N]\n 前缀占约 10 字符，留足余量
const MAX_CHUNK = 1800

/** 块类型 */
interface Block {
  text: string
  /** 是否为不可分割的结构块（代码围栏、表格） */
  atomic: boolean
}

/**
 * 将文本解析为结构块。
 * 识别：代码围栏 (```)、表格 (|--|)、空行分隔的段落。
 * 不识别的内容按空行分段 — 兜底而非穷举。
 */
function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let current: string[] = []
  let inCodeFence = false
  let inTable = false

  function flush(atomic = false) {
    if (current.length > 0) {
      blocks.push({ text: current.join('\n'), atomic })
      current = []
    }
  }

  for (const line of lines) {
    // 代码围栏开关
    if (/^```/.test(line.trimStart())) {
      if (!inCodeFence) {
        // 进入代码块：先 flush 之前的段落
        flush()
        inCodeFence = true
        current.push(line)
      } else {
        // 代码块结束
        current.push(line)
        inCodeFence = false
        flush(true)
      }
      continue
    }

    if (inCodeFence) {
      current.push(line)
      continue
    }

    // 表格检测：连续的 | 开头行
    const isTableLine = /^\|/.test(line.trimStart())
    if (isTableLine && !inTable) {
      flush()
      inTable = true
      current.push(line)
      continue
    }
    if (inTable && isTableLine) {
      current.push(line)
      continue
    }
    if (inTable && !isTableLine) {
      inTable = false
      flush(true)
      // fall through to handle current line
    }

    // 空行 → 段落分隔
    if (line.trim() === '') {
      if (current.length > 0) {
        // 保留空行作为段落间距
        current.push(line)
        flush()
      }
      continue
    }

    current.push(line)
  }

  // 未闭合的代码围栏也要 flush（兜底）
  flush(inCodeFence)

  return blocks
}

/**
 * 按块累积分段。
 * - 尽量在块边界切割
 * - 原子块超长时退化为行级切割
 * - 单行超长时硬切（最终兜底）
 */
export function splitIntoChunks(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text]

  const blocks = parseBlocks(text)
  const chunks: string[] = []
  let buffer = ''

  function pushBuffer() {
    const trimmed = buffer.replace(/\n+$/, '')
    if (trimmed) chunks.push(trimmed)
    buffer = ''
  }

  for (const block of blocks) {
    // 块能整体放入当前 buffer
    if (buffer.length + block.text.length + 1 <= MAX_CHUNK) {
      buffer += (buffer ? '\n' : '') + block.text
      continue
    }

    // 放不下 — 先 flush buffer
    pushBuffer()

    // 块本身不超限 → 直接作为新 buffer
    if (block.text.length <= MAX_CHUNK) {
      buffer = block.text
      continue
    }

    // 超长块 — 退化为行级切割
    const lines = block.text.split('\n')
    for (const line of lines) {
      if (buffer.length + line.length + 1 <= MAX_CHUNK) {
        buffer += (buffer ? '\n' : '') + line
      } else {
        pushBuffer()
        // 单行超长 — 硬切兜底
        if (line.length > MAX_CHUNK) {
          let remaining = line
          while (remaining.length > MAX_CHUNK) {
            chunks.push(remaining.slice(0, MAX_CHUNK))
            remaining = remaining.slice(MAX_CHUNK)
          }
          buffer = remaining
        } else {
          buffer = line
        }
      }
    }
  }

  pushBuffer()
  return chunks
}

export function formatChunks(chunks: string[]): string[] {
  if (chunks.length <= 1) return chunks
  return chunks.map((chunk, i) => `[${i + 1}/${chunks.length}]\n${chunk}`)
}
