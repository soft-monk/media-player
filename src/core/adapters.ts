// media-player · 默认适配器（时钟 / 清单来源 / 能力探测）
//
// 全部为"缺省有内置行为"的可选注入项（契约 §3.2、§3.4）。
// 零外网：探测与清单请求只对**同源或相对** URL 发起（契约 §1.4）。

import { errText } from './errors.ts'
import type { IChannelSource, IClock, IMediaProbe } from './types.ts'

/** 默认时钟：未注入时用 `Date.now`（契约 §3.2） */
export const systemClock: IClock = { nowMs: () => Date.now() }

/** 是否是**浏览器**的 location（Node ≥ 21 也挂了全局 `location`，但它没有 origin） */
function browserLocation(): Location | null {
  const loc = (globalThis as { location?: Location }).location
  if (!loc || typeof loc.origin !== 'string' || loc.origin.length === 0) return null
  if (typeof loc.href !== 'string' || loc.href.length === 0) return null
  return loc
}

/**
 * 是否同源/相对（跨域 MUST NOT 探测、MUST NOT 拼接）。
 *
 * 非浏览器环境（无真实 `location.origin`，例如 node 单测 / SSR）下：**相对 URL 视为本地**，
 * 绝对 URL（含协议相对 `//host/...`）一律视为外域 —— 否则"零外网"会在 node 里失效。
 */
export function isSameOriginOrRelative(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  // 协议相对（//host/...）视为跨域
  if (url.startsWith('//')) return false
  const loc = browserLocation()
  try {
    if (!loc) {
      // 无浏览器 location：只接受相对/同源相对形式，绝对 URL 视为外域
      const parsed = new URL(url, 'http://localhost/')
      return parsed.origin === 'http://localhost'
    }
    const resolved = new URL(url, loc.href)
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return false
    return resolved.origin === loc.origin
  } catch {
    return false
  }
}

/** 探测结果：`known=false` 表示跨域不可探测（`degraded.range` 为"未知"） */
export interface ProbeOutcome {
  known: boolean
  reachable: boolean
  acceptRanges: boolean
}

/**
 * 内建探测：同源 `GET` + `Range: bytes=0-0`，看 `206` / `Accept-Ranges`。
 *
 * 用 `GET` 而非 `HEAD`：部分静态服务对 `HEAD` 不返回 `Range` 语义。
 */
export async function builtinProbe(url: string, signal?: AbortSignal): Promise<ProbeOutcome> {
  if (!isSameOriginOrRelative(url)) {
    return { known: false, reachable: true, acceptRanges: false }
  }
  const hasFetch = typeof globalThis.fetch === 'function'
  if (!hasFetch) return { known: false, reachable: true, acceptRanges: false }
  try {
    const res = await globalThis.fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal,
    })
    const accept = String(res.headers?.get?.('accept-ranges') ?? '').toLowerCase()
    // 读掉极小的响应体，避免连接悬挂
    try {
      await res.arrayBuffer()
    } catch {
      /* 忽略 */
    }
    return {
      known: true,
      reachable: res.ok || res.status === 206,
      acceptRanges: res.status === 206 || accept === 'bytes',
    }
  } catch {
    return { known: true, reachable: false, acceptRanges: false }
  }
}

/** 由 `IMediaProbe` 或内建探测给出的 `{ reachable, acceptRanges }` */
export async function probeWith(
  probe: IMediaProbe | undefined,
  url: string,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  if (probe) {
    try {
      const r = await probe.probe(url)
      return { known: true, reachable: !!r?.reachable, acceptRanges: !!r?.acceptRanges }
    } catch {
      return { known: true, reachable: false, acceptRanges: false }
    }
  }
  return builtinProbe(url, signal)
}

/** 基于 `fetch` 的清单来源（宿主后端 `/api/v1/media/videos` 等） */
export function httpChannelSource(
  url: string,
  init?: { timeoutMs?: number; pick?: (raw: unknown) => unknown },
): IChannelSource {
  return {
    async list(signal?: AbortSignal): Promise<unknown> {
      if (typeof globalThis.fetch !== 'function') {
        throw new Error('当前环境无 fetch，无法从来源取清单')
      }
      if (!isSameOriginOrRelative(url)) {
        throw new Error('清单地址必须同源或相对（本模块 MUST NOT 请求外域）')
      }
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null
      const timer =
        init?.timeoutMs && ctrl
          ? setTimeout(() => ctrl.abort(), init.timeoutMs)
          : null
      if (signal && ctrl) {
        if (signal.aborted) ctrl.abort()
        else signal.addEventListener('abort', () => ctrl.abort(), { once: true })
      }
      try {
        const res = await globalThis.fetch(url, { signal: ctrl?.signal ?? signal })
        if (!res.ok) throw new Error(`清单请求失败：HTTP ${res.status}`)
        const json: unknown = await res.json()
        const picked = init?.pick ? init.pick(json) : pickListShape(json)
        return picked
      } catch (e) {
        throw new Error(errText(e))
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}

/**
 * 常见后端信封 → 清单数组。
 * 兼容 `{data:[...]}` / `{items:[...]}` / `{channels:[...]}` / 裸数组。
 */
export function pickListShape(json: unknown): unknown {
  if (Array.isArray(json)) return json
  if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>
    for (const k of ['data', 'items', 'channels', 'list']) {
      if (Array.isArray(o[k])) return o[k]
    }
    if (o.data && typeof o.data === 'object') {
      const d = o.data as Record<string, unknown>
      for (const k of ['items', 'channels', 'list']) {
        if (Array.isArray(d[k])) return d[k]
      }
    }
  }
  return json
}
