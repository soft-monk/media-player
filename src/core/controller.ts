// media-player · 控制器（契约 §2.3 的 37 项成员）
//
// **纯逻辑**：不触碰 DOM、不 import react、不 import 任何其它模块。
// 媒体元素一律通过注入的 `MediaViewPort` 驱动（`src/core/viewport.ts`）；
// 未挂载视图时命令照常计入状态机与诊断 —— 这是"零依赖单测脚本（node 直接跑）"的前提。

import { probeWith, systemClock } from './adapters.ts'
import { pickAudible } from './audio.ts'
import {
  MAX_CONSECUTIVE_FRAME_FAILURES,
  MAX_DECODE_RETRY,
  MEDIA_EVENTS,
  autoColumns,
  cloneDefaultOptions,
} from './constants.ts'
import { MediaEmitter } from './emitter.ts'
import { errText, fail, isRecoverable, ok, okIdempotent } from './errors.ts'
import { expandFrames, resolveFrameUrl } from './frames.ts'
import { clampNumber, mediaContentBox, normToPx } from './geometry.ts'
import { normalizeChannels, normalizeOverlayKeys } from './normalize.ts'
import { buildDiagnostics, buildSummary, initialStatus } from './status.ts'
import type {
  AudioPolicy,
  ChannelKind,
  ChannelState,
  ChannelStatus,
  EmptyReason,
  FitMode,
  IChannelSource,
  IClock,
  IFrameUrlResolver,
  IMediaProbe,
  LayoutMode,
  MediaChannel,
  MediaController,
  MediaControllerInit,
  MediaDiagnosticSnapshot,
  MediaDiagnostics,
  MediaElementHandle,
  MediaErrorCode,
  MediaEvent,
  MediaEventListener,
  MediaPlayerAdapters,
  MediaPlayerOptions,
  MediaResult,
  MediaSetResultData,
  MediaSummary,
  MediaViewPort,
  MediaViewState,
  OverlayContent,
  OverlayKey,
  Rect,
  Size,
} from './types.ts'

/** 无尺寸内容框 */
const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 }

/** 全屏目标的最小结构面（含 webkit 前缀；不依赖 DOM 类型库，node 单测可直接跑） */
interface FullscreenTarget {
  requestFullscreen?: () => Promise<void> | void
  webkitRequestFullscreen?: () => void
}

/** 单通道运行时（控制器内部） */
interface ChannelRuntime {
  status: ChannelStatus
  overlay: OverlayContent
  loadStartedAt: number | null
  seekStartedAt: number | null
  /** 定位截止时刻（`seekTimeoutMs`）；null = 无在途定位（契约 §7.3 定位超时行） */
  seekDeadlineAt: number | null
  /** 在途定位的发起时刻（超时记账用，先于 `seekStartedAt` 被清空） */
  seekAt: number | null
  /** 解码失败重试的截止时刻；null = 无待重试（`MAX_DECODE_RETRY` / 30_02） */
  retryAt: number | null
  playSeq: number
  retries: number
  /**
   * 是否"已请求播放"（用户/autoPlay 意图）。
   *
   * 图像流的解码没有 DOM 事件可依赖：它的"进入播放"由**首帧 onload** 驱动
   * （`reportImageEvent`）。没有这个标志就无法区分"没播过"与"播到一半"，
   * 于是 ready 后既不进 playing 也不排轮播 —— 画面会永久停在第一帧。
   */
  wantPlay: boolean
  frameIndex: number
  frameFailures: number
  /** 图像流下次推进时刻（epoch ms）；null = 未排程 */
  nextFrameAt: number | null
  /** 不可见后延迟暂停的截止时刻 */
  hideAt: number | null
  /** 该通道最近一次状态变更的序号（事件去重口径） */
  lastReportedState: ChannelState
  rangeKnown: boolean
  handle: MediaElementHandle | null
  element: HTMLElement | null
  container: Size | null
  media: Size | null
  box: Rect
  rev: number
  /** box 重算次数（触发点计数，供"重算触发点齐备"的可机检断言使用） */
  boxRev: number
}

interface MediaTimer {
  set(fn: () => void, ms: number): number
  clear(id: number): void
}

const defaultTimer: MediaTimer = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms)
    // node 的 Timeout 与浏览器的 number 均可被 clearTimeout 接受
    return t as unknown as number
  },
  clear: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
}

export interface MediaControllerDeps {
  /** 注入计时器（缺省 setTimeout；测试可注入假计时器以复现节流与轮播） */
  timer?: MediaTimer
}

/** 控制器实现类（对外只以 `MediaController` 接口暴露） */
export class MediaControllerImpl implements MediaController {
  private options: MediaPlayerOptions
  private clock: IClock
  private source: IChannelSource | null
  private resolver: IFrameUrlResolver | null
  private probe: IMediaProbe | null
  private emitter: MediaEmitter
  private timer: MediaTimer
  private onEventCallback: MediaEventListener | undefined

  private channels: MediaChannel[] = []
  private order: string[] = []
  private runtimes = new Map<string, ChannelRuntime>()

  private mainId: string | null = null
  private audibleId: string | null = null
  private fullscreenId: string | null = null
  private layout: LayoutMode = 'grid'
  private policyRejections = 0
  private disposed = false
  private emptyReason: EmptyReason | null = null
  private emptyKey: string | null = null
  private playCounter = 0
  private viewPort: MediaViewPort | null = null
  private tickHandle: number | null = null
  private fps: number | null = null
  private lastProbe = new Map<string, boolean>()
  private inFlight: AbortController | null = null
  private counts = {
    imagesLoaded: 0,
    imagesFailed: 0,
    videoEvents: 0,
    droppedBoxes: 0,
    ignoredEventTypes: 0,
    callbackErrors: 0,
  }

  constructor(init?: MediaControllerInit, deps?: MediaControllerDeps) {
    this.options = cloneDefaultOptions()
    this.clock = systemClock
    this.source = null
    this.resolver = null
    this.probe = null
    this.timer = deps?.timer ?? defaultTimer
    this.emitter = new MediaEmitter(this.options.throttleMs)
    this.onEventCallback = init?.onEvent
    this.onEmptyCallback = init?.onEmpty

    if (init?.options) this.mergeOptions(init.options)
    const adapters = init?.adapters
    if (adapters) {
      if (adapters.clock) this.clock = adapters.clock
      if (adapters.source) this.source = adapters.source
      if (adapters.frameResolver) this.resolver = adapters.frameResolver
      if (adapters.probe) this.probe = adapters.probe
    }

    if (init && 'channels' in init) {
      this.adopt(init.channels)
    } else {
      this.refreshEmptyState()
    }
  }

  /* ================================================================ *
   * 视图桥（不属于 37 项成员；控制器与视图层的最小接触面）
   * ================================================================ */

  setViewPort(port: MediaViewPort | null): void {
    this.viewPort = port
    if (port) {
      for (const id of this.order) {
        const rt = this.runtimes.get(id)
        if (rt?.handle) port.bindMedia(rt.handle)
      }
    }
  }

  setElement(id: string, el: HTMLElement | null): void {
    const rt = this.runtimes.get(id)
    if (rt) rt.element = el
  }

  /** 适配器热更新（组件 props 变化时用；未给的字段保持原值） */
  setAdapters(patch: MediaPlayerAdapters): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      if (patch.clock) this.clock = patch.clock
      if (patch.source) this.source = patch.source
      if (patch.frameResolver) this.resolver = patch.frameResolver
      if (patch.probe) this.probe = patch.probe
      this.lastProbe.clear()
      return v(ok())
    })
  }

  getViewState(id: string): MediaViewState | null {
    const rt = this.runtimes.get(id)
    if (!rt) return null
    return {
      container: rt.container ? { ...rt.container } : null,
      media: rt.media ? { ...rt.media } : null,
      box: { ...rt.box },
      rev: rt.rev,
      boxRev: rt.boxRev,
    }
  }

  /** 视图上报：媒体元素挂载（复用同一实例时也走这里） */
  attachHandle(handle: MediaElementHandle): void {
    const rt = this.runtimes.get(handle.id)
    if (!rt) return
    rt.handle = handle
    this.applyHandleState(handle.id)
    this.viewPort?.bindMedia(handle)
  }

  /** 视图上报：媒体元素卸载 */
  detachHandle(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    rt.handle = null
    this.viewPort?.unbindMedia(id)
  }

  /* ================================================================ *
   * 清单（§2.3-1 ~ 4）
   * ================================================================ */

  setChannels(raw: unknown): MediaResult<MediaSetResultData> {
    if (this.disposed) return fail(1005, '已释放')
    try {
      return this.adopt(raw)
    } catch (e) {
      return fail(1005, `装载清单失败（${errText(e)}）`)
    }
  }

  async refreshChannels(signal?: AbortSignal): Promise<MediaResult<MediaSetResultData>> {
    if (this.disposed) return fail(1005, '已释放')
    if (!this.source) {
      return fail<MediaSetResultData>(1003, '未注入 IChannelSource，无法刷新清单')
    }
    try {
      const raw = await this.source.list(signal)
      if (this.disposed) return fail(1005, '已释放')
      return this.adopt(raw)
    } catch (e) {
      // 失败 MUST 保留现有清单不变并回可读原因（契约 §2.3-2）
      const detail = errText(e)
      this.reportEmpty('source-error', this.channels.length, 0, `清单来源失败：${detail}`)
      return fail<MediaSetResultData>(3001, `清单来源失败：${detail}`)
    }
  }

  getChannels(): MediaChannel[] {
    return this.order.map((id) => cloneChannel(this.channelsById(id) as MediaChannel))
  }

  getChannel(id: string): MediaChannel | null {
    const c = this.channelsById(id)
    return c ? cloneChannel(c) : null
  }

  /* ================================================================ *
   * 状态与诊断（§2.3-5 ~ 9）
   * ================================================================ */

  getStatus(id: string): ChannelStatus | null {
    const rt = this.runtimes.get(id)
    return rt ? cloneStatus(rt.status) : null
  }

  getAllStatus(): ChannelStatus[] {
    return this.order.map((id) => cloneStatus(this.runtimes.get(id)!.status))
  }

  getSummary(): MediaSummary {
    return buildSummary({
      channels: this.channels,
      statuses: this.statusList(),
      mainId: this.mainId,
      audibleId: this.audibleId,
      fullscreenId: this.fullscreenId,
      layout: this.layout,
      emptyReason: this.emptyReason,
      policyRejections: this.policyRejections,
    })
  }

  getDiagnostics(): MediaDiagnostics {
    return buildDiagnostics({
      now: this.clock.nowMs(),
      channels: this.channels,
      statuses: this.statusList(),
      mainId: this.mainId,
      audibleId: this.audibleId,
      fullscreenId: this.fullscreenId,
      layout: this.layout,
      policyRejections: this.policyRejections,
      fps: this.options.measureFps ? this.fps : null,
      disposed: this.disposed,
    })
  }

  subscribe(listener: MediaEventListener): () => void {
    return this.emitter.subscribe(listener)
  }

  /** 诊断快照（计数 + 事件环形缓冲） */
  getDiagnosticSnapshot(): MediaDiagnosticSnapshot {
    return {
      imagesLoaded: this.counts.imagesLoaded,
      imagesFailed: this.counts.imagesFailed,
      videoEvents: this.counts.videoEvents,
      droppedBoxes: this.counts.droppedBoxes,
      ignoredEventTypes: this.counts.ignoredEventTypes + this.emitter.ignoredCount,
      callbackErrors: this.counts.callbackErrors + this.emitter.callbackErrorCount,
      eventLog: this.emitter.snapshot(),
    }
  }

  /** 视图层上报渲染帧率（仅 `measureFps` 开启时有效） */
  reportFps(fps: number | null): void {
    this.fps = fps
  }

  /* ================================================================ *
   * 播放控制（§2.3-10 ~ 21）
   * ================================================================ */

  play(id: string): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const ch = this.channelsById(id) as MediaChannel
      if (!ch.available) return v(fail(1003, ch.unavailableReason ?? '通道不可用'))

      if (rt.status.state === 'playing') return v(okIdempotent())
      // 已在装载中：重复 play 同样幂等，MUST NOT 重新起一次加载（CTR-MDP-EC-02）
      if (rt.status.state === 'loading') return v(okIdempotent())
      if (!rt.status.visible && this.options.lazyVisibility) {
        this.policyRejections += 1
        return v(fail(3004, '通道不可见且策略拒绝起播'))
      }

      this.playCounter += 1
      rt.playSeq = this.playCounter
      rt.wantPlay = true
      rt.loadStartedAt = rt.loadStartedAt ?? this.clock.nowMs()
      rt.retries = 0
      rt.retryAt = null
      rt.frameFailures = 0
      // 图像流已就绪/已暂停时 MUST NOT 退回 loading：它没有 DOM 事件能把它带回 playing，
      // 一旦退回就再也不会推进（画面卡死在当前帧）。
      const prevState: ChannelState = rt.status.state
      const drawn: ChannelState[] = ['ready', 'paused', 'playing']
      const alreadyDrawn = ch.kind === 'image-seq' && drawn.includes(prevState)
      this.setState(rt, alreadyDrawn ? 'playing' : 'loading', { reason: null, errorCode: null })

      // 命令先于元素挂载也不能丢：applyHandleState 在 handle 到位时补齐
      rt.handle?.play()
      this.applyHandleState(id)
      /**
       * 视图层可播确认（MAY 不实现）：`canPlay()` 为真时**不等事件**直接进 playing。
       *
       * 视频元素有自己的 'playing' 事件，等事件即可；图像流在暂停后再播放时**不会**再触发
       * 首帧 onload（src 未变、图已缓存），没有任何事件能把它带回 playing —— 若这里不收敛，
       * 它会永久停在 loading，画面不再换帧（MDP-PLY-06）。
       */
      const canPlayNow = rt.handle?.canPlay?.() === true
      if (canPlayNow) {
        this.setState(rt, 'playing')
      }

      if (ch.kind === 'video' && !rt.rangeKnown) {
        rt.rangeKnown = true
        void this.detectRange(ch)
      }
      this.scheduleTick()
      this.recomputeAudible()
      return v(ok())
    })
  }

  pause(id: string): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      if (rt.status.state === 'paused') return v(okIdempotent())
      if (rt.status.state === 'error') return v(fail(1003, rt.status.reason ?? '通道处于错误态'))
      rt.wantPlay = false
      rt.handle?.pause()
      // 图像流：暂停即停节拍，MUST NOT 残留待触发的推进（否则暂停后仍会跳帧）
      rt.nextFrameAt = null
      this.setState(rt, 'paused')
      this.scheduleTick()
      this.recomputeAudible()
      return v(ok())
    })
  }

  stop(id: string): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      if (rt.status.state === 'idle' && rt.status.positionMs === 0) return v(okIdempotent())
      rt.handle?.stop()
      rt.frameIndex = 0
      rt.nextFrameAt = null
      rt.loadStartedAt = null
      rt.frameFailures = 0
      rt.seekStartedAt = null
      rt.seekAt = null
      rt.seekDeadlineAt = null
      rt.wantPlay = false
      this.setState(rt, 'idle', {
        positionMs: 0,
        frameIndex: 0,
        bufferedMs: 0,
        errorCode: null,
        reason: null,
      })
      this.applyHandleState(id)
      this.recomputeAudible()
      return v(ok())
    })
  }

  toggle(id: string): MediaResult {
    const rt = this.runtimes.get(id)
    if (!rt) return fail(1004, `通道不存在：${id}`)
    if (rt.status.state === 'playing') return this.pause(id)
    return this.play(id)
  }

  seek(id: string, positionMs: number): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const ch = this.channelsById(id) as MediaChannel
      if (ch.kind !== 'video') return v(fail(1000, 'image-seq 通道不支持 seek（用 frame 或 stepFrame）'))
      if (rt.status.state === 'idle' || rt.status.state === 'loading') {
        return v(fail(1003, '通道尚未就绪，无法定位'))
      }
      if (typeof positionMs !== 'number' || !Number.isFinite(positionMs)) {
        return v(fail(1000, 'positionMs 非有限数'))
      }

      const duration = rt.status.durationMs
      let target = Math.max(0, positionMs)
      let clamped = false
      if (duration !== null && target > duration) {
        target = duration
        clamped = true
      }
      rt.seekStartedAt = this.clock.nowMs()
      rt.seekAt = rt.seekStartedAt
      // 定位超时 MUST 被判为 Range 降级并记入 seekMs（契约 §7.3「定位超 seekTimeoutMs」行）
      rt.seekDeadlineAt = rt.seekStartedAt + Math.max(1, this.options.seekTimeoutMs)
      rt.handle?.seek(target)
      this.patchStatus(rt, { positionMs: target })
      this.scheduleTick()

      const degraded = rt.status.degraded
      if (degraded.range) {
        // 无 Range 时 MUST 给可读提示，MUST NOT 静默失败（MDP-PLY-02）
        const r = ok(undefined, { clamped })
        return v({ ...r, message: degraded.hint ?? '当前源不支持 Range，定位可能不生效' })
      }
      return v(ok(undefined, { clamped }))
    })
  }

  setVolume(id: string, volume: number): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const finite = typeof volume === 'number' && Number.isFinite(volume)
      const next = clampNumber(volume, 0, 1, this.options.defaultVolume)
      const clamped = !finite || next !== volume
      this.patchStatus(rt, { volume: next })
      rt.handle?.setVolume(next)
      return v(ok(undefined, { clamped }))
    })
  }

  mute(id: string, muted?: boolean): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const next = muted === undefined ? true : !!muted
      if (rt.status.userMuted === next) {
        // CTR-MDP-AU-03：策略覆盖时仍回 code 0 + policyOverride
        if (!next && rt.status.mutedByPolicy) return v(okIdempotent({ policyOverride: true }))
        return v(okIdempotent())
      }
      this.patchStatus(rt, { userMuted: next })
      this.recomputeAudible()
      if (!next && rt.status.mutedByPolicy) return v(ok({ policyOverride: true }))
      return v(ok())
    })
  }

  setRate(id: string, rate: number): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      if (typeof rate !== 'number' || !this.options.rateOptions.includes(rate)) {
        return v(fail(1000, `rate 必须 ∈ [${this.options.rateOptions.join(', ')}]`))
      }
      this.patchStatus(rt, { rate })
      rt.handle?.setRate(rate)
      const ch = this.channelsById(id) as MediaChannel
      if (ch.kind === 'image-seq') this.scheduleFrame(rt, this.clock.nowMs())
      return v(ok())
    })
  }

  stepFrame(id: string, delta = 1): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const ch = this.channelsById(id) as MediaChannel
      if (rt.status.state === 'idle' || rt.status.state === 'loading') {
        return v(fail(1003, '通道尚未就绪，无法步进'))
      }
      if (!Number.isFinite(delta) || Math.floor(delta) === 0) {
        return v(fail(1000, 'delta 必须是非零整数'))
      }
      const step = Math.floor(delta)

      if (ch.kind === 'image-seq') {
        rt.handle?.pause()
        this.setState(rt, 'paused')
        const total = Math.max(1, ch.frameCount)
        const next = (((rt.frameIndex + step) % total) + total) % total
        rt.frameIndex = next
        rt.nextFrameAt = null
        this.patchStatus(rt, { frameIndex: next, positionMs: next * ch.frameIntervalMs })
        this.emitFrame(rt, true)
        this.recomputeAudible()
        return v(ok())
      }

      // video：MUST 先暂停再推进一帧（fps 未知时用 stepFallbackMs）
      rt.handle?.pause()
      this.setState(rt, 'paused')
      const duration = rt.status.durationMs
      let target = rt.status.positionMs + step * this.options.stepFallbackMs
      if (duration !== null && target > duration) target = duration
      if (target < 0) target = 0
      rt.seekStartedAt = this.clock.nowMs()
      rt.handle?.seek(target)
      this.patchStatus(rt, { positionMs: target })
      this.recomputeAudible()
      return v(ok())
    })
  }

  setLoop(id: string, loop: boolean): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const next = !!loop
      if (rt.status.loop === next) return v(okIdempotent())
      this.patchStatus(rt, { loop: next })
      rt.handle?.setLoop(next)
      return v(ok())
    })
  }

  setFrameInterval(id: string, ms: number): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const ch = this.channelsById(id) as MediaChannel
      if (ch.kind !== 'image-seq') return v(fail(1000, 'setFrameInterval 仅适用于 image-seq 通道'))
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
        return v(fail(1000, 'ms 必须是正的有限数'))
      }
      const min = this.options.minFrameIntervalMs
      const next = Math.max(min, ms)
      const clamped = next !== ms
      const idx = this.channels.findIndex((c) => c.id === id)
      if (idx >= 0) this.channels[idx] = { ...this.channels[idx], frameIntervalMs: next }
      rt.status.diagnostics.throttleMs = next
      rt.status.diagnostics.updatedAt = this.clock.nowMs()
      this.scheduleFrame(rt, this.clock.nowMs())
      return v(ok(undefined, { clamped }))
    })
  }

  pushFrame(id: string, frame: string | number): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const ch = this.channelsById(id) as MediaChannel
      if (ch.kind !== 'image-seq') return v(fail(1000, 'pushFrame 仅适用于 image-seq 通道'))

      if (typeof frame === 'number') {
        if (!Number.isFinite(frame)) return v(fail(1000, '帧下标非有限数'))
        const total = Math.max(1, ch.frameCount)
        const idx = Math.floor(frame)
        if (idx < 0 || idx >= total) return v(fail(1004, `帧下标越界：${idx}/${total}`))
        rt.frameIndex = idx
        rt.nextFrameAt = null
        this.patchStatus(rt, { frameIndex: idx, positionMs: idx * ch.frameIntervalMs })
        this.emitFrame(rt, true)
        return v(ok())
      }

      if (typeof frame !== 'string' || frame.length === 0) return v(fail(1000, '帧 URL 非法'))
      // 实时推帧：新帧进有界缓存（上限 bufferLimitFrames）
      const frames = ch.frames ?? []
      const next = [frame, ...frames.filter((u) => u !== frame)]
      const bounded = next.slice(0, Math.max(1, this.options.bufferLimitFrames))
      const idx = this.channels.findIndex((c) => c.id === id)
      if (idx >= 0) {
        this.channels[idx] = { ...this.channels[idx], frames: bounded, frameCount: bounded.length }
      }
      rt.status.frameCount = bounded.length
      rt.frameIndex = 0
      rt.nextFrameAt = null
      rt.frameFailures = 0
      this.patchStatus(rt, { frameIndex: 0, positionMs: 0 })
      rt.handle?.setFrame(0, frame)
      this.emitFrame(rt, true)
      return v(ok())
    })
  }

  /* ================================================================ *
   * 布局、主路与全屏（§2.3-22 ~ 30）
   * ================================================================ */

  setMain(id: string | null): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      if (id !== null && !this.runtimes.has(id)) return v(fail(1004, `通道不存在：${id}`))
      if (this.mainId === id) return v(okIdempotent())
      const prev = this.mainId
      this.mainId = id
      this.recomputeAudible()
      this.emitStateChange(id ?? prev)
      return v(ok())
    })
  }

  getMain(): string | null {
    return this.mainId
  }

  getAudible(): string | null {
    return this.audibleId
  }

  setVisible(id: string, visible: boolean): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const next = !!visible
      if (rt.status.visible === next) return v(okIdempotent())
      rt.status.visible = next
      const now = this.clock.nowMs()
      if (!next) {
        if (this.options.lazyVisibility) rt.hideAt = now + this.options.hiddenPauseDelayMs
      } else {
        rt.hideAt = null
        if (rt.status.diagnostics.pausedByPolicy) {
          rt.status.diagnostics.pausedByPolicy = false
          rt.status.diagnostics.updatedAt = now
          if (rt.status.state === 'paused') {
            rt.handle?.play()
            this.setState(rt, 'playing')
          }
          this.scheduleFrame(rt, now)
        }
      }
      this.recomputeAudible()
      this.scheduleTick()
      return v(ok())
    })
  }

  setLayout(mode: LayoutMode): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      if (mode !== 'grid' && mode !== 'focus') return v(fail(1000, `layout 非法：${String(mode)}`))
      if (this.layout === mode) return v(okIdempotent())
      this.layout = mode
      return v(ok())
    })
  }

  getLayout(): LayoutMode {
    return this.layout
  }

  async enterFullscreen(id: string): Promise<MediaResult> {
    if (this.disposed) return fail(1005, '已释放')
    const rt = this.runtimes.get(id)
    if (!rt) return fail(1004, `通道不存在：${id}`)
    if (this.fullscreenId && this.fullscreenId !== id) {
      return fail(1002, `通道 ${this.fullscreenId} 正在全屏，互斥拒绝`)
    }
    if (!this.hasFullscreenApi()) return fail(3005, '当前环境无 Fullscreen API')
    if (this.fullscreenId === id) return okIdempotent()
    try {
      const el = rt.element as FullscreenTarget | null
      if (el) {
        // 优先整个 tile（含叠加层与控制条）；不支持时退到媒体元素本身。
        // MUST 复用同一媒体元素（MUST NOT 重建），故进度不受影响（MDP-PLY-05）。
        if (typeof el.requestFullscreen === 'function') await el.requestFullscreen()
        else if (typeof el.webkitRequestFullscreen === 'function') el.webkitRequestFullscreen()
      }
      this.fullscreenId = id
      this.patchStatus(rt, { fullscreen: true })
      this.recomputeBox(rt)
      return ok()
    } catch (e) {
      return fail(3005, `进入全屏被拒绝：${errText(e)}`)
    }
  }

  async exitFullscreen(): Promise<MediaResult> {
    if (this.disposed) return fail(1005, '已释放')
    const id = this.fullscreenId
    if (!id) return okIdempotent()
    try {
      const doc = (globalThis as { document?: Document }).document
      if (doc && typeof doc.exitFullscreen === 'function') await doc.exitFullscreen()
    } catch {
      /* 退出失败不阻断内部状态收敛 */
    }
    this.fullscreenId = null
    const rt = this.runtimes.get(id)
    if (rt) {
      this.patchStatus(rt, { fullscreen: false })
      this.recomputeBox(rt)
    }
    return ok()
  }

  getFullscreen(): string | null {
    return this.fullscreenId
  }

  /* ================================================================ *
   * 叠加层（§2.3-31 ~ 33）
   * ================================================================ */

  setOverlay(id: string, patch: Partial<OverlayContent>): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      rt.overlay = mergeOverlay(rt.overlay, patch)
      rt.rev += 1
      return v(ok())
    })
  }

  toggleOverlay(id: string, key: OverlayKey, on?: boolean): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const rt = this.runtimes.get(id)
      if (!rt) return v(fail(1004, `通道不存在：${id}`))
      const known = normalizeOverlayKeys([key])
      if (!known || known.length === 0) return v(fail(1000, `叠加项非法：${String(key)}`))
      const ch = this.channelsById(id) as MediaChannel
      const set = new Set(ch.overlayKeys)
      const next = on === undefined ? !set.has(key) : !!on
      if (next) set.add(key)
      else set.delete(key)
      const keys = normalizeOverlayKeys(Array.from(set)) ?? []
      const idx = this.channels.findIndex((c) => c.id === id)
      if (idx >= 0) this.channels[idx] = { ...this.channels[idx], overlayKeys: keys }
      rt.rev += 1
      return v(ok())
    })
  }

  getOverlay(id: string): OverlayContent {
    const rt = this.runtimes.get(id)
    return rt ? cloneOverlay(rt.overlay) : {}
  }

  /* ================================================================ *
   * 元素、配置与生命周期（§2.3-34 ~ 37）
   * ================================================================ */

  getElement(id: string): HTMLElement | null {
    return this.runtimes.get(id)?.element ?? null
  }

  getOptions(): MediaPlayerOptions {
    return cloneOptions(this.options)
  }

  setOptions(patch: Partial<MediaPlayerOptions>): MediaResult {
    return this.guardCall((v): MediaResult<never> => {
      const applied = this.mergeOptions(patch ?? {})
      const clamped = applied.clampedFields.length > 0
      const rejected = applied.rejectedFields.length > 0
      if (rejected) {
        return v(
          fail(
            1000,
            `下列字段取值非法，已保留原值：${applied.rejectedFields.join('、')}`,
            undefined,
            clamped,
          ),
        )
      }
      return v(ok(undefined, { clamped }))
    })
  }

  dispose(): void {
    if (this.disposed) return
    for (const id of this.order) {
      const rt = this.runtimes.get(id)
      if (!rt) continue
      try {
        rt.handle?.stop()
      } catch {
        /* 忽略 */
      }
      this.viewPort?.unbindMedia(id)
      rt.handle = null
      rt.element = null
      rt.nextFrameAt = null
      rt.hideAt = null
      rt.seekDeadlineAt = null
      rt.seekAt = null
      rt.retryAt = null
      rt.status.muted = true
      rt.status.audible = false
    }
    if (this.tickHandle !== null) {
      this.timer.clear(this.tickHandle)
      this.tickHandle = null
    }
    this.inFlight?.abort()
    this.inFlight = null
    this.audibleId = null
    this.disposed = true
    this.emitter.clear()
  }

  /** 是否已释放（诊断用） */
  get isDisposed(): boolean {
    return this.disposed
  }

  /* ================================================================ *
   * 视图层上报入口（不属于公开契约；由 src/react/** 调用）
   * ================================================================ */

  /** 容器实测尺寸变化（ResizeObserver 触发） */
  reportContainerSize(id: string, size: Size | null): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    rt.container = sanitizeSize(size)
    this.recomputeBox(rt)
  }

  /** 媒体元素实测尺寸变化（loadedmetadata / 首帧 / object-fit 变化） */
  reportMediaSize(id: string, size: Size | null): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    rt.media = sanitizeSize(size)
    if (rt.media) rt.status.videoSize = { ...rt.media }
    this.recomputeBox(rt)
  }

  /**
   * 视图层通知：该通道当前是否处于原生全屏态（`document.fullscreenElement` 就是本通道的元素）。
   *
   * 全屏时画面基准是整个视口（契约 §8.3 全屏重算）；`inFullscreen=false` 覆盖
   * ESC / 浏览器手势退出 —— 控制器状态 MUST 跟着收敛，否则叠加层基准会漂移（MDP-OVL-04）。
   */
  reportFullscreenElement(id: string, inFullscreen: boolean): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    if (inFullscreen) {
      this.fullscreenId = id
      rt.status.fullscreen = true
      this.recomputeBox(rt)
      return
    }
    if (this.fullscreenId === id) this.fullscreenId = null
    rt.status.fullscreen = false
    this.recomputeBox(rt)
  }

  /** 媒体元素事件上报（loadeddata / seeked / error / timeupdate / ...） */
  reportMediaEvent(id: string, name: string, payload?: unknown): void {
    if (this.disposed) return
    const rt = this.runtimes.get(id)
    if (!rt) return
    this.counts.videoEvents += 1
    const now = this.clock.nowMs()
    switch (name) {
      case 'loadstart':
        rt.loadStartedAt = rt.loadStartedAt ?? now
        break
      case 'loadeddata':
      case 'loadedmetadata': {
        const size = readPayloadSize(payload)
        if (size) {
          rt.media = size
          rt.status.videoSize = { ...size }
        }
        const duration = readPayloadNumber(payload, 'durationMs')
        if (duration !== null) rt.status.durationMs = duration
        if (rt.status.state === 'loading') {
          rt.status.diagnostics.loadMs =
            rt.loadStartedAt === null ? null : Math.max(0, now - rt.loadStartedAt)
          rt.status.diagnostics.updatedAt = now
          this.setState(rt, 'ready')
        }
        this.recomputeBox(rt)
        // 图像流的轮播节拍由状态驱动：就绪/播放都要重新排程
        this.scheduleTick()
        break
      }
      case 'playing':
        if (rt.status.state !== 'playing') this.setState(rt, 'playing')
        // 进入 playing MUST 重新仲裁出声（MDP-PLY-03：候选集含 state==='playing'，
        // 不在这一刻复算，通道会"在播但永不出声"）
        this.recomputeAudible()
        // 图像流：进入 playing 才开始轮播（MDP-PLY-06）
        this.scheduleTick()
        break
      case 'play':
        if (rt.status.state === 'idle') this.setState(rt, 'loading')
        break
      case 'pause':
        if (rt.status.state === 'playing') this.setState(rt, 'paused')
        break
      case 'waiting':
        rt.status.diagnostics.bufferingCount += 1
        rt.status.diagnostics.updatedAt = now
        break
      case 'timeupdate': {
        const pos = readPayloadNumber(payload, 'positionMs')
        if (pos !== null) rt.status.positionMs = pos
        const buffered = readPayloadNumber(payload, 'bufferedMs')
        if (buffered !== null) rt.status.bufferedMs = buffered
        rt.status.diagnostics.updatedAt = now
        break
      }
      case 'seeked': {
        const pos = readPayloadNumber(payload, 'positionMs')
        if (pos !== null) rt.status.positionMs = pos
        // 定位在时限内完成：清掉超时排程（否则会被误判为 Range 降级）
        rt.seekDeadlineAt = null
        rt.seekAt = null
        if (rt.seekStartedAt !== null) {
          rt.status.diagnostics.seekMs = Math.max(0, now - rt.seekStartedAt)
          rt.seekStartedAt = null
        }
        rt.status.diagnostics.updatedAt = now
        break
      }
      case 'ended':
        this.setState(rt, 'paused', { positionMs: rt.status.durationMs ?? rt.status.positionMs })
        this.recomputeAudible()
        break
      case 'droppedframes': {
        const n = readPayloadNumber(payload, 'count')
        if (n !== null) rt.status.diagnostics.droppedFrames = n
        break
      }
      case 'autoplayblocked':
        this.reportDegraded(id, 'autoplay', '浏览器拒绝自动播放，需用户交互后重试')
        break
      case 'error': {
        const code = readPayloadNumber(payload, 'errorCode') ?? 3002
        const reason = readPayloadString(payload, 'reason') ?? '媒体加载或解码失败'
        // 退避重试（上限 MAX_DECODE_RETRY）：视图层可带 retryAfterMs 覆盖退避（CSP 等场景）
        const retryAfter = readPayloadNumber(payload, 'retryAfterMs')
        this.failChannel(rt, code, reason)
        this.scheduleRetry(rt, code, retryAfter ?? undefined)
        break
      }
      case 'stalled':
        // 媒体元素声明解码停滞：与解码失败同路径（含退避重试）
        this.failWithRetry(
          rt,
          readPayloadNumber(payload, 'errorCode') ?? 3002,
          readPayloadString(payload, 'reason') ?? '解码停滞',
        )
        break
      default:
        break
    }
  }

  /** 媒体元素命令结果回执（`play()` 被 Promise 拒绝等） */
  reportMediaCommandError(id: string, name: string, reason: string): void {
    const rt = this.runtimes.get(id)
    if (!rt) return
    if (name === 'play' && rt.status.state === 'loading') {
      // 自动播放被拒：MUST NOT 循环重试（契约 §7.3）
      this.reportDegraded(id, 'autoplay', reason)
      this.setState(rt, 'ready', { reason: null, errorCode: null })
      return
    }
    // 其余命令失败按"源不可达"处理，并走退避重试（上限 MAX_DECODE_RETRY）
    this.failWithRetry(rt, 3001, reason)
  }

  /** 帧图片 onload / onerror（image-seq） */
  reportImageEvent(id: string, index: number, okFlag: boolean, url?: string): void {
    if (this.disposed) return
    const rt = this.runtimes.get(id)
    if (!rt) return
    const now = this.clock.nowMs()
    if (okFlag) {
      this.counts.imagesLoaded += 1
      rt.frameFailures = 0
      if (rt.status.state === 'loading') {
        rt.status.diagnostics.loadMs =
          rt.loadStartedAt === null ? null : Math.max(0, now - rt.loadStartedAt)
        rt.status.diagnostics.updatedAt = now
        // 图像流没有 DOM "playing" 事件：首帧可绘 + 已请求播放 ⇒ 直接进 playing，
        // 轮播节拍由此开始（MDP-PLY-06）。未请求播放则停在 ready（首帧已可绘）。
        this.setState(rt, rt.wantPlay ? 'playing' : 'ready')
        this.recomputeAudible()
        this.scheduleTick()
      }
      if (rt.status.frameIndex !== index) {
        rt.status.frameIndex = index
        this.emitFrame(rt, true)
      }
      return
    }
    this.counts.imagesFailed += 1
    rt.frameFailures += 1
    rt.status.diagnostics.droppedFrames += 1
    rt.status.diagnostics.updatedAt = now
    if (rt.frameFailures >= MAX_CONSECUTIVE_FRAME_FAILURES) {
      this.failChannel(rt, 3003, `帧加载连续失败 ${rt.frameFailures} 次${url ? `（${url}）` : ''}`)
    }
  }

  /** 视图层请求渲染帧率统计（`measureFps` 为 false 时不启动） */
  shouldMeasureFps(): boolean {
    return this.options.measureFps && !this.disposed
  }

  /** 供视图层读取的生效叠加基准（单一来源，CTR-MDP-OVL-01） */
  getContentBox(id: string): Rect {
    return { ...(this.runtimes.get(id)?.box ?? ZERO_RECT) }
  }

  /** 供视图层读取的帧 URL（image-seq 当前帧） */
  getFrameUrl(id: string): string | null {
    const rt = this.runtimes.get(id)
    if (!rt) return null
    const ch = this.channelsById(id)
    if (!ch || ch.kind !== 'image-seq') return null
    return resolveFrameUrl(ch, rt.frameIndex, this.resolver ?? undefined)
  }

  /**
   * 视图层专用：指定下标处**必须**能解析出帧 URL（返回解析器而非完整帧数组）。
   *
   * 视图层拿不到 `channels`/`runtimes`，若改用 `getFrames(id)[index]`，模板通道会
   * 依赖数组长度与下标一致，一旦不一致就静默停帧。这里让渲染侧与控制器共用
   * `resolveFrameUrl` 这**一个**解析入口。
   */
  resolveFrameUrlAt(id: string, index: number): string | null {
    const ch = this.channelsById(id)
    if (!ch || ch.kind !== 'image-seq') return null
    return resolveFrameUrl(ch, index, this.resolver ?? undefined)
  }

  /** 视图层上报：被判定不渲染的叠加框数量（契约 §8.4「计入叠加层诊断计数」） */
  reportDroppedBoxes(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return
    this.counts.droppedBoxes += Math.floor(count)
  }

  /**
   * 供视图层读取的结果帧展开。
   *
   * 有界口径（契约 §9）：`bufferLimitFrames` 只裁剪**显式帧数组**（`frames`，含 `pushFrame`
   * 实时推入的那些），模板展开的帧是合成 URL、不占缓冲，MUST NOT 被裁剪 ——
   * 否则模板通道超过上限后 `frames[index]` 恒空，画面会停在最后一帧（MDP-PLY-06）。
   */
  getFrames(id: string): string[] {
    const ch = this.channelsById(id)
    if (!ch || ch.kind !== 'image-seq') return []
    const all = expandFrames(ch, this.resolver ?? undefined)
    if (ch.frames && ch.frames.length > 0) {
      return all.slice(0, Math.max(1, this.options.bufferLimitFrames))
    }
    return all
  }

  /** 供视图层读取的预加载帧（`preloadFrames`，有界） */
  getPreloadUrls(id: string): string[] {
    const ch = this.channelsById(id)
    if (!ch || ch.kind !== 'image-seq') return []
    const rt = this.runtimes.get(id)
    if (!rt) return []
    const n = Math.max(0, Math.min(2, this.options.preloadFrames))
    const out: string[] = []
    for (let k = 1; k <= n; k++) {
      const url = resolveFrameUrl(ch, (rt.frameIndex + k) % Math.max(1, ch.frameCount), this.resolver ?? undefined)
      if (url) out.push(url)
    }
    return out
  }

  /* ================================================================ *
   * 内部：清单装载
   * ================================================================ */

  private adopt(raw: unknown): MediaResult<MediaSetResultData> {
    const norm = normalizeChannels(raw, this.options)
    if (!norm.ok || norm.code === 1006) {
      // schema 不符 / 形状不受支持：拒绝装载，现有清单保持不变
      const reason: EmptyReason = norm.code === 1006 ? 'schema-mismatch' : 'no-channels'
      this.reportEmpty(reason, norm.data?.total ?? 0, 0, norm.message)
      return { ok: false, code: norm.code, message: norm.message, data: undefined }
    }

    const incoming = norm.channels
    const rejected = [...(norm.data?.rejected ?? [])]
    const applied: string[] = []
    const nextChannels: MediaChannel[] = []
    const nextRuntimes = new Map<string, ChannelRuntime>()
    const now = this.clock.nowMs()
    const perKind: Record<ChannelKind, number> = { video: 0, 'image-seq': 0 }

    for (const ch of incoming) {
      // 上限保护（MDP-MUL-02）：超限不渲染不加载，给出可读原因，MUST NOT 静默丢
      if (nextChannels.length >= this.options.maxChannels) {
        this.policyRejections += 1
        rejected.push({
          index: this.channels.findIndex((c) => c.id === ch.id),
          code: 3004,
          reason: `超过 maxChannels=${this.options.maxChannels}，通道 ${ch.id} 未装载`,
        })
        this.reportPolicyRejection(ch.id, `超过 maxChannels=${this.options.maxChannels}`)
        continue
      }
      const limit = this.options.maxChannelsByKind[ch.kind] ?? this.options.maxChannels
      if (perKind[ch.kind] >= limit) {
        this.policyRejections += 1
        rejected.push({
          index: this.channels.findIndex((c) => c.id === ch.id),
          code: 3004,
          reason: `超过 maxChannelsByKind['${ch.kind}']=${limit}，通道 ${ch.id} 未装载`,
        })
        this.reportPolicyRejection(ch.id, `超过 maxChannelsByKind['${ch.kind}']=${limit}`)
        continue
      }
      perKind[ch.kind] += 1
      nextChannels.push(ch)
      applied.push(ch.id)

      const prev = this.runtimes.get(ch.id)
      const prevChannel = this.channelsById(ch.id)
      const sameSource =
        !!prev &&
        !!prevChannel &&
        prevChannel.url === ch.url &&
        prevChannel.kind === ch.kind &&
        (prevChannel.frames?.length ?? 0) === (ch.frames?.length ?? 0)

      if (sameSource && prev) {
        // 同 id 且 url/kind 未变 MUST 复用媒体元素与播放位置（MUST NOT 重建）
        prev.status.kind = ch.kind
        prev.status.loop = ch.loop
        prev.status.frameCount = ch.frameCount
        nextRuntimes.set(ch.id, prev)
      } else {
        if (prev) {
          try {
            prev.handle?.stop()
          } catch {
            /* 忽略 */
          }
          this.viewPort?.unbindMedia(ch.id)
        }
        const rt: ChannelRuntime = {
          status: initialStatus(ch, {
            now,
            volume: this.options.defaultVolume,
            throttleMs: ch.kind === 'image-seq' ? ch.frameIntervalMs : this.options.throttleMs,
          }),
          overlay: {},
          loadStartedAt: null,
          seekStartedAt: null,
          seekDeadlineAt: null,
          seekAt: null,
          retryAt: null,
          playSeq: 0,
          retries: 0,
          wantPlay: false,
          frameIndex: 0,
          frameFailures: 0,
          nextFrameAt: null,
          hideAt: null,
          lastReportedState: 'idle',
          rangeKnown: false,
          handle: null,
          element: null,
          container: null,
          media: null,
          box: { ...ZERO_RECT },
          rev: 0,
          boxRev: 0,
        }
        nextRuntimes.set(ch.id, rt)
      }
    }

    // 被移除的通道 MUST 在返回前释放（停止解码、清缓冲、置静音）
    for (const id of this.order) {
      if (nextRuntimes.has(id)) continue
      const dead = this.runtimes.get(id)
      if (!dead) continue
      try {
        dead.handle?.stop()
      } catch {
        /* 忽略 */
      }
      this.viewPort?.unbindMedia(id)
      dead.handle = null
      dead.element = null
      dead.nextFrameAt = null
      dead.seekDeadlineAt = null
      dead.seekAt = null
      dead.retryAt = null
      dead.status.muted = true
      dead.status.audible = false
      if (this.fullscreenId === id) this.fullscreenId = null
    }

    this.channels = nextChannels
    this.order = nextChannels.map((c) => c.id)
    this.runtimes = nextRuntimes
    if (this.mainId && !this.runtimes.has(this.mainId)) this.mainId = null

    // 自动起播（浏览器策略可能拒绝 → 降级而非失败）
    if (this.options.autoPlay) {
      for (const ch of nextChannels) {
        if (ch.available) this.play(ch.id)
      }
    }

    this.recomputeAudible()
    this.refreshEmptyState()
    this.scheduleTick()

    const data: MediaSetResultData = {
      total: norm.data?.total ?? incoming.length,
      applied,
      rejected,
      usable: nextChannels.filter((c) => c.available).length,
      schemaVersion: norm.data?.schemaVersion ?? null,
    }
    return ok(data)
  }

  /* ================================================================ *
   * 内部：状态机
   * ================================================================ */

  private setState(
    rt: ChannelRuntime,
    state: ChannelState,
    extra?: {
      reason?: string | null
      errorCode?: MediaErrorCode | null
      positionMs?: number
      frameIndex?: number
      bufferedMs?: number
    },
  ): void {
    const now = this.clock.nowMs()
    const prev = rt.status.state
    if (prev === state && extra === undefined) return

    rt.status.state = state
    rt.status.since = now
    if (extra) {
      if ('reason' in extra) rt.status.reason = extra.reason ?? null
      if ('errorCode' in extra) rt.status.errorCode = extra.errorCode ?? null
      if (extra.positionMs !== undefined) rt.status.positionMs = extra.positionMs
      if (extra.frameIndex !== undefined) rt.status.frameIndex = extra.frameIndex
      if (extra.bufferedMs !== undefined) rt.status.bufferedMs = extra.bufferedMs
    }
    if (state !== 'error' && !(extra && 'reason' in extra)) {
      // 非 error 态默认清空错误痕迹；但**显式给出的可读原因**（如"不可见已暂停""已到末帧"）
      // MUST 保留，否则宿主拿到"暂停了但不知道为什么"（MDP-DGR-01 要求原因可读）
      rt.status.reason = null
      rt.status.errorCode = null
    } else if (state !== 'error' && extra && extra.reason) {
      rt.status.errorCode = null
    }
    rt.status.diagnostics.updatedAt = now

    if (prev !== state) {
      rt.lastReportedState = state
      const payload = {
        channelId: rt.status.id,
        kind: rt.status.kind,
        state,
        prevState: prev,
        at: now,
        ...(rt.status.reason ? { reason: rt.status.reason } : {}),
        ...(rt.status.errorCode !== null ? { errorCode: rt.status.errorCode } : {}),
      }
      this.emit({ type: MEDIA_EVENTS.state, data: payload, ts: now }, rt.status.id)
      this.safeCallback(this.onChannelState, cloneStatus(rt.status))
    }
  }

  private patchStatus(rt: ChannelRuntime, patch: Partial<ChannelStatus>): void {
    Object.assign(rt.status, patch)
    rt.status.diagnostics.updatedAt = this.clock.nowMs()
  }

  private failChannel(rt: ChannelRuntime, code: number, reason: string): void {
    const now = this.clock.nowMs()
    rt.status.diagnostics.loadFailures += 1
    rt.status.diagnostics.lastErrorAt = now
    rt.status.diagnostics.updatedAt = now
    const errorCode = code as MediaErrorCode
    this.setState(rt, 'error', { reason, errorCode })
    this.emit(
      {
        type: MEDIA_EVENTS.error,
        data: {
          channelId: rt.status.id,
          errorCode,
          reason,
          recoverable: isRecoverable(errorCode),
          at: now,
        },
        ts: now,
      },
      undefined,
      true,
    )
    this.recomputeAudible()
  }

  private emitStateChange(id: string | null): void {
    if (!id) return
    const rt = this.runtimes.get(id)
    if (!rt) return
    const now = this.clock.nowMs()
    this.emit(
      {
        type: MEDIA_EVENTS.state,
        data: {
          channelId: id,
          kind: rt.status.kind,
          state: rt.status.state,
          prevState: rt.status.state,
          at: now,
        },
        ts: now,
      },
      id,
    )
  }

  /* ================================================================ *
   * 内部：事件与回调
   * ================================================================ */

  private onChannelState: ((status: ChannelStatus) => void) | undefined

  /** 注入状态回调（组件 props 面） */
  setCallbacks(cbs: { onEvent?: MediaEventListener; onChannelState?: (s: ChannelStatus) => void }): void {
    if ('onEvent' in cbs) this.onEventCallback = cbs.onEvent
    if ('onChannelState' in cbs) this.onChannelState = cbs.onChannelState
  }

  private emit(ev: MediaEvent, rateKey?: string, force = false): void {
    if (this.onEventCallback) {
      const cb = this.onEventCallback
      const unsubscribe = this.emitter.subscribe(cb)
      try {
        this.emitter.emit(ev, { rateKey, force })
      } finally {
        unsubscribe()
      }
      return
    }
    this.emitter.emit(ev, { rateKey, force })
  }

  private safeCallback<A extends unknown[]>(
    fn: ((...args: A) => void) | undefined,
    ...args: A
  ): void {
    if (typeof fn !== 'function') return
    this.emitter.safeCall(() => fn(...args))
  }

  private emitFrame(rt: ChannelRuntime, force = false): void {
    if (!this.options.frameEvents && !force) return
    const ch = this.channelsById(rt.status.id)
    if (!ch) return
    const now = this.clock.nowMs()
    const url = resolveFrameUrl(ch, rt.frameIndex, this.resolver ?? undefined)
    this.emit(
      {
        type: MEDIA_EVENTS.frame,
        data: {
          channelId: rt.status.id,
          frameIndex: rt.frameIndex,
          frameCount: ch.frameCount,
          ...(url ? { url } : {}),
          at: now,
        },
        ts: now,
      },
      rt.status.id,
      force,
    )
  }

  private reportDegraded(
    channelId: string | undefined,
    capability: 'range' | 'fullscreen' | 'autoplay' | 'visibility',
    hint: string,
  ): void {
    const now = this.clock.nowMs()
    this.emit(
      {
        type: MEDIA_EVENTS.degraded,
        data: { ...(channelId ? { channelId } : {}), capability, hint, at: now },
        ts: now,
      },
      undefined,
      true,
    )
  }

  private reportPolicyRejection(channelId: string, reason: string): void {
    const now = this.clock.nowMs()
    this.emit(
      {
        type: MEDIA_EVENTS.error,
        data: { channelId, errorCode: 3004, reason, recoverable: false, at: now },
        ts: now,
      },
      undefined,
      true,
    )
  }

  private reportEmpty(
    reason: EmptyReason,
    total: number,
    usable: number,
    message: string,
  ): void {
    const now = this.clock.nowMs()
    this.emptyReason = reason
    const key = `${reason}:${total}:${usable}`
    if (this.emptyKey === key) return
    this.emptyKey = key
    this.emit(
      { type: MEDIA_EVENTS.empty, data: { reason, total, usable, message, at: now }, ts: now },
      undefined,
      true,
    )
    this.safeCallback(this.onEmptyCallback, reason, { total, usable, message })
  }

  private onEmptyCallback:
    | ((reason: EmptyReason, detail: { total: number; usable: number; message: string }) => void)
    | undefined

  /** 注入空清单回调（组件 props 面） */
  setEmptyCallback(
    cb:
      | ((reason: EmptyReason, detail: { total: number; usable: number; message: string }) => void)
      | undefined,
  ): void {
    this.onEmptyCallback = cb
  }

  private refreshEmptyState(): void {
    const total = this.channels.length
    const usable = this.channels.filter((c) => c.available).length
    if (usable > 0) {
      this.emptyKey = null
      this.emptyReason = null
      return
    }
    if (total === 0) {
      this.reportEmpty('no-channels', 0, 0, '通道清单为空')
      return
    }
    const declaredOff = this.channels.filter((c) => c.unavailableReason === null && !c.available).length
    if (declaredOff === total) {
      this.reportEmpty('all-unavailable', total, 0, `全部 ${total} 路通道被标记为不可用`)
      return
    }
    const reasons = this.channels
      .filter((c) => !c.available)
      .map((c) => `${c.id}: ${c.unavailableReason ?? '不可用'}`)
    this.reportEmpty('all-unavailable', total, 0, `无可用通道（${reasons.join('；')}）`)
  }

  /* ================================================================ *
   * 内部：出声仲裁
   * ================================================================ */

  private recomputeAudible(): void {
    if (this.disposed) return
    const policy: AudioPolicy = this.options.audioPolicy
    const statuses = this.statusList()
    // 候选排序：最近一次 play 的通道排首位，保证"最近 play"口径可复现
    const ranked = [...this.channels].sort((a, b) => {
      const sa = this.runtimes.get(a.id)?.playSeq ?? 0
      const sb = this.runtimes.get(b.id)?.playSeq ?? 0
      return sb - sa
    })
    const statusById = new Map(statuses.map((s) => [s.id, s]))
    const rankedStatuses = ranked.map((c) => statusById.get(c.id)!).filter(Boolean)
    const next = pickAudible(ranked, rankedStatuses, this.mainId, policy)
    if (next === this.audibleId) {
      this.applyMuteFlags(next)
      return
    }
    this.audibleId = next
    this.applyMuteFlags(next)
    const active = next ?? this.mainId ?? this.order[0]
    if (active) this.emitStateChange(active)
  }

  private applyMuteFlags(audibleId: string | null): void {
    for (const id of this.order) {
      const rt = this.runtimes.get(id)!
      const audible = id === audibleId
      const byPolicy = this.options.audioPolicy === 'none' ? true : !audible && !!audibleId
      rt.status.audible = audible
      rt.status.mutedByPolicy = byPolicy
      rt.status.muted = this.options.audioPolicy === 'none' ? true : rt.status.userMuted || byPolicy
      rt.handle?.setMuted(rt.status.muted)
      rt.handle?.setVolume(rt.status.volume)
    }
  }

  /* ================================================================ *
   * 内部：元素对齐
   * ================================================================ */

  private applyHandleState(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt?.handle) return
    const h = rt.handle
    h.setVolume(rt.status.volume)
    h.setMuted(rt.status.muted)
    h.setRate(rt.status.rate)
    h.setLoop(rt.status.loop)
    if (rt.status.kind === 'image-seq') {
      const ch = this.channelsById(id)
      const url = ch ? resolveFrameUrl(ch, rt.frameIndex, this.resolver ?? undefined) : null
      h.setFrame(rt.frameIndex, url)
    }
    switch (rt.status.state) {
      case 'playing':
        h.play()
        break
      case 'paused':
        // 暂停仅对**真的在播**的通道下发停止；"未起播即暂停"（图像流未挂载元素）
        // MUST NOT 让元素回到更早的状态
        if (rt.wantPlay === false) h.pause()
        break
      case 'idle':
        h.stop()
        break
      default:
        break
    }
  }

  /* ================================================================ *
   * 内部：内容框（叠加层与画面共用同一份 box，CTR-MDP-OVL-01）
   * ================================================================ */

  private recomputeBox(rt: ChannelRuntime): void {
    const fit: FitMode = this.options.overlay.fit
    // 尺寸未知时 mediaContentBox MUST 回整容器，并在尺寸到达后立即重算（契约 §8.2/§8.3）
    // 全屏态：容器基准 = 视口实测尺寸（全屏元素即媒体元素本身，其 rect 就是视口）
    const container = (rt.status.fullscreen ? this.fullscreenViewport() : null) ??
      rt.container ??
      rt.media ?? { w: 0, h: 0 }
    const next = mediaContentBox(container, rt.media, fit)
    rt.boxRev += 1
    const prev = rt.box
    if (prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h) return
    rt.box = next
    rt.rev += 1
  }

  /** 全屏态的容器尺寸（视口）；无 DOM 环境回 null（退回 tile 基准，不报错） */
  private fullscreenViewport(): Size | null {
    const g = globalThis as { innerWidth?: number; innerHeight?: number }
    const w = g.innerWidth
    const h = g.innerHeight
    if (typeof w !== 'number' || typeof h !== 'number') return null
    return sanitizeSize({ w, h })
  }

  /** 供视图层：把归一化矩形映射到像素（与画面共用 box） */
  boxToPx(id: string, r: { x: number; y: number; w: number; h: number }): Rect {
    return normToPx(r, this.getContentBox(id))
  }

  /* ================================================================ *
   * 内部：计时（图像流轮播 + 不可见延迟暂停 + 定位超时）
   * ================================================================ */

  private scheduleTick(): void {
    if (this.disposed) return
    const now = this.clock.nowMs()
    let next: number | null = null
    for (const id of this.order) {
      const rt = this.runtimes.get(id)!
      if (rt.status.kind === 'image-seq') {
        if (rt.nextFrameAt === null) this.scheduleFrame(rt, now)
        if (rt.nextFrameAt !== null && (next === null || rt.nextFrameAt < next)) next = rt.nextFrameAt
      }
      if (rt.hideAt !== null && (next === null || rt.hideAt < next)) next = rt.hideAt
      if (rt.seekDeadlineAt !== null && (next === null || rt.seekDeadlineAt < next)) next = rt.seekDeadlineAt
      if (rt.retryAt !== null && (next === null || rt.retryAt < next)) next = rt.retryAt
    }
    if (next === null) {
      if (this.tickHandle !== null) {
        this.timer.clear(this.tickHandle)
        this.tickHandle = null
      }
      return
    }
    if (this.tickHandle !== null) this.timer.clear(this.tickHandle)
    const delay = Math.max(0, next - now)
    this.tickHandle = this.timer.set(() => {
      this.tickHandle = null
      this.tick()
    }, delay)
  }

  private scheduleFrame(rt: ChannelRuntime, now: number): void {
    const ch = this.channelsById(rt.status.id)
    if (!ch || ch.kind !== 'image-seq') {
      rt.nextFrameAt = null
      return
    }
    // 图像流的"在播"判据是 wantPlay + 已可绘（ready/playing），不是 state==='playing'：
    // 首帧 onload 之前它只能处于 ready，若按 state 判定则永不起节拍。
    const running = rt.wantPlay && (rt.status.state === 'ready' || rt.status.state === 'playing')
    if (!running || !rt.status.visible) {
      rt.nextFrameAt = null
      return
    }
    if (rt.status.diagnostics.pausedByPolicy) {
      rt.nextFrameAt = null
      return
    }
    const interval = Math.max(
      this.options.minFrameIntervalMs,
      ch.frameIntervalMs / Math.max(0.01, rt.status.rate),
    )
    rt.nextFrameAt = now + interval
  }

  private tick(): void {
    if (this.disposed) return
    const now = this.clock.nowMs()
    for (const id of this.order) {
      const rt = this.runtimes.get(id)!
      const ch = this.channelsById(id)

      // 不可见后延迟暂停（防抖动）
      if (rt.hideAt !== null && now >= rt.hideAt) {
        rt.hideAt = null
        if (!rt.status.visible && this.options.lazyVisibility && rt.status.state === 'playing') {
          rt.handle?.pause()
          rt.status.diagnostics.pausedByPolicy = true
          rt.status.diagnostics.updatedAt = now
          this.setState(rt, 'paused', { reason: '不可见，已按策略暂停' })
          this.reportDegraded(id, 'visibility', '通道不可见，已暂停解码以节省资源')
          this.recomputeAudible()
        }
      }

      // 定位超时 → Range 降级 + seekMs 记账（MDP-PLY-02、DGR-04）
      if (rt.seekDeadlineAt !== null && now >= rt.seekDeadlineAt) this.markSeekTimeout(rt, now)

      // 解码失败退避重试到点：回到 loading 重新加载（MUST 可恢复，不得进死态）
      if (rt.retryAt !== null && now >= rt.retryAt) {
        rt.retryAt = null
        if (rt.status.visible && (rt.status.state === 'error' || rt.status.state === 'paused')) {
          rt.loadStartedAt = now
          rt.frameFailures = 0
          this.setState(rt, 'loading', { reason: null, errorCode: null })
          rt.handle?.play()
          this.applyHandleState(id)
          this.recomputeAudible()
        }
      }

      // 图像流轮播
      if (ch && ch.kind === 'image-seq' && rt.nextFrameAt !== null && now >= rt.nextFrameAt) {
        const total = Math.max(1, ch.frameCount)
        const nextIndex = rt.frameIndex + 1
        if (nextIndex >= total) {
          if (rt.status.loop || ch.loop) {
            rt.frameIndex = 0
          } else {
            rt.frameIndex = total - 1
            rt.nextFrameAt = null
            this.setState(rt, 'paused', { reason: '已到末帧' })
            this.recomputeAudible()
            continue
          }
        } else {
          rt.frameIndex = nextIndex
        }
        this.patchStatus(rt, {
          frameIndex: rt.frameIndex,
          positionMs: rt.frameIndex * ch.frameIntervalMs,
        })
        const url = resolveFrameUrl(ch, rt.frameIndex, this.resolver ?? undefined)
        rt.handle?.setFrame(rt.frameIndex, url)
        this.emitFrame(rt)
        this.scheduleFrame(rt, now)
      }
    }
    this.scheduleTick()
  }

  /* ================================================================ *
   * 内部：Range 能力探测（MDP-PLY-02）
   * ================================================================ */

  private async detectRange(ch: MediaChannel): Promise<void> {
    if (!ch.url) return
    const cached = this.lastProbe.get(ch.id)
    if (cached !== undefined) {
      if (!cached) this.markRangeDegraded(ch.id)
      return
    }
    const outcome = await probeWith(this.probe ?? undefined, ch.url)
    if (this.disposed) return
    this.lastProbe.set(ch.id, outcome.acceptRanges)
    if (outcome.known && !outcome.acceptRanges) this.markRangeDegraded(ch.id)
  }

  private markRangeDegraded(id: string): void {
    const rt = this.runtimes.get(id)
    if (!rt || rt.status.degraded.range) return
    const hint = '当前素材未声明 Range 支持，进度定位可能不生效（需宿主静态托管支持 Range）'
    rt.status.degraded = { range: true, hint }
    this.patchStatus(rt, {})
    this.reportDegraded(id, 'range', hint)
  }

  /**
   * 定位超时 → 判为 Range 降级并把 `seekMs` 记入诊断（契约 §7.3「定位超 `seekTimeoutMs`」行）。
   *
   * 与"探测明确报告无 Range"共用同一条降级出口：`degraded.range` 置位、可读 `hint` 非空，
   * 宿主据此给出提示，MUST NOT 静默失败（MDP-PLY-02）。
   */
  private markSeekTimeout(rt: ChannelRuntime, now: number): void {
    const startedAt = rt.seekAt ?? rt.seekStartedAt
    rt.seekDeadlineAt = null
    rt.seekAt = null
    if (startedAt !== null) rt.status.diagnostics.seekMs = Math.max(0, now - startedAt)
    rt.seekStartedAt = null
    rt.status.diagnostics.updatedAt = now
    const hint = `进度定位超过 ${this.options.seekTimeoutMs} ms 未完成，判为 Range 降级（宿主静态托管需支持 Range）`
    if (!rt.status.degraded.range) rt.status.degraded = { range: true, hint }
    this.reportDegraded(rt.status.id, 'range', hint)
  }

  /* ================================================================ *
   * 内部：解码失败退避重试（契约 §7.3「重试上限 2 次，退避 1s/2s」）
   * ================================================================ */

  /** 重试退避：1s × 2^已用次数（1s / 2s） */
  private retryDelayMs(attempt: number): number {
    return 1000 * 2 ** Math.max(0, attempt)
  }

  /**
   * 排程一次解码重试。
   *
   * 只对"解码/可达"类失败（3001/3002）且在**已起播**的通道上生效；次数上限 `MAX_DECODE_RETRY`，
   * 超过即停在 `error` 态（MUST NOT 重试轰炸）。`delayOverrideMs` 供视图层带 `retryAfterMs`
   * 的上报使用（CSP 拒绝自动播放等场景 MUST NOT 重试，由调用方直接不排程）。
   */
  private scheduleRetry(rt: ChannelRuntime, code: number, delayOverrideMs?: number): void {
    if (this.disposed) return
    if (code !== 3001 && code !== 3002) return
    if (rt.retries >= MAX_DECODE_RETRY) return
    if (!rt.status.visible) return
    const attempt = rt.retries
    rt.retries += 1
    rt.retryAt = this.clock.nowMs() + Math.max(0, delayOverrideMs ?? this.retryDelayMs(attempt))
    this.scheduleTick()
  }

  /**
   * 判失败 + 排程退避重试。重试期间通道保持 `error`（状态可查询），到点后回 `loading`。
   */
  private failWithRetry(rt: ChannelRuntime, code: number, reason: string): void {
    this.failChannel(rt, code, reason)
    this.scheduleRetry(rt, code)
  }

  /* ================================================================ *
   * 内部：配置
   * ================================================================ */

  private mergeOptions(patch: Partial<MediaPlayerOptions>): {
    clampedFields: string[]
    rejectedFields: string[]
  } {
    const clampedFields: string[] = []
    const rejectedFields: string[] = []
    const o = this.options

    if (patch.defaultKind !== undefined) {
      if (patch.defaultKind === 'video' || patch.defaultKind === 'image-seq') o.defaultKind = patch.defaultKind
      else rejectedFields.push('defaultKind')
    }
    if (patch.maxChannels !== undefined) {
      if (Number.isFinite(patch.maxChannels) && patch.maxChannels > 0) {
        const v = Math.floor(patch.maxChannels)
        if (v !== patch.maxChannels) clampedFields.push('maxChannels')
        o.maxChannels = v
      } else rejectedFields.push('maxChannels')
    }
    if (patch.maxChannelsByKind !== undefined) {
      const raw = patch.maxChannelsByKind as Partial<Record<ChannelKind, number>>
      const next = { ...o.maxChannelsByKind }
      for (const k of ['video', 'image-seq'] as ChannelKind[]) {
        const v = raw[k]
        if (v === undefined) continue
        if (Number.isFinite(v) && v > 0) next[k] = Math.floor(v)
        else rejectedFields.push(`maxChannelsByKind.${k}`)
      }
      o.maxChannelsByKind = next
    }
    if (patch.columns !== undefined) {
      if (patch.columns === 'auto') o.columns = 'auto'
      else if (Number.isFinite(patch.columns) && patch.columns >= 1) o.columns = Math.floor(patch.columns)
      else rejectedFields.push('columns')
    }
    if (patch.layout !== undefined) {
      if (patch.layout === 'grid' || patch.layout === 'focus') {
        o.layout = patch.layout
        this.layout = patch.layout
      } else rejectedFields.push('layout')
    }
    if (patch.defaultVolume !== undefined) {
      const v = clampNumber(patch.defaultVolume, 0, 1, o.defaultVolume)
      if (v !== patch.defaultVolume) clampedFields.push('defaultVolume')
      o.defaultVolume = v
    }
    if (patch.audioPolicy !== undefined) {
      if (patch.audioPolicy === 'single' || patch.audioPolicy === 'all' || patch.audioPolicy === 'none') {
        o.audioPolicy = patch.audioPolicy
      } else rejectedFields.push('audioPolicy')
    }
    for (const key of ['autoPlay', 'defaultLoop', 'lazyVisibility', 'frameEvents', 'measureFps'] as const) {
      const v = patch[key]
      if (v !== undefined) {
        if (typeof v === 'boolean') o[key] = v
        else rejectedFields.push(key)
      }
    }
    if (patch.defaultFrameIntervalMs !== undefined) {
      const v = clampNumber(patch.defaultFrameIntervalMs, 1, Number.MAX_SAFE_INTEGER, o.defaultFrameIntervalMs)
      if (v !== patch.defaultFrameIntervalMs) clampedFields.push('defaultFrameIntervalMs')
      o.defaultFrameIntervalMs = v
    }
    if (patch.minFrameIntervalMs !== undefined) {
      const v = clampNumber(patch.minFrameIntervalMs, 1, Number.MAX_SAFE_INTEGER, o.minFrameIntervalMs)
      if (v !== patch.minFrameIntervalMs) clampedFields.push('minFrameIntervalMs')
      o.minFrameIntervalMs = v
    }
    if (patch.throttleMs !== undefined) {
      const v = clampNumber(patch.throttleMs, 0, Number.MAX_SAFE_INTEGER, o.throttleMs)
      if (v !== patch.throttleMs) clampedFields.push('throttleMs')
      o.throttleMs = v
      this.emitter.setThrottleMs(v)
    }
    if (patch.preloadFrames !== undefined) {
      const v = clampNumber(patch.preloadFrames, 0, 2, o.preloadFrames)
      if (v !== patch.preloadFrames) clampedFields.push('preloadFrames')
      o.preloadFrames = Math.floor(v)
    }
    if (patch.stepFallbackMs !== undefined) {
      const v = clampNumber(patch.stepFallbackMs, 1, Number.MAX_SAFE_INTEGER, o.stepFallbackMs)
      if (v !== patch.stepFallbackMs) clampedFields.push('stepFallbackMs')
      o.stepFallbackMs = v
    }
    if (patch.rateOptions !== undefined) {
      if (Array.isArray(patch.rateOptions) && patch.rateOptions.length > 0 && patch.rateOptions.every((r) => Number.isFinite(r) && r > 0)) {
        o.rateOptions = [...patch.rateOptions]
      } else rejectedFields.push('rateOptions')
    }
    if (patch.seekTimeoutMs !== undefined) {
      const v = clampNumber(patch.seekTimeoutMs, 1, Number.MAX_SAFE_INTEGER, o.seekTimeoutMs)
      if (v !== patch.seekTimeoutMs) clampedFields.push('seekTimeoutMs')
      o.seekTimeoutMs = v
    }
    if (patch.hiddenPauseDelayMs !== undefined) {
      const v = clampNumber(patch.hiddenPauseDelayMs, 0, Number.MAX_SAFE_INTEGER, o.hiddenPauseDelayMs)
      if (v !== patch.hiddenPauseDelayMs) clampedFields.push('hiddenPauseDelayMs')
      o.hiddenPauseDelayMs = v
    }
    if (patch.bufferLimitFrames !== undefined) {
      const v = clampNumber(patch.bufferLimitFrames, 1, Number.MAX_SAFE_INTEGER, o.bufferLimitFrames)
      if (v !== patch.bufferLimitFrames) clampedFields.push('bufferLimitFrames')
      o.bufferLimitFrames = Math.floor(v)
    }
    if (patch.overlay !== undefined) {
      const p = patch.overlay as Partial<MediaPlayerOptions['overlay']>
      if (p.keys !== undefined) {
        const keys = normalizeOverlayKeys(p.keys)
        if (keys) {
          o.overlay.keys = keys
          for (const ch of this.channels) ch.overlayKeys = [...keys]
        } else rejectedFields.push('overlay.keys')
      }
      if (p.pointerEvents !== undefined) {
        if (p.pointerEvents === 'none' || p.pointerEvents === 'auto') o.overlay.pointerEvents = p.pointerEvents
        else rejectedFields.push('overlay.pointerEvents')
      }
      if (p.fit !== undefined) {
        if (p.fit === 'contain' || p.fit === 'cover' || p.fit === 'fill') o.overlay.fit = p.fit
        else rejectedFields.push('overlay.fit')
      }
      for (const id of this.order) {
        const rt = this.runtimes.get(id)
        if (rt) this.recomputeBox(rt)
      }
    }
    return { clampedFields, rejectedFields }
  }

  /* ================================================================ *
   * 内部：工具
   * ================================================================ */

  private channelsById(id: string): MediaChannel | null {
    return this.channels.find((c) => c.id === id) ?? null
  }

  private statusList(): ChannelStatus[] {
    return this.order.map((id) => this.runtimes.get(id)!.status)
  }

  private hasFullscreenApi(): boolean {
    const doc = (globalThis as { document?: Document }).document
    if (!doc) return false
    const el = doc.documentElement as HTMLElement & {
      requestFullscreen?: unknown
      webkitRequestFullscreen?: unknown
    }
    return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
  }

  /** 把一次公开调用包进 try/catch（CTR-MDP-EC-01：MUST NOT 抛异常） */
  private guardCall<T>(fn: (wrap: <U>(r: MediaResult<U>) => MediaResult<T>) => MediaResult<T>): MediaResult<T> {
    const wrap = <U>(r: MediaResult<U>): MediaResult<T> => r as unknown as MediaResult<T>
    if (this.disposed) return wrap(fail(1005, '已释放') as unknown as MediaResult<T>)
    try {
      return fn(wrap)
    } catch (e) {
      this.counts.callbackErrors += 1
      return wrap(fail(1005, `内部异常（${errText(e)}）`) as unknown as MediaResult<T>)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 深拷贝与规整工具
 * ------------------------------------------------------------------ */

function cloneChannel(c: MediaChannel): MediaChannel {
  return {
    ...c,
    frames: c.frames ? [...c.frames] : null,
    overlayKeys: [...c.overlayKeys],
    meta: { ...c.meta },
  }
}

function cloneStatus(s: ChannelStatus): ChannelStatus {
  return {
    ...s,
    videoSize: s.videoSize ? { ...s.videoSize } : null,
    degraded: { ...s.degraded },
    diagnostics: { ...s.diagnostics },
  }
}

function cloneOverlay(o: OverlayContent): OverlayContent {
  return {
    ...o,
    boxes: o.boxes ? o.boxes.map((b) => ({ ...b, rect: { ...b.rect } })) : undefined,
    extra: o.extra ? o.extra.map((e) => ({ ...e })) : undefined,
  }
}

function mergeOverlay(base: OverlayContent, patch: Partial<OverlayContent>): OverlayContent {
  const next: OverlayContent = { ...base }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === undefined) continue
    if (v === null) {
      delete (next as Record<string, unknown>)[k]
      continue
    }
    ;(next as Record<string, unknown>)[k] = v
  }
  return next
}

function cloneOptions(o: MediaPlayerOptions): MediaPlayerOptions {
  return {
    ...o,
    maxChannelsByKind: { ...o.maxChannelsByKind },
    rateOptions: [...o.rateOptions],
    overlay: { ...o.overlay, keys: [...o.overlay.keys] },
  }
}

function sanitizeSize(size: Size | null): Size | null {
  if (!size) return null
  if (!Number.isFinite(size.w) || !Number.isFinite(size.h)) return null
  if (size.w <= 0 || size.h <= 0) return null
  return { w: size.w, h: size.h }
}

function readPayloadSize(payload: unknown): Size | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { w?: unknown; h?: unknown }
  if (typeof p.w !== 'number' || typeof p.h !== 'number') return null
  return sanitizeSize({ w: p.w, h: p.h })
}

function readPayloadNumber(payload: unknown, key: string): number | null {
  if (!payload || typeof payload !== 'object') return null
  const v = (payload as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null
  const v = (payload as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** 列数（`columns:'auto'` 按可见路数推导） */
export function resolveColumns(options: MediaPlayerOptions, visible: number): number {
  if (options.columns === 'auto') return autoColumns(visible)
  return Math.max(1, Math.floor(options.columns))
}

/**
 * 工厂：创建控制器（纯逻辑，不触碰 DOM）。
 *
 * `deps.timer` MUST 显式透传 —— 这是"节流 / 轮播 / 延迟暂停 / 定位超时可用注入计时器
 * 复现"的唯一入口，丢了它上述时序就退回真实 `setTimeout`，测试将不再可复现。
 */
export function createMediaController(
  init?: MediaControllerInit,
  deps?: MediaControllerDeps,
): MediaController {
  try {
    return new MediaControllerImpl(init, deps)
  } catch (e) {
    // 极端情况下也必须给出可用对象（P10：失败 MUST NOT 抛异常跨边界）
    if (typeof console !== 'undefined' && typeof console.error === 'function') {
      console.error('[media-player] 控制器构造失败，已回落到缺省实例：', errText(e))
    }
    return new MediaControllerImpl({}, deps)
  }
}

export type { ChannelRuntime }
