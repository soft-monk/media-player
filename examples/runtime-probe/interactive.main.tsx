// media-player · 交互式运行态探针（有头窗口 + 真实用户手势）
//
// 与 `runtime-probe.main.tsx`（headless 汇总探针）的分工：这里只跑**必须有真实交互 /
// 真实合成器**才能证明的两件事：
//   · MDP-PLY-05  全屏：Chrome 要求 transient user activation，脚本直接调会被拒；
//                 本页由 CDP 造真实鼠标手势 → 点击 `#ik-activate` 后调 `enterFullscreen`
//   · MDP-NFR-01  六路同屏帧率 ≥ 25 fps：headless 不驱动 requestAnimationFrame，
//                 必须在有头窗口（真实合成器）里采样
// 顺带复核叠加层在**全屏前后**的几何对齐（MDP-OVL-04）。
//
// 结论写入 `<pre id="ik-out">RESULT:{...}</pre>`（同时挂到 `window.__IK_RESULT__`），
// 由 examples/interactive-probe.mjs 经 CDP 读取。

import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MediaPlayer, MEDIA_PLAYER_CSS } from '../../dist/index.js'
import type { MediaPlayerHandle } from '../../dist/index.d.ts'

const CHANNELS: unknown[] = [
  { id: 'v1', name: '视频 1', kind: 'video', url: '/media/sample-1.mp4', loop: true },
  { id: 'v2', name: '视频 2', kind: 'video', url: '/media/sample-2.mp4', loop: true },
  { id: 'v3', name: '视频 3', kind: 'video', url: '/media/sample-3.mp4', loop: true },
  { id: 'v4', name: '视频 4', kind: 'video', url: '/media/sample-4.mp4', loop: true },
  { id: 'v5', name: '视频 5', kind: 'video', url: '/media/sample-5.mp4', loop: true },
  { id: 's1', name: '序列 1', kind: 'image-seq', url: '/media/seq/frame-{i:3}.png', frameCount: 12, frameIntervalMs: 120, loop: true },
]

const BOXES = [
  { id: 'k1', rect: { x: 0.42, y: 0.32, w: 0.18, h: 0.26 }, style: 'lock' as const, color: '#ef4444', label: 'L1' },
  { id: 'k2', rect: { x: 0.1, y: 0.6, w: 0.14, h: 0.2 }, style: 'crosshair' as const, color: '#f59e0b' },
]
const NORM = { x: 0.42, y: 0.32, w: 0.18, h: 0.26 }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const nowMs = (): number => performance.now()

function App(): JSX.Element {
  const ref = useRef<MediaPlayerHandle | null>(null)
  const [channels] = useState<unknown[]>(CHANNELS)

  useEffect(() => {
    void (async () => {
      for (let i = 0; i < 200 && !ref.current; i++) await sleep(50)
      const ctl = ref.current
      window.__IK_READY__ = !!ctl
      if (!ctl) {
        finish({ error: '控制器未挂载', steps: {} })
        return
      }
      window.__IK_RUN__ = () => {
        void run(ctl).catch((e: unknown) => {
          finish({ error: String((e as Error)?.stack ?? e), steps: {} })
        })
      }
    })()
  }, [])

  return (
    <MediaPlayer
      ref={ref}
      channels={channels}
      mainChannelId="v1"
      options={{ maxChannels: 6, audioPolicy: 'single', autoPlay: false, measureFps: true }}
      overlays={{ pointerEvents: 'none', fit: 'contain', byChannel: { v1: { boxes: BOXES, live: true, magnification: '×4' } } }}
    />
  )
}

function finish(payload: { error: string | null; steps: Record<string, unknown> }): void {
  window.__IK_RESULT__ = payload
  const out = document.getElementById('ik-out')
  if (out) out.textContent = 'RESULT:' + JSON.stringify(payload)
}

/** 读数：叠加层实测矩形 vs 控制器内容框基准（容差 1px） */
function measure(h: MediaPlayerHandle, id: string): Record<string, number> | null {
  const tile = document.querySelector(`[data-media-tile="${id}"]`)
  if (!tile) return null
  const overlay = tile.querySelector('[data-media-overlay]')
  const boxEl = tile.querySelector('[data-overlay-box]')
  const media = tile.querySelector('video, img')
  const view = h.getViewState(id)
  if (!overlay || !boxEl || !view) return null
  const tileRect = tile.getBoundingClientRect()
  const ovRect = overlay.getBoundingClientRect()
  const mediaRect = media ? media.getBoundingClientRect() : null
  const boxRect = boxEl.getBoundingClientRect()
  const expectX = tileRect.left + view.box.x + NORM.x * view.box.w
  const expectY = tileRect.top + view.box.y + NORM.y * view.box.h
  return {
    dx: Math.abs(boxRect.left - expectX),
    dy: Math.abs(boxRect.top - expectY),
    dw: Math.abs(boxRect.width - NORM.w * view.box.w),
    dh: Math.abs(boxRect.height - NORM.h * view.box.h),
    overlayDx: Math.abs(ovRect.left - tileRect.left),
    overlayDy: Math.abs(ovRect.top - tileRect.top),
    overlayDw: Math.abs(ovRect.width - tileRect.width),
    overlayDh: Math.abs(ovRect.height - tileRect.height),
    mediaDw: mediaRect ? Math.abs(mediaRect.width - tileRect.width) : 0,
    mediaDh: mediaRect ? Math.abs(mediaRect.height - tileRect.height) : 0,
    boxW: view.box.w,
    boxH: view.box.h,
    tileW: tileRect.width,
    tileH: tileRect.height,
    ovW: ovRect.width,
    ovH: ovRect.height,
    mediaW: mediaRect ? mediaRect.width : 0,
    mediaH: mediaRect ? mediaRect.height : 0,
  }
}

/**
 * 对齐判定只看"叠加层与画面/基准"的偏差，不含容器自身尺寸。
 *
 * `tileW/ovW/mediaW/ovW` 是诊断读数：极少数浏览器在原生全屏下会把子元素留在原
 * overflow 盒子里，这类"容器基准"问题与叠加层定位无关，单列一项判定以免混淆。
 */
const worstOf = (m: Record<string, number> | null): number | null =>
  m ? Math.max(m.dx, m.dy, m.dw, m.dh, m.overlayDx, m.overlayDy, m.overlayDw, m.overlayDh) : null

/** 等一帧真正过去（rAF 已驱动的情况下等价于"渲染完成"） */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false
    requestAnimationFrame(() => {
      done = true
      resolve()
    })
    setTimeout(() => {
      if (!done) resolve()
    }, 400)
  })

async function run(h: MediaPlayerHandle): Promise<void> {
  const steps: Record<string, unknown> = {}
  const status = (id: string) => {
    const s = h.getStatus(id)
    if (!s) throw new Error(`通道 ${id} 未装载`)
    return s
  }

  /* ── 1. 起播 6 路（帧率与全屏都在"六路同屏"前提下测） ── */
  for (const c of h.getChannels()) h.play(c.id)
  const playing = (): number => h.getAllStatus().filter((s) => s.state === 'playing').length
  const t0 = nowMs()
  while (nowMs() - t0 < 15000 && playing() < 5) {
    await sleep(60)
  }
  // 等一帧渲染完成再读几何：全屏/起播都是异步落地，早读会拿到过渡态
  await nextFrame()
  await sleep(200)
  steps.playingCount = playing()
  h.setOverlay('v1', { boxes: BOXES, live: true, magnification: '×4' })
  await nextFrame()
  await sleep(150)
  steps.alignBeforeFullscreenWorst = worstOf(measure(h, 'v1'))

  /* ── 2. 全屏（由 CDP 造真实手势后调用 enterFullscreen） ── */
  await sleep(200)
  const elBefore = document.querySelector('[data-media-tile="v1"] video')
  const posBefore = status('v1').positionMs
  const fsResult = await h.enterFullscreen('v1')
  let settled = false
  for (let i = 0; i < 100; i++) {
    if (document.fullscreenElement) {
      settled = true
      break
    }
    if (!fsResult.ok) break
    await sleep(50)
  }
  // 全屏落地后仍要等"视口尺寸 → 上报 → 重算 → 重渲染"跑完，否则会量到旧基准
  let fsStable = false
  for (let i = 0; i < 60; i++) {
    await nextFrame()
    const view = h.getViewState('v1')
    if (
      settled &&
      view?.container &&
      Math.abs(view.container.w - window.innerWidth) < 1 &&
      Math.abs(view.container.h - window.innerHeight) < 1
    ) {
      fsStable = true
      break
    }
    await sleep(60)
  }
  await sleep(120)
  steps.fullscreenResult = { ok: fsResult.ok, code: fsResult.code, message: fsResult.message }
  steps.fullscreenSettled = settled
  steps.fullscreenStable = fsStable
  steps.fullscreenElementIsTile = document.fullscreenElement === document.querySelector('[data-media-tile="v1"]')
  steps.fullscreenControllerId = h.getFullscreen()
  steps.viewport = { w: window.innerWidth, h: window.innerHeight }
  const mFs = measure(h, 'v1')
  steps.alignInFullscreen = mFs
  steps.alignInFullscreenWorst = worstOf(mFs)
  // 全屏下容器基准是否已铺满视口（子元素是否跟随）；不达标即为"容器基准"问题
  steps.fullscreenContainerWorst = mFs
    ? Math.max(mFs.overlayDw, mFs.overlayDh, mFs.mediaDw, mFs.mediaDh)
    : null
  steps.progressInFullscreen = status('v1').positionMs
  steps.elementReusedInFullscreen = elBefore !== null && elBefore === document.querySelector('[data-media-tile="v1"] video')

  /* ── 3. 退出全屏：布局恢复 + 进度连续 + 状态收敛（MDP-PLY-05） ── */
  await h.exitFullscreen()
  await sleep(350)
  await nextFrame()
  await sleep(150)
  steps.progressAfterFullscreen = status('v1').positionMs
  steps.progressBeforeFullscreen = posBefore
  steps.fullscreenIdAfterExit = h.getFullscreen()
  steps.fullscreenFlagAfterExit = status('v1').fullscreen
  steps.alignAfterFullscreenWorst = worstOf(measure(h, 'v1'))
  steps.elementReusedAfterExit = elBefore !== null && elBefore === document.querySelector('[data-media-tile="v1"] video')

  /* ── 4. 拖动定位耗时（MDP-PLY-02 / NFR-01：≤ 500ms；真实时钟 + 服务端支持 Range） ── */
  if (status('v1').state !== 'playing') h.play('v1')
  for (let i = 0; i < 100 && status('v1').state !== 'playing'; i++) await sleep(50)
  const seekTimes: Array<{ target: number; ms: number; diag: number | null }> = []
  for (const target of [2000, 5000, 1000, 3000, 4500]) {
    const start = nowMs()
    const r = h.seek('v1', target)
    if (!r.ok) {
      seekTimes.push({ target, ms: -1, diag: null })
      continue
    }
    const t1 = nowMs()
    while (nowMs() - t1 < 3000 && status('v1').diagnostics.seekMs === null) await sleep(20)
    seekTimes.push({ target, ms: Math.round(nowMs() - start), diag: status('v1').diagnostics.seekMs })
  }
  steps.seekTimes = seekTimes
  steps.seekWorstMs = Math.max(...seekTimes.map((s) => s.ms))
  steps.seekDegradedRange = status('v1').degraded.range

  /* ── 5. 六路同屏帧率（真实合成器，3 段采样取中位数） ── */
  if (h.getAllStatus().filter((s) => s.state === 'playing').length < 5) {
    for (const c of h.getChannels()) h.play(c.id)
    await sleep(1200)
  }
  const sample = (ms: number): Promise<{ fps: number; timeout: boolean }> =>
    new Promise((resolve) => {
      let frames = 0
      const start = nowMs()
      let done = false
      const loop = (): void => {
        frames += 1
        const dt = nowMs() - start
        if (dt < ms) requestAnimationFrame(loop)
        else if (!done) {
          done = true
          resolve({ fps: Math.round((frames * 1000) / dt), timeout: false })
        }
      }
      requestAnimationFrame(loop)
      setTimeout(() => {
        if (!done) {
          done = true
          resolve({ fps: 0, timeout: true })
        }
      }, ms + 4000)
    })
  const samples: number[] = []
  const hiddenDuringSampling: boolean[] = []
  for (let i = 0; i < 3; i++) {
    hiddenDuringSampling.push(document.visibilityState !== 'visible')
    samples.push((await sample(1000)).fps)
    await sleep(120)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  steps.fpsSamples = samples
  steps.fpsMedian = sorted[1] ?? 0
  steps.fpsMin = sorted[0] ?? 0
  steps.playingDuringFps = h.getAllStatus().filter((s) => s.state === 'playing').length
  // 不可见/被遮挡的窗口会被浏览器降频（rAF 近乎停摆）→ 此时帧率"不可测"，
  // 由验收脚本按 SKIP 处理，而不是谎报为"达标"或"不达标"
  steps.visibilityState = document.visibilityState
  steps.hiddenDuringSampling = hiddenDuringSampling
  steps.fpsMeasurable =
    samples.some((v) => v > 0) && hiddenDuringSampling.every((hidden) => hidden === false)

  finish({ error: null, steps })
}

declare global {
  interface Window {
    __IK_READY__?: boolean
    __IK_RUN__?: () => void
    __IK_RESULT__?: { error: string | null; steps: Record<string, unknown> }
  }
}

const style = document.createElement('style')
style.textContent = MEDIA_PLAYER_CSS
document.head.appendChild(style)

createRoot(document.getElementById('ik-stage') as HTMLElement).render(<App />)
