// media-player · 唯一公开入口（契约 §1.1）
//
// 65 条公开入口 = 组件 4 + Hook 1 + 工厂 1 + 纯函数 7 + 常量 8 + 类型 42（+2 个显式导出的附属类型）
// 红线（契约 §0.3）：
//   R-1 MUST NOT import map-2d
//   R-2 MUST NOT import ws-client / realtime-hub
//   R-3 源码与公开接口 MUST NOT 出现业务词
// 深层导入：宿主 MUST NOT 从 src/** 深层路径导入（一切以本文件为准）。

/* ── 组件（4） ── */
export { MediaPlayer } from './react/MediaPlayer.ts'
export { MediaTile } from './react/MediaTile.ts'
export { MediaOverlay } from './react/MediaOverlay.ts'
export { MediaControls } from './react/MediaControls.ts'

/* ── Hook（1） ── */
export { useMediaPlayer } from './react/useMediaPlayer.ts'

/* ── 工厂（1） ── */
export { createMediaController } from './core/controller.ts'

/* ── 纯函数（7） ── */
export { normalizeChannels, normalizeKind, normalizeOverlayKeys, parseSemver } from './core/normalize.ts'
export { expandFrames, resolveFrameUrl } from './core/frames.ts'
export { mediaContentBox, normToPx, pxToNorm } from './core/geometry.ts'
export { pickAudible } from './core/audio.ts'

/* ── 常量（8） ── */
export {
  CHANNEL_STATES,
  DEFAULT_OPTIONS,
  EMPTY_REASONS,
  MEDIA_EVENTS,
  MEDIA_SCHEMA_VERSION,
  OVERLAY_KEYS,
  SUPPORTED_SCHEMA_MAJOR,
  autoColumns,
  cloneDefaultOptions,
} from './core/constants.ts'
export { MEDIA_ERROR } from './core/errors.ts'

/* ── 适配器缺省实现（可选注入项的内置行为） ── */
export { builtinProbe, httpChannelSource, isSameOriginOrRelative, systemClock } from './core/adapters.ts'
export { makeElementHandle } from './core/viewport.ts'
export { MEDIA_PLAYER_CSS } from './react/styles.ts'

/* ── 类型（42 + 附属） ── */
export type {
  AudioPolicy,
  ChannelDiagnostics,
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
  MediaEventData,
  MediaEventListener,
  MediaEventType,
  MediaPlayerAdapters,
  MediaPlayerCallbacks,
  MediaPlayerHandle,
  MediaPlayerOptions,
  MediaResult,
  MediaSetResultData,
  MediaSummary,
  MediaViewPort,
  MediaViewState,
  NormRect,
  OverlayBox,
  OverlayBoxStyle,
  OverlayContent,
  OverlayKey,
  OverlaysConfig,
  RawChannelEntry,
  Rect,
  Size,
} from './core/types.ts'

/* ── 组件 Props 与附属类型（契约 §2.1） ── */
export type { MediaPlayerProps } from './react/MediaPlayer.ts'
export type { MediaTileProps } from './react/MediaTile.ts'
export type { MediaOverlayProps } from './react/MediaOverlay.ts'
export type { MediaControlsKey, MediaControlsProps } from './react/MediaControls.ts'
export type { UseMediaPlayerResult } from './react/useMediaPlayer.ts'
export type { MediaCommandSink } from './core/viewport.ts'
export type { NormalizeResult } from './core/normalize.ts'
