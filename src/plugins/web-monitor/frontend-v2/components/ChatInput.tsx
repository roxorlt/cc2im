import React, { useState } from 'react'

/**
 * Dashboard chat input — sends a message to the selected agent via POST /api/chat.
 * The message flows through the hub's web channel, so it appears in the feed
 * as message_in and the agent's reply comes back as message_out over WebSocket.
 */
export function ChatInput({ agentId }: { agentId: string }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    setError(null)
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed, agentId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      setText('')
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div style={{
      borderTop: '1px solid var(--border)',
      background: 'var(--bg-panel)',
      padding: '10px 16px',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      {error && (
        <div style={{ fontSize: 10, color: 'var(--red)' }}>发送失败：{error}</div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send()
            }
          }}
          placeholder={`发消息给 ${agentId}（Enter 发送，Shift+Enter 换行）`}
          rows={Math.min(4, Math.max(1, text.split('\n').length))}
          style={{
            flex: 1, resize: 'none',
            background: 'var(--bg-deep)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '8px 12px',
            fontSize: 12.5, lineHeight: 1.5, color: 'var(--text)',
            outline: 'none', fontFamily: 'inherit',
          }}
        />
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          style={{
            padding: '8px 18px',
            background: sending || !text.trim() ? 'var(--bg-deep)' : 'var(--accent)',
            color: sending || !text.trim() ? 'var(--text-muted)' : '#fff',
            border: '1px solid var(--border)', borderRadius: 6,
            fontSize: 12, fontWeight: 600, cursor: sending || !text.trim() ? 'default' : 'pointer',
            fontFamily: 'var(--font-mono)',
            transition: 'all 0.15s ease',
            flexShrink: 0,
          }}
        >
          {sending ? '…' : '发送'}
        </button>
      </div>
    </div>
  )
}
