// media-player · 通道状态与诊断（契约 §2.5、§7.4、§9）
//
// 纯工厂函数：不持有状态、无 DOM 依赖。

import { MEDIA_SCHEMA_VERSION } from './constants.ts'
import type {
  ChannelDiagnostics,
  ChannelState,
  ChannelStatus,
  MediaChannel,
  MediaDiagnostics,
  MediaSummary,
  Size,
} from './types.ts'

/** 初始诊断（全 0 / 无耗时） */
export function emptyDiagnostics(now: number, throttleMs: number): ChannelDiagnostics {
  return {
    loadMs: null,
    seekMs: null,
    bufferingCount: 0,
    droppedFrames: 0,
    loadFailures: 0,
    lastErrorAt: null,
    pausedByPolicy: false,
    throttleMs,
    updatedAt: now,
  }
}

/** 初始状态：可用 → `idle`；不可用 → `error`（原因与码 MUST 同时非空） */
export function initialStatus(
  channel: MediaChannel,
  input: { now: number; volume: number; throttleMs: number },
): ChannelStatus {
  const unavailable = !channel.available
  return {
    id: channel.id,
    kind: channel.kind,
    state: unavailable ? 'error' : 'idle',
    since: input.now,
    reason: unavailable ? channel.unavailableReason ?? '不可用' : null,
    errorCode: unavailable ? 1003 : null,
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    volume: input.volume,
    muted: false,
    userMuted: false,
    mutedByPolicy: false,
    audible: false,
    rate: 1,
    loop: channel.loop,
    frameIndex: 0,
    frameCount: channel.frameCount,
    videoSize: null,
    visible: true,
    fullscreen: false,
    degraded: { range: false, hint: null },
    diagnostics: emptyDiagnostics(input.now, input.throttleMs),
  }
}

/** 状态计数表（顺序字段冻结在 `MediaSummary.states`） */
export function countStates(statuses: ChannelStatus[]): Record<ChannelState, number> {
  const out: Record<ChannelState, number> = {
    idle: 0,
    loading: 0,
    ready: 0,
    playing: 0,
    paused: 0,
    error: 0,
  }
  for (const s of statuses) out[s.state] += 1
  return out
}

/** 汇总（`MediaSummary`） */
export function buildSummary(input: {
  channels: MediaChannel[]
  statuses: ChannelStatus[]
  mainId: string | null
  audibleId: string | null
  fullscreenId: string | null
  layout: 'grid' | 'focus'
  emptyReason: MediaSummary['emptyReason']
  policyRejections: number
}): MediaSummary {
  const states = countStates(input.statuses)
  const usable = input.channels.filter((c) => c.available).length
  return {
    total: input.channels.length,
    usable,
    visible: input.statuses.filter((s) => s.visible).length,
    states,
    mainId: input.mainId,
    audibleId: input.audibleId,
    fullscreenId: input.fullscreenId,
    layout: input.layout,
    empty: usable === 0,
    emptyReason: usable === 0 ? input.emptyReason : null,
    degradedChannels: input.statuses.filter((s) => s.degraded.range).map((s) => s.id),
    policyRejections: input.policyRejections,
  }
}

/** 诊断（`MediaDiagnostics`） */
export function buildDiagnostics(input: {
  now: number
  channels: MediaChannel[]
  statuses: ChannelStatus[]
  mainId: string | null
  audibleId: string | null
  fullscreenId: string | null
  layout: 'grid' | 'focus'
  policyRejections: number
  fps: number | null
  disposed: boolean
}): MediaDiagnostics {
  const perChannel: Record<string, ChannelDiagnostics> = {}
  for (const s of input.statuses) perChannel[s.id] = { ...s.diagnostics }
  return {
    ts: input.now,
    mainId: input.mainId,
    audibleId: input.audibleId,
    fullscreenId: input.fullscreenId,
    layout: input.layout,
    totals: {
      channels: input.channels.length,
      usable: input.channels.filter((c) => c.available).length,
      visible: input.statuses.filter((s) => s.visible).length,
      playing: input.statuses.filter((s) => s.state === 'playing').length,
      loading: input.statuses.filter((s) => s.state === 'loading').length,
      error: input.statuses.filter((s) => s.state === 'error').length,
      audible: input.statuses.filter((s) => s.audible).length,
    },
    channels: perChannel,
    degraded: {
      range: input.statuses.some((s) => s.degraded.range),
      throttled: input.statuses.some((s) => s.diagnostics.throttleMs > 0),
      visibility: input.statuses.some((s) => s.diagnostics.pausedByPolicy),
    },
    policyRejections: input.policyRejections,
    fps: input.fps,
    disposed: input.disposed,
  }
}

export const SCHEMA_VERSION = MEDIA_SCHEMA_VERSION

/** 分辨率未知 */
export const UNKNOWN_SIZE: Size | null = null
