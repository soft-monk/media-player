// media-player · 公开类型面（契约 §2.5 的 42 个类型）
//
// 分层纪律（契约 §11.3-①）：本文件与 core/** 全部 MUST NOT import react。
// 视图层（src/react/**）才允许依赖 react / react-dom。

/* ------------------------------------------------------------------ *
 * 1. 枚举与基础
 * ------------------------------------------------------------------ */

/** 通道类型：video（本地 mp4）与 image-seq（jpg/png 序列帧） */
export type ChannelKind = 'video' | 'image-seq'

/** 通道状态闭集（顺序冻结，见 CHANNEL_STATES） */
export type ChannelState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error'

/** 布局：网格 / 主路聚焦 */
export type LayoutMode = 'grid' | 'focus'

/** 画面贴合方式（与媒体元素 object-fit 一致，叠加层必须同档） */
export type FitMode = 'contain' | 'cover' | 'fill'

/** 叠加项键（顺序即渲染叠放顺序，见 OVERLAY_KEYS） */
export type OverlayKey = 'live' | 'magnification' | 'timestamp' | 'channelName' | 'source' | 'boxes'

/** 框样式：矩形 / 十字准星 / 锁定框（矩形 + 四角 + 十字） */
export type OverlayBoxStyle = 'rect' | 'crosshair' | 'lock'

/** 出声策略：至多一路 / 各自出声 / 全部静音 */
export type AudioPolicy = 'single' | 'all' | 'none'

/** 空清单原因（决定"入口是否显示"，契约 §7.1） */
export type EmptyReason =
  | 'no-source'
  | 'no-channels'
  | 'all-unavailable'
  | 'source-error'
  | 'schema-mismatch'

/** 事件名（media.<subject>，契约 §5.2） */
export type MediaEventType =
  | 'media.state'
  | 'media.error'
  | 'media.empty'
  | 'media.degraded'
  | 'media.frame'

/** 错误码：0 / 复用 protocol.md 1000–1006 / 本模块私有 3001–3005 */
export type MediaErrorCode =
  | 0
  | 1000
  | 1002
  | 1003
  | 1004
  | 1005
  | 1006
  | 3001
  | 3002
  | 3003
  | 3004
  | 3005

export type MediaEventListener = (ev: MediaEvent) => void

/** 尺寸（CSS 像素） */
export interface Size {
  w: number
  h: number
}

/** 像素矩形（CSS 像素，相对容器左上） */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 归一化矩形（0–1，相对**画面内容框**左上，契约 §8.1） */
export interface NormRect {
  x: number
  y: number
  w: number
  h: number
}

/* ------------------------------------------------------------------ *
 * 2. 通道模型（MDP-CHN-01）
 * ------------------------------------------------------------------ */

/**
 * 宿主可直投的宽松输入（全部字段可选）。
 *
 * `kind` 刻意保持 `string`：它是**未归一化**的输入面，任意值都必须被
 * 归一化函数安全接住（未知值 → 该条不可用 + 可读原因），MUST NOT 抛错。
 */
export interface RawChannelEntry {
  id?: string
  name?: string
  kind?: string
  url?: string
  frames?: string[]
  frameCount?: number
  frameIntervalMs?: number
  sourceLabel?: string
  available?: boolean
  unavailableReason?: string
  loop?: boolean
  poster?: string
  overlays?: OverlayContent
  overlayKeys?: OverlayKey[]
  meta?: Record<string, unknown>
}

/** 归一化后的通道（只读；模块外 MUST NOT 改） */
export interface MediaChannel {
  id: string
  name: string
  kind: ChannelKind
  /** video: 媒体地址；image-seq: 帧模板或单帧地址 */
  url: string | null
  /** image-seq 显式帧；video 恒 null */
  frames: string[] | null
  /** image-seq 帧数；video 恒 0 */
  frameCount: number
  /** 轮播间隔（已夹紧到 >= minFrameIntervalMs） */
  frameIntervalMs: number
  /** 来源徽标文本（宿主给；模块不内置枚举） */
  sourceLabel: string | null
  available: boolean
  unavailableReason: string | null
  loop: boolean
  poster: string | null
  overlayKeys: OverlayKey[]
  /** 原样透传；模块 MUST NOT 解释其内容 */
  meta: Record<string, unknown>
}

/* ------------------------------------------------------------------ *
 * 3. 状态与诊断（MDP-DGR-01/04）
 * ------------------------------------------------------------------ */

export interface ChannelDiagnostics {
  /** 发起加载 → 首帧可绘（video: loadeddata；image-seq: 首帧 onload） */
  loadMs: number | null
  /** 最近一次 seek 实际耗时 */
  seekMs: number | null
  bufferingCount: number
  /** video: droppedVideoFrames；image-seq: 因节流/不可见被跳过的帧数 */
  droppedFrames: number
  loadFailures: number
  lastErrorAt: number | null
  pausedByPolicy: boolean
  /** 该通道当前生效的最小刷新间隔 */
  throttleMs: number
  updatedAt: number
}

export interface ChannelStatus {
  id: string
  kind: ChannelKind
  state: ChannelState
  /** 进入当前状态的时刻（epoch ms，来自 IClock） */
  since: number
  /** 可读原因；state==='error' 时 MUST 非空 */
  reason: string | null
  errorCode: MediaErrorCode | null
  /** video: 当前进度；image-seq: frameIndex * frameIntervalMs（约定值） */
  positionMs: number
  /** video 未知为 null；image-seq 为 null */
  durationMs: number | null
  /** video 已缓冲位置；image-seq 恒 0 */
  bufferedMs: number
  /** 用户设定音量 0–1 */
  volume: number
  /** **有效静音**（含策略静音） */
  muted: boolean
  /** 用户静音意图 */
  userMuted: boolean
  /** 被出声仲裁强制静音 */
  mutedByPolicy: boolean
  /** 当前是否出声 */
  audible: boolean
  rate: number
  loop: boolean
  /** image-seq 当前帧下标（0 基）；video 恒 0 */
  frameIndex: number
  frameCount: number
  /** 实际分辨率 */
  videoSize: Size | null
  visible: boolean
  fullscreen: boolean
  /** MDP-PLY-02：无 Range 时的可读提示 */
  degraded: { range: boolean; hint: string | null }
  diagnostics: ChannelDiagnostics
}

export interface MediaDiagnostics {
  ts: number
  mainId: string | null
  audibleId: string | null
  fullscreenId: string | null
  layout: LayoutMode
  totals: {
    channels: number
    usable: number
    visible: number
    playing: number
    loading: number
    error: number
    audible: number
  }
  channels: Record<string, ChannelDiagnostics>
  degraded: { range: boolean; throttled: boolean; visibility: boolean }
  /** 被上限/策略拒绝的次数 */
  policyRejections: number
  /** 仅当 options.measureFps 为 true 且有 DOM 时给出；否则 null */
  fps: number | null
  disposed: boolean
}

export interface MediaSummary {
  total: number
  usable: number
  visible: number
  states: Record<ChannelState, number>
  mainId: string | null
  audibleId: string | null
  fullscreenId: string | null
  layout: LayoutMode
  empty: boolean
  emptyReason: EmptyReason | null
  degradedChannels: string[]
  policyRejections: number
}

/* ------------------------------------------------------------------ *
 * 4. 叠加层（MDP-OVL-01/02/03）
 * ------------------------------------------------------------------ */

export interface OverlayBox {
  id: string
  /** 归一化坐标，0–1 */
  rect: NormRect
  /** 缺省 'rect' */
  style?: OverlayBoxStyle
  /** 缺省 '#ef4444' */
  color?: string
  label?: string
  /** CSS px，缺省 2 */
  thickness?: number
  /** 缺省 false */
  dashed?: boolean
}

export interface OverlayContent {
  /** true → 【实时】；false → 【回放】；缺省（不传）不显示 */
  live?: boolean
  /** 倍率**文本**（宿主给，模块 MUST NOT 换算） */
  magnification?: string
  /** epoch ms；与 timestampText 同时给时以文本优先 */
  timestampMs?: number
  /** 宿主已格式化的时间串（格式化归宿主） */
  timestampText?: string
  /** 缺省取 channel.name */
  channelName?: string
  /** 缺省取 channel.sourceLabel */
  sourceLabel?: string
  boxes?: OverlayBox[]
  /** 自定义角标文本 */
  extra?: Array<{ key: string; text: string; corner?: 'tl' | 'tr' | 'bl' | 'br' }>
}

export interface OverlaysConfig {
  /** 缺省 OVERLAY_KEYS（全部 6 项） */
  keys?: OverlayKey[]
  /** 缺省 'none'（穿透，MDP-OVL-05） */
  pointerEvents?: 'none' | 'auto'
  /** 缺省 'contain' */
  fit?: FitMode
  byChannel?: Record<string, OverlayContent>
}

/* ------------------------------------------------------------------ *
 * 5. 配置与适配器
 * ------------------------------------------------------------------ */

export interface MediaPlayerOptions {
  defaultKind: ChannelKind
  maxChannels: number
  maxChannelsByKind: Record<ChannelKind, number>
  columns: number | 'auto'
  layout: LayoutMode
  defaultVolume: number
  audioPolicy: AudioPolicy
  autoPlay: boolean
  defaultLoop: boolean
  defaultFrameIntervalMs: number
  minFrameIntervalMs: number
  throttleMs: number
  preloadFrames: number
  stepFallbackMs: number
  rateOptions: number[]
  seekTimeoutMs: number
  lazyVisibility: boolean
  hiddenPauseDelayMs: number
  bufferLimitFrames: number
  frameEvents: boolean
  measureFps: boolean
  overlay: { keys: OverlayKey[]; pointerEvents: 'none' | 'auto'; fit: FitMode }
}

/** 时间注入（冻结签名） */
export interface IClock {
  nowMs(): number
}

/** 通道清单来源（宿主 MUST 提供其一） */
export interface IChannelSource {
  list(signal?: AbortSignal): Promise<unknown>
}

/** 帧 URL 解析器（滚动窗口帧、非枚举帧源） */
export interface IFrameUrlResolver {
  resolve(channelId: string, index: number): string | null
}

/** 远端能力探测（缺省为内建同源探测） */
export interface IMediaProbe {
  probe(url: string): Promise<{ reachable: boolean; acceptRanges: boolean }>
}

export interface MediaPlayerAdapters {
  clock?: IClock
  source?: IChannelSource
  frameResolver?: IFrameUrlResolver
  probe?: IMediaProbe
}

export interface MediaControllerInit {
  channels?: unknown
  options?: Partial<MediaPlayerOptions>
  adapters?: MediaPlayerAdapters
  onEvent?: MediaEventListener
  /** 可用通道数为 0 时回调（等价 \`MediaPlayerProps.onEmpty\`） */
  onEmpty?: (
    reason: EmptyReason,
    detail: { total: number; usable: number; message: string },
  ) => void
}

export interface MediaResult<T = unknown> {
  ok: boolean
  code: MediaErrorCode
  message: string
  data?: T
  /** 幂等命中：code 恒 0 */
  idempotent?: boolean
  /** 入参被夹紧到合法范围 */
  clamped?: boolean
}

export interface MediaSetResultData {
  total: number
  /** 被接受的通道 id（顺序同输入） */
  applied: string[]
  rejected: Array<{ index: number; code: MediaErrorCode; reason: string }>
  usable: number
  schemaVersion: string | null
}

/* ------------------------------------------------------------------ *
 * 6. 事件
 * ------------------------------------------------------------------ */

export interface MediaEventStateData {
  channelId: string
  kind: ChannelKind
  state: ChannelState
  prevState: ChannelState
  reason?: string
  errorCode?: MediaErrorCode
  at: number
}

export interface MediaEventErrorData {
  channelId: string
  errorCode: MediaErrorCode
  reason: string
  recoverable: boolean
  at: number
}

export interface MediaEventEmptyData {
  reason: EmptyReason
  total: number
  usable: number
  message: string
  at: number
}

export interface MediaEventDegradedData {
  channelId?: string
  capability: 'range' | 'fullscreen' | 'autoplay' | 'visibility'
  hint: string
  at: number
}

export interface MediaEventFrameData {
  channelId: string
  frameIndex: number
  frameCount: number
  url?: string
  at: number
}

/** 各 `type` 的负载（`media.state` 与 `media.error` 的负载在此可区分收窄） */
export type MediaEventData =
  | MediaEventStateData
  | MediaEventErrorData
  | MediaEventEmptyData
  | MediaEventDegradedData
  | MediaEventFrameData

/**
 * 事件信封：`{ type, data, ts }` **恰好三字段**（契约 §5.1）。
 *
 * 判别联合：按 `type` 收窄时 `data` 同步收窄到对应负载。
 * 需要"只看负载"时也可单独使用 `MediaEventData`。
 */
export type MediaEvent =
  | { type: 'media.state'; data: MediaEventStateData; ts: number }
  | { type: 'media.error'; data: MediaEventErrorData; ts: number }
  | { type: 'media.empty'; data: MediaEventEmptyData; ts: number }
  | { type: 'media.degraded'; data: MediaEventDegradedData; ts: number }
  | { type: 'media.frame'; data: MediaEventFrameData; ts: number }

/* ------------------------------------------------------------------ *
 * 7. 回调面（出口的唯一形态，契约 §3.3）
 * ------------------------------------------------------------------ */

export interface MediaPlayerCallbacks {
  /** 全部 media.* 事件 */
  onEvent?: MediaEventListener
  /** 状态迁移（MDP-DGR-01） */
  onChannelState?: (status: ChannelStatus) => void
  /** 可用通道数为 0（MDP-DGR-02） */
  onEmpty?: (
    reason: EmptyReason,
    detail: { total: number; usable: number; message: string },
  ) => void
}

/* ------------------------------------------------------------------ *
 * 8. 控制器与视图桥
 * ------------------------------------------------------------------ */

/** 通道状态之外的视图实测值（叠加层对齐基准，契约 §8） */
export interface MediaViewState {
  /** 容器实测尺寸；未挂载为 null */
  container: Size | null
  /** 媒体元素实测尺寸；未知为 null */
  media: Size | null
  /** 当前生效的内容框（CSS 像素，相对容器左上） */
  box: Rect
  /** 帧序号：每次 box 重算 +1（同帧内共享） */
  rev: number
  /**
   * box **重算次数**（每次触发点都 +1，即使结果与上次相同）。
   *
   * `rev` 只反映"box 变没变"，用它验证"重算触发点齐备"（契约 §8.3：resize /
   * 全屏 / 尺寸到达 / 源切换各触发一次）会漏判 —— 例如"尺寸到达后按新比例算出的
   * box 恰好等于旧值"时，重算确实发生了但 `rev` 不动。
   */
  boxRev?: number
}

/** 诊断快照（只读） */
export interface MediaDiagnosticSnapshot {
  imagesLoaded: number
  imagesFailed: number
  videoEvents: number
  droppedBoxes: number
  ignoredEventTypes: number
  callbackErrors: number
  eventLog: MediaEvent[]
}

/**
 * 视图层注入的媒体元素句柄（渲染适配器）。
 *
 * 控制器**只通过本接口驱动媒体元素**，自身不触碰 DOM（便于 node 直接单测）。
 * 未挂载视图时全部方法为"无副作用"：命令照常计入状态机与诊断，
 * 挂载后由视图层按状态对齐（契约 §2.1.2：媒体元素 MUST 复用同一实例）。
 */
export interface MediaElementHandle {
  /** 通道 id */
  readonly id: string
  /** 通道类型（决定可用的播放原语） */
  readonly kind: ChannelKind
  play(): void
  pause(): void
  stop(): void
  /** 仅 video 有效 */
  seek(positionMs: number): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setRate(rate: number): void
  setLoop(loop: boolean): void
  /** 切换当前帧（image-seq） */
  setFrame(index: number, url: string | null): void
  /**
   * 询问播放许可（MAY 由视图层实现）。
   *
   * 视图层可能**不渲染**媒体元素：例如图像流在"暂停/未起播"时（`state ∈ {idle,paused}`）
   * 不挂 `<img>`，此时真实 `play()` 无处可调、也不会回 'playing' 事件。控制器据此立即
   * 进入 playing（不依赖事件回执），否则"暂停后再播放"会永久停在 loading。
   * 返回 false / 未实现时按"尚未就绪"处理（等视图层回事件）。
   */
  canPlay?(): boolean
}

/** 控制器 ↔ 视图的桥（由 React 层实现；控制器不 import react） */
export interface MediaViewPort {
  /** 媒体元素已挂载/复用；控制器的待发命令在此对齐 */
  bindMedia(handle: MediaElementHandle): void
  /** 媒体元素已卸载；此后控制器的命令不再抵达 DOM */
  unbindMedia(id: string): void
  /** 容器实测尺寸变化（ResizeObserver） */
  setContainerSize(id: string, size: Size | null): void
  /** 媒体元素实测尺寸变化（loadedmetadata / 首帧 / object-fit 变化） */
  setMediaSize(id: string, size: Size | null): void
  /** 媒体元素上报的事件（loadeddata / seeked / error / ... ） */
  mediaEvent(id: string, name: string, payload?: unknown): void
  /** 帧图片 onload / onerror（image-seq） */
  imageEvent(id: string, index: number, ok: boolean, url?: string): void
}

export interface MediaController {
  // 清单
  setChannels(raw: unknown): MediaResult<MediaSetResultData>
  refreshChannels(signal?: AbortSignal): Promise<MediaResult<MediaSetResultData>>
  getChannels(): MediaChannel[]
  getChannel(id: string): MediaChannel | null
  // 状态与诊断
  getStatus(id: string): ChannelStatus | null
  getAllStatus(): ChannelStatus[]
  getSummary(): MediaSummary
  getDiagnostics(): MediaDiagnostics
  subscribe(listener: MediaEventListener): () => void
  // 播放控制
  play(id: string): MediaResult
  pause(id: string): MediaResult
  stop(id: string): MediaResult
  toggle(id: string): MediaResult
  seek(id: string, positionMs: number): MediaResult
  setVolume(id: string, volume: number): MediaResult
  mute(id: string, muted?: boolean): MediaResult
  setRate(id: string, rate: number): MediaResult
  stepFrame(id: string, delta?: number): MediaResult
  setLoop(id: string, loop: boolean): MediaResult
  setFrameInterval(id: string, ms: number): MediaResult
  pushFrame(id: string, frame: string | number): MediaResult
  // 布局、主路与全屏
  setMain(id: string | null): MediaResult
  getMain(): string | null
  getAudible(): string | null
  setVisible(id: string, visible: boolean): MediaResult
  setLayout(mode: LayoutMode): MediaResult
  getLayout(): LayoutMode
  enterFullscreen(id: string): Promise<MediaResult>
  exitFullscreen(): Promise<MediaResult>
  getFullscreen(): string | null
  // 叠加层
  setOverlay(id: string, patch: Partial<OverlayContent>): MediaResult
  toggleOverlay(id: string, key: OverlayKey, on?: boolean): MediaResult
  getOverlay(id: string): OverlayContent
  // 元素、配置与生命周期
  getElement(id: string): HTMLElement | null
  getOptions(): MediaPlayerOptions
  setOptions(patch: Partial<MediaPlayerOptions>): MediaResult
  dispose(): void

  /** 视图桥注入（MAY 不注入：纯逻辑 / 单测环境） —— 契约之外的最小扩展面 */
  setViewPort(port: MediaViewPort | null): void
  /** 适配器热更新（source / frameResolver / probe / clock；组件 props 变化时用） */
  setAdapters(patch: MediaPlayerAdapters): MediaResult
  /** 视图层：媒体元素挂载/卸载（元素复用，MUST NOT 重建） */
  attachHandle(handle: MediaElementHandle): void
  detachHandle(id: string): void
  /** 视图实测值（叠加层对齐基准，契约 §8 CTR-MDP-OVL-01） */
  getViewState(id: string): MediaViewState | null
  /** 当前帧 URL（image-seq；有界缓存内） */
  getFrameUrl(id: string): string | null
  /** 帧序列（已按 bufferLimitFrames 裁剪；image-seq） */
  getFrames(id: string): string[]
  /** 预加载帧 URL（长度 ≤ preloadFrames） */
  getPreloadUrls(id: string): string[]
  /** 诊断快照（计数与事件环形缓冲，契约 §7.3） */
  getDiagnosticSnapshot(): MediaDiagnosticSnapshot
  /** 视图层通知：媒体元素的 DOM 宿主节点（`getElement` 的数据来源） */
  setElement(id: string, el: HTMLElement | null): void
}

/** `ref` 暴露面 = 控制器本身 */
export type MediaPlayerHandle = MediaController
