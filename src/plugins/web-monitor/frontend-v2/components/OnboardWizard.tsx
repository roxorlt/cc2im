import React, { useState } from 'react'

/**
 * Onboard a local directory as a cc2im agent: writes .mcp.json + registers
 * in agents.json (+ optionally starts it now). POSTs /api/onboard.
 */
export function OnboardWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [cwd, setCwd] = useState('')
  const [name, setName] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [startNow, setStartNow] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameEdited, setNameEdited] = useState(false)

  // Auto-fill agent name from the directory's last path segment until user edits it.
  const onCwdChange = (v: string) => {
    setCwd(v)
    if (!nameEdited) {
      const seg = v.replace(/\/+$/, '').split('/').pop() || ''
      setName(seg.replace(/[^A-Za-z0-9一-龥._-]/g, '-').slice(0, 64))
    }
  }

  const submit = async () => {
    if (!cwd.trim() || !name.trim() || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/onboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), cwd: cwd.trim(), autoStart, startNow }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.error || `HTTP ${res.status}`); return }
      if (data.started === false && data.startError) {
        setError(`已登记，但启动失败：${data.startError}`)
        return
      }
      onDone()
      onClose()
    } catch (err: any) {
      setError(err?.message || String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const field: React.CSSProperties = {
    width: '100%', padding: '6px 10px', borderRadius: 4,
    border: '1px solid var(--border)', background: 'var(--bg-deep)',
    color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box',
    fontFamily: 'var(--font-mono)',
  }
  const btn: React.CSSProperties = {
    padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)',
    background: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 100,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        padding: '24px 28px', borderRadius: 10,
        background: 'var(--bg-panel)', border: '1px solid var(--border)',
        width: 440, boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>接入目录为 Agent</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
          写入该目录 .mcp.json + 登记到 agents.json，微信即可 @它 对话
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>工作目录（绝对路径）</label>
            <input value={cwd} onChange={e => onCwdChange(e.target.value)} autoFocus
              placeholder="/Users/you/projects/foo" style={field} />
          </div>
          <div>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>Agent 名（微信 @ 用）</label>
            <input value={name} onChange={e => { setNameEdited(true); setName(e.target.value) }}
              placeholder="foo" style={field}
              onKeyDown={e => { if (e.key === 'Enter') submit() }} />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoStart} onChange={e => setAutoStart(e.target.checked)} />
            hub 启动时自动拉起（autoStart）
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={startNow} onChange={e => setStartNow(e.target.checked)} />
            立即启动一个会话
          </label>

          {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button onClick={onClose} style={btn}>取消</button>
            <button onClick={submit} disabled={submitting || !cwd.trim() || !name.trim()}
              style={{ ...btn, color: 'var(--accent)', borderColor: 'var(--accent)' }}>
              {submitting ? '接入中...' : '接入'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
