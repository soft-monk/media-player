// media-player · 画面内容框与归一化坐标（契约 §8）
//
// 纯函数：无副作用、无 DOM 依赖、无 React 依赖。
// 叠加层与画面 MUST 共用同一份 box 计算（CTR-MDP-OVL-01）。

import type { FitMode, NormRect, Rect, Size } from './types.ts'

/** 零矩形 */
const ZERO: Rect = { x: 0, y: 0, w: 0, h: 0 }

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** 尺寸是否可用（非有限数或 ≤0 视为不可用）—— 类型守卫，收窄 `null` */
function usableSize<T extends Size | null | undefined>(s: T): s is T & Size {
  return !!s && finite(s.w) && finite(s.h) && s.w > 0 && s.h > 0
}

/**
 * 画面内容框（CSS 像素，相对容器左上）。
 *
 * - `'contain'`（默认）：画面完整可见，两侧留黑边；黑边内的归一化坐标仍指向画面。
 * - `'cover'`：返回**未裁剪**内容框（可能超出容器），裁剪由渲染侧负责。
 * - `'fill'`：内容框 = 容器（画面被拉伸）。
 * - `media === null`（尺寸未知）：回整容器；尺寸到达后调用方 MUST 立即重算。
 */
export function mediaContentBox(container: Size, media: Size | null, fit: FitMode = 'contain'): Rect {
  if (!usableSize(container)) return { ...ZERO }
  const cw = container.w
  const ch = container.h
  if (fit === 'fill' || !usableSize(media)) return { x: 0, y: 0, w: cw, h: ch }
  const mw = media.w
  const mh = media.h
  const s = fit === 'cover' ? Math.max(cw / mw, ch / mh) : Math.min(cw / mw, ch / mh)
  const w = mw * s
  const h = mh * s
  return { x: (cw - w) / 2, y: (ch - h) / 2, w, h }
}

/**
 * 归一化矩形 → 像素矩形（纯比例映射）。
 * `box` 为零尺寸时 MUST 回零矩形（不抛）。
 */
export function normToPx(r: NormRect, box: Rect): Rect {
  if (!usableSize(box) || !r) return { ...ZERO }
  return {
    x: box.x + r.x * box.w,
    y: box.y + r.y * box.h,
    w: r.w * box.w,
    h: r.h * box.h,
  }
}

/**
 * 像素矩形 → 归一化矩形（`normToPx` 的逆）。
 * `box` 为零尺寸时 MUST 回零矩形。
 */
export function pxToNorm(r: Rect, box: Rect): NormRect {
  if (!usableSize(box) || !r) return { x: 0, y: 0, w: 0, h: 0 }
  return {
    x: (r.x - box.x) / box.w,
    y: (r.y - box.y) / box.h,
    w: r.w / box.w,
    h: r.h / box.h,
  }
}

/**
 * 把归一化矩形裁剪到 [0,1]（契约 §8.4）。
 *
 * 返回 `null` 表示**不渲染**：分量非有限数，或裁剪后宽/高 ≤ 0
 * （完全越界的框 MUST NOT 被夹紧成边缘假框）。
 *
 * 宽高按 1e-9 取整：`x+w-0.1` 这类浮点漂移会让同帧内「叠加层」与「画面基准」
 * 出现 1e-17 级差异，取整后两者比较不会误判为"错位"（容差 1px 的机检更稳）。
 */
export function clampNormRect(r: NormRect): NormRect | null {
  if (!r) return null
  if (!finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) return null
  if (r.w <= 0 || r.h <= 0) return null
  const x0 = Math.max(0, Math.min(1, r.x))
  const y0 = Math.max(0, Math.min(1, r.y))
  const x1 = Math.max(0, Math.min(1, r.x + r.w))
  const y1 = Math.max(0, Math.min(1, r.y + r.h))
  const w = Math.round((x1 - x0) * 1e9) / 1e9
  const h = Math.round((y1 - y0) * 1e9) / 1e9
  if (!(w > 0) || !(h > 0)) return null
  return { x: x0, y: y0, w, h }
}

/** 矩形完全落在 [0,1] 内（未越界；1e-9 容差吸收浮点漂移） */
export function isRectInUnit(r: NormRect): boolean {
  if (!r) return false
  if (!finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) return false
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9
}

/**
 * 被判定**不渲染**的框的数量（分量非有限数 / 裁剪后宽高 ≤ 0，契约 §8.4）。
 *
 * 契约要求丢弃的框"计入叠加层诊断计数"，而单框非法 MUST NOT 让整层失败。
 * 定义放在机制层（无框架依赖），视图层直接复用，单测可脱离 React 直接跑。
 */
export function countDroppedBoxes(content: { boxes?: unknown } | null | undefined): number {
  const boxes = content?.boxes
  if (!Array.isArray(boxes)) return 0
  let dropped = 0
  for (const b of boxes) {
    const rect = (b as { rect?: NormRect } | null | undefined)?.rect
    if (!rect || clampNormRect(rect) === null) dropped += 1
  }
  return dropped
}

/** 数值夹紧（非有限数回退到 `fallback`） */
export function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (!finite(v)) return fallback
  return Math.min(max, Math.max(min, v))
}
