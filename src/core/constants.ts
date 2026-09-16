// media-player · 常量与缺省值（契约 §2.6）
//
// `DEFAULT_OPTIONS` MUST 逐字实现；缺省值变更属破坏性变更。

import type {
  ChannelKind,
  ChannelState,
  EmptyReason,
  MediaEventType,
  MediaPlayerOptions,
  OverlayKey,
} from './types.ts'

/** 模块**支持**的清单 schema 版本 */
export const MEDIA_SCHEMA_VERSION = '1.0.0'

/** 不匹配 → 拒绝装载 + 1006 */
export const SUPPORTED_SCHEMA_MAJOR = 1

/** 通道状态闭集（顺序冻结） */
export const CHANNEL_STATES: readonly ChannelState[] = [
  'idle',
  'loading',
  'ready',
  'playing',
  'paused',
  'error',
]

/** 叠加项（顺序即渲染叠放顺序） */
export const OVERLAY_KEYS: readonly OverlayKey[] = [
  'live',
  'magnification',
  'timestamp',
  'channelName',
  'source',
  'boxes',
]

/** 空清单原因取值集 */
export const EMPTY_REASONS: readonly EmptyReason[] = [
  'no-source',
  'no-channels',
  'all-unavailable',
  'source-error',
  'schema-mismatch',
]

/** 事件名常量表（禁止字面量散落） */
export const MEDIA_EVENTS = {
  state: 'media.state',
  error: 'media.error',
  empty: 'media.empty',
  degraded: 'media.degraded',
  frame: 'media.frame',
} as const satisfies Record<'state' | 'error' | 'empty' | 'degraded' | 'frame', MediaEventType>

/** 支持的两类通道 */
export const CHANNEL_KINDS: readonly ChannelKind[] = ['video', 'image-seq']

/** `kind` 归一化别名表（契约 §6.2） */
export const KIND_ALIASES: Readonly<Record<string, ChannelKind>> = {
  video: 'video',
  mp4: 'video',
  'image-seq': 'image-seq',
  imageseq: 'image-seq',
}

/** 未订阅事件环形缓冲容量（契约 §7.3） */
export const EVENT_BUFFER_CAPACITY = 256

/** 解码失败重试上限（退避 1s/2s，契约 §7.3） */
export const MAX_DECODE_RETRY = 2

/** 帧连续失败阈值（达到即该路 error + 3003） */
export const MAX_CONSECUTIVE_FRAME_FAILURES = 3

/** 默认叠加框颜色与粗细 */
export const DEFAULT_BOX_COLOR = '#ef4444'
export const DEFAULT_BOX_THICKNESS = 2

/** 生效配置（`DEFAULT_OPTIONS`，MUST 逐字实现） */
export const DEFAULT_OPTIONS: MediaPlayerOptions = {
  defaultKind: 'video',
  maxChannels: 6,
  maxChannelsByKind: { video: 6, 'image-seq': 6 },
  columns: 'auto',
  layout: 'grid',
  defaultVolume: 0.8,
  audioPolicy: 'single',
  autoPlay: false,
  defaultLoop: false,
  defaultFrameIntervalMs: 200,
  minFrameIntervalMs: 100,
  throttleMs: 100,
  preloadFrames: 1,
  stepFallbackMs: 40,
  rateOptions: [0.5, 1, 2],
  seekTimeoutMs: 3000,
  lazyVisibility: true,
  hiddenPauseDelayMs: 500,
  bufferLimitFrames: 24,
  frameEvents: false,
  measureFps: true,
  overlay: {
    keys: [...OVERLAY_KEYS],
    pointerEvents: 'none',
    fit: 'contain',
  },
}

/** `columns:'auto'` 列数规则（契约 §2.6） */
export function autoColumns(visibleCount: number): number {
  if (visibleCount <= 1) return 1
  if (visibleCount === 2) return 2
  if (visibleCount <= 4) return 2
  if (visibleCount <= 6) return 3
  if (visibleCount <= 9) return 3
  return 4
}

/** 深拷贝一份缺省配置（防止调用方改到常量本体） */
export function cloneDefaultOptions(): MediaPlayerOptions {
  return {
    ...DEFAULT_OPTIONS,
    maxChannelsByKind: { ...DEFAULT_OPTIONS.maxChannelsByKind },
    rateOptions: [...DEFAULT_OPTIONS.rateOptions],
    overlay: { ...DEFAULT_OPTIONS.overlay, keys: [...DEFAULT_OPTIONS.overlay.keys] },
  }
}
