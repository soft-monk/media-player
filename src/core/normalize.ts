// media-player · 清单归一化（契约 §2.4、§6.2、§6.5、§6.6、§7.2）
//
// 纯函数：MUST NOT 抛错；非法条目逐条进 `rejected`，有效条目照常生效（部分成功）。
// MUST NOT 硬编码任何通道名与 URL —— 一切来自宿主输入。

import { KIND_ALIASES, MEDIA_SCHEMA_VERSION, OVERLAY_KEYS, SUPPORTED_SCHEMA_MAJOR } from './constants.ts'
import { fail, ok } from './errors.ts'
import { hasFramePlaceholder } from './frames.ts'
import type {
  ChannelKind,
  MediaChannel,
  MediaPlayerOptions,
  MediaResult,
  MediaSetResultData,
  OverlayKey,
} from './types.ts'

/** 归一化结果：结果信封 + 通道数组 */
export type NormalizeResult = MediaResult<MediaSetResultData> & { channels: MediaChannel[] }

type RejectedItem = { index: number; code: 1000 | 1006; reason: string }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** 语义化版本串 → `[major, minor, patch]`；非法回 null */
export function parseSemver(v: unknown): [number, number, number] | null {
  if (typeof v !== 'string') return null
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** `kind` 归一化（别名表见契约 §6.2）；未给取 `defaultKind`，未知回 null */
export function normalizeKind(raw: unknown, defaultKind: ChannelKind = 'video'): ChannelKind | null {
  if (raw === undefined || raw === null) return defaultKind
  if (typeof raw !== 'string') return null
  const hit = KIND_ALIASES[raw.trim().toLowerCase()]
  return hit ?? null
}

/** 叠加项过滤（只保留合法键，保持 OVERLAY_KEYS 顺序） */
export function normalizeOverlayKeys(raw: unknown): OverlayKey[] | null {
  if (!Array.isArray(raw)) return null
  const set = new Set<OverlayKey>()
  for (const k of raw) {
    const hit = OVERLAY_KEYS.find((o) => o === k)
    if (hit) set.add(hit)
  }
  return OVERLAY_KEYS.filter((k) => set.has(k))
}

/** 取出条目数组（数组本身 / `{channels:[...]}`）；形状不受支持回 null */
function pickChannels(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (isObject(raw) && Array.isArray(raw.channels)) return raw.channels
  return null
}

/**
 * 把宿主输入归一化为通道数组。
 *
 * 接受三种形状（契约 §6.5）：
 * ① 既有接口原样 `[{name,url}]`；② 完整条目数组；③ 带 `schemaVersion` 的信封。
 */
export function normalizeChannels(
  raw: unknown,
  options?: Partial<MediaPlayerOptions>,
): NormalizeResult {
  const defaultKind: ChannelKind = options?.defaultKind ?? 'video'
  const minFrameIntervalMs = num(options?.minFrameIntervalMs) ?? 100
  const defaultFrameIntervalMs = num(options?.defaultFrameIntervalMs) ?? 200
  const defaultLoop = options?.defaultLoop ?? false
  const defaultOverlayKeys: OverlayKey[] = normalizeOverlayKeys(options?.overlay?.keys) ?? [
    ...OVERLAY_KEYS,
  ]

  // ── 信封与 schema 版本（契约 §6.6）
  let schemaVersion: string | null = null
  if (isObject(raw) && raw.schemaVersion !== undefined && raw.schemaVersion !== null) {
    const parsed = parseSemver(raw.schemaVersion)
    if (!parsed) {
      const r = fail<MediaSetResultData>(1000, 'schemaVersion 不是语义化版本串')
      return { ...r, channels: [] }
    }
    schemaVersion = raw.schemaVersion as string
    if (parsed[0] !== SUPPORTED_SCHEMA_MAJOR) {
      const detail = `清单 schema MAJOR=${parsed[0]}，本模块支持 MAJOR=${SUPPORTED_SCHEMA_MAJOR}（当前 ${MEDIA_SCHEMA_VERSION}）`
      const r = fail<MediaSetResultData>(1006, detail)
      return { ...r, channels: [] }
    }
  }

  const list = pickChannels(raw)
  if (!list) {
    const r = fail<MediaSetResultData>(
      1000,
      '清单形状不受支持：既不是数组，也没有 channels 数组',
    )
    return { ...r, channels: [] }
  }

  // ── 逐条归一（部分成功）
  const rejected: RejectedItem[] = []
  const channels: MediaChannel[] = []
  const usedIds = new Map<string, number>()
  const usedNames = new Map<string, number>()

  const uniqueId = (base: string): string => {
    const n = (usedIds.get(base) ?? 0) + 1
    usedIds.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  }
  const uniqueName = (base: string): string => {
    const n = (usedNames.get(base) ?? 0) + 1
    usedNames.set(base, n)
    return n === 1 ? base : `${base}#${n}`
  }

  for (let index = 0; index < list.length; index++) {
    const item = list[index]
    if (!isObject(item)) {
      rejected.push({ index, code: 1000, reason: '条目不是对象' })
      continue
    }

    const rawId = str(item.id)
    const rawName = str(item.name)
    const rawUrl = str(item.url)
    if (!rawId && !rawName && !rawUrl) {
      rejected.push({ index, code: 1000, reason: 'id / name / url 全缺，无法派生标识' })
      continue
    }

    const id = uniqueId(rawId ?? rawName ?? (rawUrl as string))
    const name = uniqueName(rawName ?? rawId ?? (rawUrl as string))

    const kind = normalizeKind(item.kind, defaultKind)
    const effectiveKind: ChannelKind = kind ?? 'video'

    const frames = Array.isArray(item.frames)
      ? item.frames.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : null
    const rawFrameCount = num(item.frameCount)

    // 不可用原因：既有"宿主声明不可用"，也有"输入自相矛盾/缺源"
    let reason: string | null = null
    if (!kind) reason = `unknown-kind: ${String(item.kind)}`

    let frameCount = 0
    if (effectiveKind === 'video') {
      if (!rawUrl && !reason) reason = 'missing-src'
    } else {
      const hasFrames = !!frames && frames.length > 0
      frameCount = hasFrames ? (frames as string[]).length : Math.max(1, rawFrameCount ?? 1)
      const templated = !!rawUrl && hasFramePlaceholder(rawUrl)
      if (!rawUrl && !hasFrames) {
        reason = reason ?? 'missing-src'
      } else if (hasFrames && rawFrameCount !== null && rawFrameCount !== (frames as string[]).length) {
        reason = reason ?? 'frames-length-mismatch'
      } else if (!hasFrames && rawFrameCount !== null && rawFrameCount > 1 && !templated) {
        // frames 为空 + url 无占位符 + frameCount>1 = 自相矛盾（契约 §7.2）
        reason = reason ?? 'no-frames'
      }
    }

    const declaredAvailable = bool(item.available, true)
    const available = declaredAvailable && !reason
    channels.push({
      id,
      name,
      kind: effectiveKind,
      url: rawUrl,
      frames: effectiveKind === 'image-seq' ? frames : null,
      frameCount: effectiveKind === 'image-seq' ? frameCount : 0,
      frameIntervalMs: Math.max(
        minFrameIntervalMs,
        num(item.frameIntervalMs) ?? defaultFrameIntervalMs,
      ),
      sourceLabel: str(item.sourceLabel),
      available,
      unavailableReason: available ? null : reason ?? str(item.unavailableReason) ?? '不可用',
      loop: bool(item.loop, defaultLoop),
      poster: str(item.poster),
      overlayKeys: normalizeOverlayKeys(item.overlayKeys) ?? [...defaultOverlayKeys],
      meta: isObject(item.meta) ? { ...item.meta } : {},
    })
  }

  const data: MediaSetResultData = {
    total: list.length,
    applied: channels.map((c) => c.id),
    rejected,
    usable: channels.filter((c) => c.available).length,
    schemaVersion,
  }
  return { ...ok<MediaSetResultData>(data), channels }
}
