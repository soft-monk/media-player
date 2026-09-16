// media-player · 独立示例宿主（素材全部本地，零外网请求）
//
// 这个文件是**宿主**的示范：它负责
//   ① 提供通道清单（本示例用相对 URL 指向 demo/public/media/**）；
//   ② 通过 props / ref 驱动播放；
//   ③ 把 media.* 事件与 state/empty 回调展示出来。
// 模块本身不认识"通道叫什么、素材从哪来" —— 全部由这里注入。

import { useCallback, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  MediaPlayer,
  MEDIA_PLAYER_CSS,
  type MediaChannel,
  type MediaEvent,
  type MediaPlayerHandle,
  type OverlayBox,
} from '@media-player'

/* ── ① 通道清单（宿主侧：模块源码内检索不到任何通道名与 URL） ── */

const CHANNELS: unknown[] = [
  { id: 'v1', name: '视频 1', kind: 'video', url: '/media/sample-1.mp4', sourceLabel: '来源 A', loop: true, poster: '/media/poster-1.png' },
  { id: 'v2', name: '视频 2', kind: 'video', url: '/media/sample-2.mp4', sourceLabel: '来源 B', loop: true },
  { id: 'v3', name: '视频 3', kind: 'video', url: '/media/sample-3.mp4', loop: true },
  { id: 's1', name: '序列 1', kind: 'image-seq', url: '/media/seq/frame-{i:3}.png', frameCount: 12, frameIntervalMs: 120, loop: true, sourceLabel: '来源 C' },
  // 故意无效的一路：用于现场演示"单路失败不影响其它路"（MDP-DGR-03）
  { id: 'bad', name: '坏链通道（404）', kind: 'video', url: '/media/__missing__.mp4' },
  // 第 6 路必须可用（"六路同屏只有一个通道出声"的现场演示）
  { id: 'v4', name: '视频 4', kind: 'video', url: '/media/sample-4.mp4', loop: true },
  { id: 's2', name: '序列 2', kind: 'image-seq', url: '/media/anim.gif', frameCount: 1, loop: true },
  // 故意越界的第 7 路：用于现场演示"超上限拒绝（3004）+ 不静默丢"
  { id: 'v7', name: '视频 7（应被上限拒绝）', kind: 'video', url: '/media/sample-5.mp4' },
]

/** 锁定框（归一化坐标 0–1；宿主注入，模块不产生业务语义） */
const LOCK_BOXES: OverlayBox[] = [
  { id: 'k1', rect: { x: 0.42, y: 0.32, w: 0.18, h: 0.26 }, style: 'lock', color: '#ef4444', label: 'L1' },
  { id: 'k2', rect: { x: 0.12, y: 0.56, w: 0.14, h: 0.2 }, style: 'crosshair', color: '#f59e0b' },
]

const OVERLAYS = {
  keys: ['live', 'magnification', 'timestamp', 'channelName', 'source', 'boxes'] as const,
  pointerEvents: 'none' as const,
  fit: 'contain' as const,
  byChannel: {
    v1: {
      live: true,
      magnification: '×4',
      timestampMs: Date.UTC(2026, 8, 12, 10, 0, 0),
      boxes: LOCK_BOXES,
      extra: [{ key: 'flag', text: '通用角标', corner: 'tr' as const }],
    },
    s1: { live: true, magnification: '×2', timestampText: '2026-09-12 10:00:00' },
  },
}

/* ── ② 页面 ── */

/** 宿主侧记录控制器句柄（只读诊断出口用；模块本身不提供测试后门） */
let handleRef: MediaPlayerHandle | null = null

function Demo() {
  const ref = useRef<MediaPlayerHandle | null>(null)
  const [events, setEvents] = useState<string[]>([])
  const [emptyReason, setEmptyReason] = useState<string | null>(null)
  const [mainId, setMainId] = useState<string | null>('v1')
  const [layout, setLayout] = useState<'grid' | 'focus'>('grid')
  const [channels, setChannels] = useState<unknown[]>(CHANNELS)
  const [summary, setSummary] = useState('')

  const attachHandle = useCallback((h: MediaPlayerHandle | null) => {
    ref.current = h
    handleRef = h
  }, [])

  const onEvent = useCallback((ev: MediaEvent) => {
    setEvents((prev) => {
      const line = `${ev.type} ${JSON.stringify(ev.data)}`
      const next = [line, ...prev]
      return next.slice(0, 60)
    })
  }, [])

  const options = useMemo(() => ({ audioPolicy: 'single' as const, autoPlay: false, maxChannels: 6 }), [])

  const refresh = useCallback(() => {
    const h = ref.current
    if (!h) return
    const d = h.getDiagnostics()
    setSummary(JSON.stringify({ summary: h.getSummary(), totals: d.totals, degraded: d.degraded }, null, 1))
  }, [])

  return (
    <div id="app">
      <header>
        <h1>media-player · 独立示例</h1>
        <span className="hint">素材全部本地 · 零外网</span>
        <button type="button" onClick={() => ref.current?.play('v1')}>
          播放 v1
        </button>
        <button type="button" onClick={() => ref.current?.toggle('s1')}>
          切换 序列 1
        </button>
        <button type="button" onClick={() => ref.current?.setVisible('v3', false)}>
          隐藏 v3
        </button>
        <button type="button" onClick={() => ref.current?.setVisible('v3', true)}>
          显示 v3
        </button>
        <button type="button" onClick={() => setMainId(mainId === 'v1' ? 's1' : 'v1')}>
          切换主路
        </button>
        <select value={layout} onChange={(e) => setLayout(e.target.value as 'grid' | 'focus')}>
          <option value="grid">网格</option>
          <option value="focus">主路聚焦</option>
        </select>
        <button type="button" onClick={() => setChannels([])}>
          空清单（应隐藏）
        </button>
        <button type="button" onClick={() => setChannels(CHANNELS)}>
          恢复清单
        </button>
        <button type="button" onClick={refresh}>
          打印诊断
        </button>
      </header>
      <main>
        <div id="stage">
          {emptyReason && (
            <div id="empty-note" style={{ display: 'block' }}>
              模块已隐藏入口，原因：<code>{emptyReason}</code>（提示渲染在模块之外）
            </div>
          )}
          <div id="player">
            <MediaPlayer
              ref={attachHandle}
              channels={channels}
              options={options}
              overlays={{ ...OVERLAYS, keys: [...OVERLAYS.keys] }}
              mainChannelId={mainId}
              layout={layout}
              onEvent={onEvent}
              onEmpty={(reason, detail) => setEmptyReason(`${reason} · ${detail.message}`)}
              onChannelState={() => refresh()}
            />
          </div>
        </div>
        <aside>
          <h2>汇总 / 诊断</h2>
          <pre id="summary">{summary || '（点"打印诊断"）'}</pre>
          <h2>media.* 事件（最近 60 条）</h2>
          <pre id="events">{events.join('\n')}</pre>
        </aside>
      </main>
    </div>
  )
}

const style = document.createElement('style')
style.textContent = MEDIA_PLAYER_CSS
document.head.appendChild(style)

createRoot(document.getElementById('app')!).render(<Demo />)

/**
 * 只读诊断出口：供验收脚本（headless 浏览器）读取。
 * 宿主可以这样做；模块本身不提供任何"给测试用的后门"。
 */
declare global {
  interface Window {
    __MEDIA_PLAYER_DEMO__?: () => {
      playerMounted: boolean
      tiles: Array<{ id: string; state: string }>
      errored: number
      unavailable: number
      overlays: number
      boxRects: number
      summary: unknown
      totals: unknown
    }
  }
}

window.__MEDIA_PLAYER_DEMO__ = () => {
  const handle = handleRef
  const root = document.querySelector('[data-media-player]')
  const tiles = Array.from(document.querySelectorAll('[data-media-tile]')).map((el) => ({
    id: el.getAttribute('data-media-tile') ?? '',
    state: el.getAttribute('data-state') ?? '',
  }))
  return {
    playerMounted: !!root,
    tiles,
    errored: document.querySelectorAll('[data-media-error]').length,
    unavailable: document.querySelectorAll('[data-media-unavailable]').length,
    overlays: document.querySelectorAll('[data-media-overlay]').length,
    boxRects: document.querySelectorAll('[data-media-overlay] [data-overlay-box]').length,
    channels: handle
      ? handle.getChannels().map((c) => ({
          id: c.id,
          kind: c.kind,
          url: c.url,
          available: c.available,
          reason: c.unavailableReason,
        }))
      : [],
    summary: handle ? handle.getSummary() : null,
    totals: handle ? handle.getDiagnostics().totals : null,
  }
}

/** `?selfcheck=1`：把自检结论写进 DOM，供 headless 验收脚本读取 */
if (new URLSearchParams(location.search).has('selfcheck')) {
  const dump = (): void => {
    const pre = document.createElement('pre')
    pre.id = 'demo-selfcheck'
    try {
      pre.textContent = 'RESULT:' + JSON.stringify(window.__MEDIA_PLAYER_DEMO__?.() ?? null)
    } catch (e) {
      pre.textContent = 'RESULT:{"error":"' + String(e) + '"}'
    }
    document.body.appendChild(pre)
  }
  setTimeout(dump, 1500)
  setTimeout(dump, 4000)
}

void (CHANNELS as MediaChannel[])
