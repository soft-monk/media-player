// media-player · 帧序列展开（契约 §2.4、§6.2）
//
// 纯函数：无法展开 MUST 回 [] / null（不抛）。
// 展开结果 MUST 只由 `url` + 下标构成 —— 不拼接任何外域地址、不注入查询串（契约 §1.4）。

import type { IFrameUrlResolver, MediaChannel } from './types.ts'

const PLACEHOLDER_ZERO = /\{i\}/g
const PLACEHOLDER_PAD = /\{i:(\d{1,4})\}/g

/** 是否含帧占位符（`{i}` 或 `{i:N}`）—— 用全新正则实例做无状态判定 */
export function hasFramePlaceholder(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false
  return /\{i\}|\{i:\d{1,4}\}/.test(url)
}

/** 展开模板：`{i}` 不补零，`{i:N}` 左补零到 N 位 */
export function expandTemplate(url: string, index: number): string {
  const i = Math.max(0, Math.floor(index))
  let out = url.replace(PLACEHOLDER_ZERO, String(i))
  out = out.replace(PLACEHOLDER_PAD, (_m, width: string) => String(i).padStart(Number(width), '0'))
  return out
}

/**
 * 展开通道的全部帧 URL。
 *
 * 优先级：`frames` > `resolver` > `url` 模板展开；无法展开 MUST 回 `[]`。
 */
export function expandFrames(channel: MediaChannel, resolver?: IFrameUrlResolver): string[] {
  try {
    if (!channel) return []
    if (channel.kind !== 'image-seq') return []
    if (Array.isArray(channel.frames) && channel.frames.length > 0) {
      return channel.frames.filter((u): u is string => typeof u === 'string' && u.length > 0)
    }
    const count = Math.max(0, Math.floor(channel.frameCount || 0))
    if (count <= 0) return []
    const out: string[] = []
    for (let i = 0; i < count; i++) {
      const url = resolveFrameUrl(channel, i, resolver)
      if (url) out.push(url)
    }
    return out
  } catch {
    return []
  }
}

/**
 * 单帧 URL：下标越界或不可展开 MUST 回 `null`。
 *
 * 优先级：`frames[index]` > `resolver.resolve()` > `url` 模板展开。
 */
export function resolveFrameUrl(
  channel: MediaChannel,
  index: number,
  resolver?: IFrameUrlResolver,
): string | null {
  try {
    if (!channel || channel.kind !== 'image-seq') return null
    const i = Math.floor(index)
    if (!Number.isFinite(i) || i < 0) return null
    const total = channel.frames ? channel.frames.length : channel.frameCount
    if (total > 0 && i >= total) return null

    if (channel.frames && channel.frames.length > 0) {
      const u = channel.frames[i]
      return typeof u === 'string' && u.length > 0 ? u : null
    }
    if (resolver) {
      const u = resolver.resolve(channel.id, i)
      if (typeof u === 'string' && u.length > 0) return u
    }
    const tpl = channel.url
    if (!tpl) return null
    if (hasFramePlaceholder(tpl)) return expandTemplate(tpl, i)
    // 无占位符 → 单帧源：只有下标 0 可解析
    return i === 0 ? tpl : null
  } catch {
    return null
  }
}
