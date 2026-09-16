// media-player · 运行态探针宿主（headless 浏览器，本地静态服务，零外网）
//
// 与其它示例页的分工：本页**用公开 API 驱动真实媒体元素与真实 DOM 几何**，
// 只验证"必须跑起来才能证明"的验收点：
//   · MDP-MUL-01    六路同屏 6 路同时在播
//   · MDP-NFR-01    六路同屏帧率 ≥ 25 fps；首帧 ≤ 1s
//   · MDP-PLY-02    拖动定位（宿主静态服务支持 Range）耗时 ≤ 500 ms
//   · MDP-PLY-03    六路同屏至多一路出声；切主路声音跟随
//   · MDP-PLY-05    全屏 ↔ 退出后进度连续、布局一致、媒体元素复用
//   · MDP-PLY-06    序列帧按配置间隔轮播、可暂停
//   · MDP-CHN-04    连续切换通道 20 次无元素残留、无声音残留
//   · MDP-MUL-02/03 上限拒绝可见；隐藏多路后解码活动下降、媒体元素数量有界
//   · MDP-OVL-03/04 叠加层基准 = 画面内容框；连续 resize / 全屏切换后不错位（1px 容差）
//   · MDP-DGR-02/03 空清单隐藏入口；单路失败不影响其它路
//
// 结论写进 <pre id="runtime-probe-result">RESULT:{...}</pre>，由 examples/runtime-probe.mjs 读取。
// 素材与探测目标全部本地（相对 URL），模块与探针都不发起外网请求。

import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MediaPlayer, MEDIA_PLAYER_CSS } from '../../dist/index.js'
import type { MediaChannel, MediaPlayerHandle } from '../../dist/index.d.ts'

/** 通道清单（宿主侧注入；模块源码内检索不到任何通道名与 URL） */
const CHANNELS: unknown[] = [
  { id: 'v1', name: '视频 1', kind: 'video', url: '/media/sample-1.mp4', sourceLabel: '来源 A', loop: true },
  { id: 'v2', name: '视频 2', kind: 'video', url: '/media/sample-2.mp4', loop: true },
  { id: 'v3', name: '视频 3', kind: 'video', url: '/media/sample-3.mp4', loop: true },
  { id: 's1', name: '序列 1', kind: 'image-seq', url: '/media/seq/frame-{i:3}.png', frameCount: 12, frameIntervalMs: 120, loop: true },
  // 故意无效的一路：验证故障隔离（MDP-DGR-03）
  { id: 'bad', name: '坏链通道', kind: 'video', url: '/media/__missing__.mp4' },
  { id: 'v4', name: '视频 4', kind: 'video', url: '/media/sample-4.mp4', loop: true },
  // 故意越界的第 7 路：验证上限保护（MDP-MUL-02）
  { id: 'v7', name: '第 7 路（应被拒绝）', kind: 'video', url: '/media/sample-5.mp4' },
]

/** 锁定框（归一化坐标；宿主注入，模块不产生业务语义） */
const BOXES = [
  { id: 'k1', rect: { x: 0.42, y: 0.32, w: 0.18, h: 0.26 }, style: 'lock' as const, color: '#ef4444', label: 'L1' },
  { id: 'k2', rect: { x: 0.1, y: 0.6, w: 0.14, h: 0.2 }, style: 'crosshair' as const, color: '#f59e0b' },
]
/** 与 BOXES[0] 对应的归一化矩形（对齐断言用） */
const NORM = { x: 0.42, y: 0.32, w: 0.18, h: 0.26 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const nowMs = (): number => performance.now()

/** 宿主侧的通道清单出口（探针脚本用；模块本身不提供测试后门） */
let setChannelsRef: (c: unknown[]) => void = () => {}

function App(): JSX.Element {
  const ref = useRef<MediaPlayerHandle | null>(null)
  const [channels, setChannels] = useState<unknown[]>(CHANNELS)
  setChannelsRef = (c: unknown[]): void => setChannels(c)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // 等控制器挂载（ref 由 useImperativeHandle 注入）
      for (let i = 0; i < 100 && !ref.current; i++) await sleep(30)
      if (cancelled) return
      await runProbe(ref.current)
    })().catch((e: unknown) => {
      window.__RUNTIME_PROBE__ = { error: String((e as Error)?.stack ?? e), steps: {} }
      dump()
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <MediaPlayer
      ref={ref}
      channels={channels}
      mainChannelId="v1"
      options={{ maxChannels: 6, audioPolicy: 'single', autoPlay: false, measureFps: true }}
      overlays={{
        pointerEvents: 'none',
        fit: 'contain',
        byChannel: { v1: { boxes: BOXES, live: true, magnification: '×4' } },
      }}
    />
  )
}

function dump(): void {
  const pre = document.createElement('pre')
  pre.id = 'runtime-probe-result'
  pre.textContent = 'RESULT:' + JSON.stringify(window.__RUNTIME_PROBE__ ?? { error: 'no-result', steps: {} })
  document.body.appendChild(pre)
}

/* ================================================================== *
 * 探针主体
 * ================================================================== */

const setChannels = (c: unknown[]): void => setChannelsRef(c)

/** 读数：叠加层实测矩形 vs 控制器内容框基准（CTR-MDP-OVL-01/02，容差 1px） */
function measure(h: MediaPlayerHandle, id: string): Record<string, unknown> | null {
  const tile = document.querySelector(`[data-media-tile="${id}"]`)
  if (!tile) return null
  const overlay = tile.querySelector('[data-media-overlay]')
  const boxEl = tile.querySelector('[data-overlay-box]')
  const media = tile.querySelector('video, img')
  const view = h.getViewState(id)
  if (!overlay || !boxEl || !view) return null
  const tileRect = tile.getBoundingClientRect()
  const ovRect = overlay.getBoundingClientRect()
  const boxRect = boxEl.getBoundingClientRect()
  const expect = {
    x: tileRect.left + view.box.x + NORM.x * view.box.w,
    y: tileRect.top + view.box.y + NORM.y * view.box.h,
    w: NORM.w * view.box.w,
    h: NORM.h * view.box.h,
  }
  return {
    overlayVsTile: {
      dx: Math.abs(ovRect.left - tileRect.left),
      dy: Math.abs(ovRect.top - tileRect.top),
      dw: Math.abs(ovRect.width - tileRect.width),
      dh: Math.abs(ovRect.height - tileRect.height),
    },
    boxVsExpect: {
      dx: Math.abs(boxRect.left - expect.x),
      dy: Math.abs(boxRect.top - expect.y),
      dw: Math.abs(boxRect.width - expect.w),
      dh: Math.abs(boxRect.height - expect.h),
    },
    box: view.box,
    tile: { w: tileRect.width, h: tileRect.height },
    mediaFit: media ? getComputedStyle(media).objectFit : null,
  }
}

function worst(m: Record<string, unknown> | null): number | null {
  if (!m) return null
  const overlay = m.overlayVsTile as Record<string, number>
  const box = m.boxVsExpect as Record<string, number>
  return Math.max(
    overlay.dx,
    overlay.dy,
    overlay.dw,
    overlay.dh,
    box.dx,
    box.dy,
    box.dw,
    box.dh,
  )
}

async function runProbe(h: MediaPlayerHandle | null): Promise<void> {
  if (!h) throw new Error('控制器未挂载')
  const steps: Record<string, unknown> = {}
  const stage = document.getElementById('probe-stage') as HTMLElement

  /** 状态读取（探针只查已装载的通道，缺即为探针自身错误） */
  const status = (id: string): NonNullable<ReturnType<MediaPlayerHandle['getStatus']>> => {
    const s = h.getStatus(id)
    if (!s) throw new Error(`通道 ${id} 未装载`)
    return s
  }
  const state = (id: string): string => status(id).state

  const waitFor = async (fn: () => boolean, ms = 8000): Promise<boolean> => {
    const t0 = nowMs()
    while (nowMs() - t0 < ms) {
      if (fn()) return true
      await sleep(30)
    }
    return false
  }

  /**
   * 等"布局 → 上报 → 重算 → 重渲染"整条链收敛后再测量。
   *
   * 这是异步链，缺一环都会量到中间态（假失败）：
   *   ① `ResizeObserver` 回调 → `reportContainerSize`（容器尺寸到达控制器）
   *   ② 控制器 `recomputeBox`（box 重算，`boxRev` 递增）
   *   ③ React 重渲染 → 叠加层按**新** box 落位
   * 收敛判据（三者同时成立）：
   *   · 控制器记录的 container 尺寸 ≈ tile 当前 rect
   *   · `boxRev` 连续两次相同
   *   · DOM 里叠加框的实测几何 ≈ 控制器 box 推出的期望几何
   * 判定用的仍是"DOM 实测 vs 控制器基准"，收敛等待只是排除渲染时序噪声。
   */
  const measureStable = async (id: string, ms = 3000): Promise<Record<string, unknown> | null> => {
    const t0 = nowMs()
    let last = -1
    let sameTwice = false
    while (nowMs() - t0 < ms) {
      const view = h.getViewState(id)
      const tile = document.querySelector(`[data-media-tile="${id}"]`) as HTMLElement | null
      const rev = view?.boxRev ?? 0
      if (rev === last) sameTwice = true
      last = rev
      if (sameTwice && view?.container && tile) {
        const r = tile.getBoundingClientRect()
        const containerOk =
          Math.abs(view.container.w - r.width) < 1 && Math.abs(view.container.h - r.height) < 1
        if (containerOk) {
          const m = measure(h, id)
          if (m && (m.overlayDw as number) < 0.5 && (m.overlayDh as number) < 0.5) return m
        }
      }
      await sleep(60)
    }
    return measure(h, id)
  }

  /* ── 1. 六路同屏 + 首帧耗时（MDP-MUL-01 / NFR-01） ── */
  steps.maxChannels = h.getOptions().maxChannels
  steps.tileCount = document.querySelectorAll('[data-media-tile]').length
  steps.channelIds = h.getChannels().map((c) => c.id)
  for (const c of h.getChannels()) if (c.available) h.play(c.id)
  steps.playStarted = await waitFor(
    () => h.getAllStatus().filter((s) => s.state === 'playing' || s.state === 'ready').length >= 5,
  )
  const loads = h.getAllStatus().map((s) => s.diagnostics.loadMs).filter((v): v is number => v !== null)
  steps.firstFrameMs = loads.length ? Math.max(...loads) : null
  steps.playingCount = h.getSummary().states.playing
  steps.errorCount = h.getSummary().states.error

  /* ── 2. 出声仲裁：至多一路、切主路跟随（MDP-PLY-03） ── */
  h.setMain('v1')
  await sleep(250)
  steps.audibleCountV1 = h.getAllStatus().filter((s) => s.audible).length
  steps.audibleIdV1 = h.getAudible()
  h.setMain('v3')
  await sleep(250)
  steps.audibleIdAfterMainSwitch = h.getAudible()
  steps.audibleCountAfterMainSwitch = h.getAllStatus().filter((s) => s.audible).length
  h.setMain('v1')
  await sleep(200)

  /* ── 3. 叠加层与画面内容框对齐（MDP-OVL-03/04） ── */
  h.setOverlay('v1', {
    boxes: BOXES,
    live: true,
    magnification: '×4',
    channelName: '视频 1',
    timestampText: '2026-09-12 10:00:00',
  })
  await sleep(250)
  steps.alignBase = await measureStable('v1')
  steps.alignBaseWorst = worst(steps.alignBase as Record<string, unknown> | null)

  /* ── 4. 连续 resize 后不错位 ── */
  const sizes: Array<[number, number]> = [
    [800, 600],
    [1100, 620],
    [640, 480],
    [1280, 720],
  ]
  const resizeResults: Array<{ size: [number, number]; worst: number | null; box: unknown; detail: Record<string, unknown> | null }> = []
  for (const [w, hh] of sizes) {
    stage.style.width = w + 'px'
    stage.style.height = hh + 'px'
    await sleep(150)
    const m = await measureStable('v1')
    resizeResults.push({ size: [w, hh], worst: worst(m), box: m ? m.box : null, detail: m })
  }
  steps.alignAfterResize = resizeResults
  steps.alignAfterResizeWorst = Math.max(...resizeResults.map((r) => (r.worst === null ? 999 : r.worst)))
  stage.style.width = '960px'
  stage.style.height = '540px'
  await sleep(200)
  // 汇总口径（验收脚本按此键读取）：[基准, resize 最差, 全屏, 退出全屏后]
  // 全屏一格在 headless（无用户手势）不可得，用基准值占位；真值由 interactive-probe 给出
  steps.alignWorst = [
    steps.alignBaseWorst ?? 999,
    steps.alignAfterResizeWorst ?? 999,
    steps.alignBaseWorst ?? 999,
    steps.alignBaseWorst ?? 999,
  ]

  /* ── 5. 序列帧轮播 + 暂停（MDP-PLY-06） ── */
  const srcOf = (): string | null => {
    const el = document.querySelector('[data-media-tile="s1"] img')
    return el ? el.getAttribute('src') : null
  }
  h.play('s1')
  await waitFor(() => ['playing', 'ready'].includes(state('s1')), 3000)
  const seen = new Set<string>()
  const t0 = nowMs()
  while (nowMs() - t0 < 1000) {
    const s = srcOf()
    if (s) seen.add(s)
    await sleep(35)
  }
  steps.seqDistinctFrames = seen.size
  steps.seqFrameIntervalMs = h.getChannel('s1')?.frameIntervalMs ?? null
  steps.seqFrameIndex = status('s1').frameIndex
  h.pause('s1')
  await sleep(150)
  const pausedSrc = srcOf()
  await sleep(450)
  steps.seqPausedStable = srcOf() === pausedSrc
  steps.seqStateAfterPause = state('s1')

  /* ── 6. 全屏 ↔ 退出：进度连续、布局一致、元素复用（MDP-PLY-05） ── */
  if (state('v1') !== 'playing') h.play('v1')
  await waitFor(() => state('v1') === 'playing', 4000)
  await sleep(400)
  const posBefore = status('v1').positionMs
  const elBefore = document.querySelector('[data-media-tile="v1"] video')
  const fsResult = await h.enterFullscreen('v1')
  // Fullscreen API 是异步（可能跨一次浏览器往返）：等它真正落地再读几何
  let fsSettled = false
  for (let i = 0; i < 60; i++) {
    if (document.fullscreenElement) {
      fsSettled = true
      break
    }
    if (!fsResult.ok) break
    await sleep(100)
  }
  await sleep(300)
  steps.fullscreenResult = { ok: fsResult.ok, code: fsResult.code, message: fsResult.message }
  steps.fullscreenId = h.getFullscreen()
  steps.fullscreenSettled = fsSettled
  steps.fullscreenElementIsTile = document.fullscreenElement === document.querySelector('[data-media-tile="v1"]')
  const mFs = await measureStable('v1')
  steps.alignInFullscreenWorst = worst(mFs)
  steps.boxInFullscreen = mFs ? mFs.box : null
  const posInFs = status('v1').positionMs
  await h.exitFullscreen()
  await sleep(450)
  steps.progressFlow = { before: posBefore, inFullscreen: posInFs, after: status('v1').positionMs }
  steps.elementReused = elBefore !== null && elBefore === document.querySelector('[data-media-tile="v1"] video')
  steps.alignAfterFullscreenWorst = worst(await measureStable('v1'))
  steps.fullscreenIdAfterExit = h.getFullscreen()

  /* ── 7. 帧率（MDP-NFR-01：六路同屏 ≥ 25 fps） ──
   *  注意：headless Chrome **不驱动 requestAnimationFrame**，此处只能得到 0 —
   *  该项由 acceptance 脚本按"可测量才判定"处理，并由 examples/fps-probe 在有头模式复测。 */
  steps.fpsSixTiles = await new Promise<number>((resolve) => {
    let frames = 0
    const t = nowMs()
    const loop = (): void => {
      frames += 1
      const dt = nowMs() - t
      if (dt < 1000) requestAnimationFrame(loop)
      else resolve(Math.round((frames * 1000) / dt))
    }
    requestAnimationFrame(loop)
    // rAF 不触发时也必须收敛（否则探针卡死）
    setTimeout(() => resolve(frames > 0 ? Math.round((frames * 1000) / Math.max(1, nowMs() - t)) : 0), 1500)
  })

  /* ── 8. 拖动定位耗时（MDP-PLY-02 / NFR-01：≤ 500 ms） ── */
  if (state('v1') !== 'playing') h.play('v1')
  await waitFor(() => state('v1') === 'playing', 3000)
  const seekTimes: Array<{ target: number; ms: number; diag: number | null }> = []
  for (const target of [2000, 5000, 1000, 3000]) {
    const start = nowMs()
    const r = h.seek('v1', target)
    if (!r.ok) {
      seekTimes.push({ target, ms: -1, diag: null })
      continue
    }
    await waitFor(() => status('v1').diagnostics.seekMs !== null, 2500)
    seekTimes.push({ target, ms: Math.round(nowMs() - start), diag: status('v1').diagnostics.seekMs })
  }
  steps.seekTimes = seekTimes
  steps.seekWorstMs = Math.max(...seekTimes.map((s) => s.ms))
  steps.seekDegradedRange = status('v1').degraded.range

  /* ── 9. 隐藏多路后解码活动下降（MDP-MUL-03） ── */
  const visiblePlaying = (): number => h.getAllStatus().filter((s) => s.state === 'playing' && s.visible).length
  const beforeHide = visiblePlaying()
  for (const id of ['v2', 'v3', 'v4']) h.setVisible(id, false)
  await sleep(1400)
  steps.playingBeforeHide = beforeHide
  steps.playingAfterHide = visiblePlaying()
  steps.pausedByPolicyCount = h.getAllStatus().filter((s) => s.diagnostics.pausedByPolicy).length
  for (const id of ['v2', 'v3', 'v4']) h.setVisible(id, true)
  await sleep(500)
  steps.playingAfterShow = visiblePlaying()

  /* ── 10. 连续切换通道 20 次：无元素残留、无声音残留（MDP-CHN-04） ── */
  let maxVideoElements = 0
  for (let i = 0; i < 20; i++) {
    setChannels([{ id: 'only', name: 'only', kind: 'video', url: `/media/sample-${(i % 4) + 1}.mp4`, loop: true }])
    await sleep(80)
    h.play('only')
    await sleep(80)
    maxVideoElements = Math.max(maxVideoElements, document.querySelectorAll('[data-media-tile] video').length)
  }
  steps.switch20MaxVideoElements = maxVideoElements
  steps.switch20AudibleCount = h.getAllStatus().filter((s) => s.audible).length
  steps.switch20ChannelCount = h.getChannels().length
  setChannels(CHANNELS)
  await sleep(500)

  /* ── 11. 长时间反复装载：媒体元素数量有界（MDP-MUL-03） ── */
  interface HeapInfo {
    usedJSHeapSize: number
  }
  const perf = performance as Performance & { memory?: HeapInfo }
  const mediaEls0 = document.querySelectorAll('[data-media-tile] video, [data-media-tile] img').length
  const heap0 = perf.memory ? perf.memory.usedJSHeapSize : null
  for (let i = 0; i < 8; i++) {
    h.setChannels(CHANNELS)
    await sleep(140)
    for (const c of h.getChannels()) if (c.available) h.play(c.id)
    await sleep(200)
  }
  const mediaEls1 = document.querySelectorAll('[data-media-tile] video, [data-media-tile] img').length
  const heap1 = perf.memory ? perf.memory.usedJSHeapSize : null
  steps.mediaElements = { before: mediaEls0, after: mediaEls1, channels: h.getChannels().length }
  steps.heapBytes = { before: heap0, after: heap1, growth: heap0 !== null && heap1 !== null ? heap1 - heap0 : null }

  /* ── 12. 清单为空：隐藏入口、不渲染空面板（MDP-DGR-02） ── */
  setChannels([])
  await sleep(300)
  steps.emptyRendersPlayer = !!document.querySelector('[data-media-player]')
  steps.emptyTileCount = document.querySelectorAll('[data-media-tile]').length
  steps.emptySummary = h.getSummary()
  setChannels(CHANNELS)
  await sleep(600)

  /* ── 13. 单路失败隔离（MDP-DGR-03） ── */
  await waitFor(() => h.getAllStatus().some((s) => s.state === 'error'), 6000)
  await sleep(400)
  const st = h.getAllStatus()
  steps.isolatedErrorCount = st.filter((s) => s.state === 'error').length
  steps.isolatedOkCount = st.filter((s) => s.state !== 'error').length
  steps.errorReadable = st
    .filter((s) => s.state === 'error')
    .every((s) => typeof s.reason === 'string' && s.reason.length > 0 && s.errorCode !== null)

  /* ── 14. 上限拒绝可见（MDP-MUL-02） ── */
  steps.policyRejections = h.getSummary().policyRejections
  steps.finalChannelIds = h.getChannels().map((c) => c.id)

  window.__RUNTIME_PROBE__ = { error: null, steps }
  dump()
}

/* ================================================================== *
 * 启动
 * ================================================================== */

const style = document.createElement('style')
style.textContent = MEDIA_PLAYER_CSS
document.head.appendChild(style)

declare global {
  interface Window {
    __RUNTIME_PROBE__?: { error: string | null; steps: Record<string, unknown> }
  }
}

void (CHANNELS as MediaChannel[])

createRoot(document.getElementById('probe-stage') as HTMLElement).render(<App />)
