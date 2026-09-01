import { t } from '@/lib/i18n'
// RevealOverlay.tsx — the live-node-reveal renderer (the "watch it connect" surface).
//
// A self-contained overlay: drop text → POST /debug/reveal → stream the returned frames into the pure
// reveal-reducer with staggered timing (the two-wave reveal), animate on a canvas (focal pulse, bornAt
// entrance, dashed=proposed / solid=endorsed / faded=vetoed), and let the operator endorse/veto each
// pending edge via hover handles (→ /reveal/judge, then forward the learn payload to /learn/correction).
//
// This is a direct port of the verified harness (scratchpad/live-node-reveal.html): same hand-rolled
// force sim + draw, same palette, now driven by real frames + the unit-tested reducer. The state model
// and endpoints are tested; the in-app VISUAL still wants a GUI-QA pass before it's deployed as default.

import React, { useEffect, useRef, useState, useCallback } from 'react'
// Shadows global fetch: attaches the per-launch control token on loopback brain URLs, without
// which the three POSTs below (learn/correction, reveal/judge, debug/reveal) 403 silently under
// the 2026-08-25 control-plane token rule.
import { duinFetch as fetch } from '../lib/loopback-auth'
import {
  initialRevealState,
  reduceFrame,
  applyEdgeVerdict,
  edgeKey,
  type RevealState,
  type RevealEdge,
  type GraphFrame
} from '../lib/reveal-reducer'

// ── palette (DUIN default — mirrors graph-schemes.ts) ──
const KIND_COLOR: Record<string, string> = {
  core: '#e2e8f0', goal: '#fde047', event: '#fbbf24', milestone: '#fbbf24', release: '#fbbf24',
  project: '#38bdf8', track: '#2dd4bf', strategy: '#a78bfa', move: '#34d399', risk: '#fb7185',
  owed: '#60a5fa', insight: '#22d3ee', person: '#94a3b8', org: '#818cf8', task: '#fb923c',
  card: '#bef264', decision: '#c084fc', page: '#4ade80', product: '#f0abfc', place: '#5eead4',
  topic: '#8b7cf6', note: '#64748b', engine: '#2dd4bf', tool: '#38bdf8', concept: '#a78bfa',
  ledger: '#facc15', model: '#f472b6', brain: '#5eead4'
}
const TEAL = '#5eead4'
const colorFor = (kind: string): string => KIND_COLOR[kind] || '#94a3b8'
function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`
}
const easeOut = (p: number): number => 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3)

interface Pos { x: number; y: number; vx: number; vy: number; fx?: number; fy?: number }
interface Handle { x: number; y: number; r: number; act: 'endorse' | 'veto'; edge: RevealEdge }

const API = 'http://127.0.0.1:8799'

export function RevealOverlay(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef<RevealState>(initialRevealState())
  const posRef = useRef<Map<string, Pos>>(new Map())
  const handlesRef = useRef<Handle[]>([])
  const hoverRef = useRef<string | null>(null)
  const rafRef = useRef<number>(0)
  const timersRef = useRef<number[]>([])
  const [text, setText] = useState('')
  const [status, setStatus] = useState<'idle' | 'revealing' | 'settled' | 'error'>('idle')
  const [, force] = useState(0)
  const rerender = useCallback(() => force((n) => n + 1), [])

  const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : 0)

  const ensurePos = (id: string, focal: boolean): Pos => {
    let p = posRef.current.get(id)
    if (!p) {
      const f = posRef.current.get(stateRef.current.rootId || '')
      const a = Math.random() * Math.PI * 2
      const r = focal ? 0 : 20 + Math.random() * 14
      p = { x: (f?.x ?? 0) + Math.cos(a) * r, y: (f?.y ?? 0) + Math.sin(a) * r, vx: 0, vy: 0 }
      if (focal) { p.fx = 0; p.fy = 0 }
      posRef.current.set(id, p)
    }
    return p
  }

  // ── mini force sim (feel-match to the harness) ──
  const step = (alpha: number): void => {
    const st = stateRef.current
    const ids = [...st.nodes.keys()]
    ids.forEach((id) => ensurePos(id, st.nodes.get(id)!.focal))
    const P = posRef.current
    const CHARGE = -2400, LINK = 56, LK = 0.32, CENTER = 0.018, DECAY = 0.3
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const a = P.get(ids[i])!, b = P.get(ids[j])!
        let dx = a.x - b.x, dy = a.y - b.y
        const d2 = dx * dx + dy * dy || 0.01
        const f = (CHARGE * alpha) / d2, d = Math.sqrt(d2), ux = dx / d, uy = dy / d
        a.vx -= ux * f; a.vy -= uy * f; b.vx += ux * f; b.vy += uy * f
      }
    for (const e of st.edges) {
      const a = P.get(e.from), b = P.get(e.to)
      if (!a || !b) continue
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const disp = (d - LINK) * LK * alpha, ux = dx / d, uy = dy / d
      a.vx += ux * disp; a.vy += uy * disp; b.vx -= ux * disp; b.vy -= uy * disp
    }
    for (const id of ids) {
      const p = P.get(id)!
      if (p.fx != null) { p.x = p.fx; p.y = p.fy!; p.vx = 0; p.vy = 0; continue }
      p.vx -= p.x * CENTER * alpha; p.vy -= p.y * CENTER * alpha
      p.vx *= 1 - DECAY; p.vy *= 1 - DECAY
      p.x += p.vx; p.y += p.vy
    }
  }

  const draw = (): void => {
    const cv = canvasRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const DPR = Math.min(2, window.devicePixelRatio || 1)
    const W = cv.clientWidth, H = cv.clientHeight
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR)
    const st = stateRef.current, P = posRef.current, T = clock()
    let ext = 40
    P.forEach((p) => { ext = Math.max(ext, Math.abs(p.x) + 12, Math.abs(p.y) + 16) })
    const SCALE = Math.max(1.1, Math.min(3.2, (Math.min(W, H) * 0.44) / ext))
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H)
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(SCALE, SCALE)
    const t = T / 1000
    const focus = hoverRef.current || (st.complete ? null : st.rootId)
    const nb = focus ? new Set<string>([focus, ...st.edges.filter((e) => e.from === focus || e.to === focus).flatMap((e) => [e.from, e.to])]) : null

    // edges
    for (const e of st.edges) {
      const a = P.get(e.from), b = P.get(e.to)
      if (!a || !b) continue
      const grow = easeOut((T - e.bornAt) / 500)
      let alpha = 1
      if (e.state === 'vetoed') { alpha = 1 - easeOut((T - e.stateAt) / 320); if (alpha <= 0) continue }
      const ex = a.x + (b.x - a.x) * (e.state === 'proposed' ? grow : 1)
      const ey = a.y + (b.y - a.y) * (e.state === 'proposed' ? grow : 1)
      const incident = !nb || (nb.has(e.from) && nb.has(e.to))
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(ex, ey)
      if (e.state === 'proposed') { ctx.strokeStyle = withAlpha(TEAL, (incident ? 0.55 : 0.16) * alpha); ctx.lineWidth = 0.9; ctx.setLineDash([3, 4]); ctx.lineDashOffset = -(t * 22) % 14 }
      else if (e.state === 'endorsed') { const ea = easeOut((T - e.stateAt) / 300); ctx.strokeStyle = withAlpha(TEAL, (0.45 + 0.4 * ea) * alpha); ctx.lineWidth = 0.7 + 0.6 * ea; ctx.setLineDash(ea < 1 ? [3, 4] : []) }
      else { ctx.strokeStyle = withAlpha('#fb7185', 0.5 * alpha); ctx.lineWidth = 0.9; ctx.setLineDash([3, 4]) }
      ctx.stroke(); ctx.setLineDash([])
    }

    // nodes (focal last)
    const order = [...st.nodes.values()].sort((a, b) => (a.focal ? 1 : 0) - (b.focal ? 1 : 0))
    for (const n of order) {
      const p = P.get(n.id); if (!p) continue
      const ent = easeOut((T - n.bornAt) / 450)
      const base = (n.focal ? 6 : n.kind === 'core' ? 8 : 3) * (0.3 + 0.7 * ent)
      const color = colorFor(n.kind)
      const dimmed = focus != null && nb != null && !nb.has(n.id) && !n.focal
      const pulse = n.focal && !st.complete ? 0.5 + 0.5 * Math.sin(t * 2.2) : 0
      if (n.focal && !dimmed) { ctx.beginPath(); ctx.arc(p.x, p.y, base + 1.5 + pulse * 1.8, 0, 7); ctx.fillStyle = TEAL; ctx.globalAlpha = 0.14 * (0.5 + pulse * 0.5) * ent; ctx.fill(); ctx.globalAlpha = 1 }
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, base), 0, 7)
      ctx.fillStyle = color; ctx.globalAlpha = (dimmed ? 0.3 : 1) * ent; ctx.fill(); ctx.globalAlpha = 1
      if (n.focal) { ctx.lineWidth = 1.4; ctx.strokeStyle = withAlpha(TEAL, 0.95); ctx.beginPath(); ctx.arc(p.x, p.y, base + 2.4, 0, 7); ctx.stroke() }
      else if (n.id === hoverRef.current) { ctx.lineWidth = 1.4; ctx.strokeStyle = withAlpha(TEAL, 0.9); ctx.stroke() }
      const showLabel = n.focal || n.id === hoverRef.current || (nb != null && nb.has(n.id) && !dimmed) || (!focus && (n.kind === 'core' || n.kind === 'project'))
      if (showLabel && (n.bornAt <= 0 || ent > 0.55)) {
        ctx.font = `${(9 / SCALE) * 1.6}px ui-sans-serif, system-ui, sans-serif`
        ctx.fillStyle = n.focal ? withAlpha(TEAL, 0.95) : `rgba(225,228,240,${dimmed ? 0.4 : 0.92})`
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        const lbl = n.label.length > 26 ? n.label.slice(0, 24) + '…' : n.label
        ctx.fillText(lbl, p.x, p.y + base + 3)
      }
    }

    // hover handles (endorse/veto) on the hovered node's proposed edges
    handlesRef.current = []
    const review = hoverRef.current
    if (st.complete && review) {
      for (const e of st.edges) {
        if (e.state !== 'proposed' || (e.from !== review && e.to !== review)) continue
        const near = P.get(e.from === review ? e.from : e.to), far = P.get(e.from === review ? e.to : e.from)
        if (!near || !far) continue
        const hx = near.x + (far.x - near.x) * 0.62, hy = near.y + (far.y - near.y) * 0.62, R = 4.2
        for (const [dx, glyph, col, act] of [[-1.25, '✓', TEAL, 'endorse'], [1.25, '✕', '#fb7185', 'veto']] as const) {
          const x = hx + R * dx
          ctx.beginPath(); ctx.arc(x, hy, R, 0, 7); ctx.fillStyle = 'rgba(12,14,18,0.92)'; ctx.fill()
          ctx.lineWidth = 0.8; ctx.strokeStyle = withAlpha(col, 0.85); ctx.stroke()
          ctx.fillStyle = col; ctx.font = `${R * 1.25}px ui-sans-serif,system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(glyph, x, hy + 0.4)
          handlesRef.current.push({ x, y: hy, r: R, act, edge: e })
        }
      }
    }
    ctx.restore()
  }

  // ── animation loop ──
  useEffect(() => {
    const loop = (): void => {
      const st = stateRef.current
      const alpha = !st.complete ? 0.9 : 0.25
      if (st.nodes.size) step(alpha)
      draw()
      rafRef.current = requestAnimationFrame(loop)
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(rafRef.current); timersRef.current.forEach(clearTimeout) }
  }, [])

  const toGraph = (px: number, py: number): { x: number; y: number } => {
    const cv = canvasRef.current!
    const W = cv.clientWidth, H = cv.clientHeight
    let ext = 40; posRef.current.forEach((p) => { ext = Math.max(ext, Math.abs(p.x) + 12, Math.abs(p.y) + 16) })
    const SCALE = Math.max(1.1, Math.min(3.2, (Math.min(W, H) * 0.44) / ext))
    return { x: (px - W / 2) / SCALE, y: (py - H / 2) / SCALE }
  }

  const onMove = (e: React.MouseEvent): void => {
    const r = canvasRef.current!.getBoundingClientRect()
    const g = toGraph(e.clientX - r.left, e.clientY - r.top)
    let best: string | null = null, bd = 1e9
    posRef.current.forEach((p, id) => { const d = Math.hypot(p.x - g.x, p.y - g.y); if (d < 6 && d < bd) { bd = d; best = id } })
    hoverRef.current = best
  }

  const forwardLearn = (learn: unknown): void => {
    // fire-and-forget: feed the taste loop via the existing operator-only learning endpoint
    void fetch(`${API}/learn/correction`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(learn) }).catch(() => {})
  }

  const onClick = (e: React.MouseEvent): void => {
    const r = canvasRef.current!.getBoundingClientRect()
    const g = toGraph(e.clientX - r.left, e.clientY - r.top)
    for (const h of handlesRef.current) {
      if (Math.hypot(h.x - g.x, h.y - g.y) <= h.r + 1.5) {
        const ed = h.edge
        stateRef.current = applyEdgeVerdict(stateRef.current, ed.from, ed.to, ed.edgeType, h.act === 'endorse' ? 'endorsed' : 'vetoed', clock())
        rerender()
        void fetch(`${API}/reveal/judge`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: ed.from, to: ed.to, edgeType: ed.edgeType, source: ed.src, confidence: ed.confidence, verdict: h.act, candidateRule: h.act === 'endorse' ? `${ed.from} ${ed.edgeType} ${ed.to}` : undefined })
        }).then((res) => res.json()).then((j: { learn?: unknown }) => { if (j?.learn) forwardLearn(j.learn) }).catch(() => {})
        return
      }
    }
  }

  const runReveal = async (): Promise<void> => {
    if (!text.trim()) return
    stateRef.current = initialRevealState(); posRef.current.clear(); handlesRef.current = []
    timersRef.current.forEach(clearTimeout); timersRef.current = []
    setStatus('revealing'); rerender()
    let frames: GraphFrame[] = []
    try {
      const res = await fetch(`${API}/debug/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, title: text.slice(0, 40) }) })
      const j = (await res.json()) as { frames?: GraphFrame[] } & { result?: { frames?: GraphFrame[] } }
      frames = j.frames || j.result?.frames || []
    } catch { setStatus('error'); return }
    // stagger the frames for the "watch it connect" reveal (node first, then a beat between links)
    frames.forEach((f, i) => {
      const delay = f.op === 'node-created' ? 0 : f.op === 'reveal-complete' ? (i + 2) * 140 : (i + 1) * 140
      const id = window.setTimeout(() => {
        stateRef.current = reduceFrame(stateRef.current, f, clock())
        if (f.op === 'reveal-complete') { const root = posRef.current.get(stateRef.current.rootId || ''); if (root) { delete root.fx; delete root.fy }; setStatus('settled') }
        rerender()
      }, delay)
      timersRef.current.push(id)
    })
  }

  const st = stateRef.current
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0a0a0e', color: '#e1e4f0', font: '14px ui-sans-serif, system-ui, sans-serif' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid #232330' }}>
        <strong style={{ fontSize: 13 }}>{t('Live Node Reveal')}</strong>
        <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder={t('Drop a thought…')} style={{ flex: 1, background: '#141419', border: '1px solid #232330', borderRadius: 7, padding: '6px 10px', color: '#e1e4f0' }} onKeyDown={(ev) => { if (ev.key === 'Enter') void runReveal() }} />
        <button onClick={() => void runReveal()} style={{ background: 'linear-gradient(180deg,#1a3d38,#153029)', border: '1px solid #245049', color: TEAL, borderRadius: 7, padding: '6px 12px', cursor: 'pointer' }}>▸ Reveal</button>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <canvas ref={canvasRef} onMouseMove={onMove} onClick={onClick} style={{ display: 'block', width: '100%', height: '100%' }} />
        <div style={{ position: 'absolute', right: 14, top: 12, fontSize: 11, color: '#565b6e', textAlign: 'right' }}>
          {status === 'revealing' && 'connecting…'}
          {status === 'settled' && <span>settled · hover a node, click ✓/✕<br />proposed {st.edges.filter((e) => e.state === 'proposed').length} · endorsed {st.edges.filter((e) => e.state === 'endorsed').length}</span>}
          {status === 'error' && <span style={{ color: '#fb7185' }}>reveal failed (is the brain server up?)</span>}
        </div>
      </div>
    </div>
  )
}
