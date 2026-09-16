// media-player · 错误码与结果信封（契约 §4、§1.3）
//
// P10：失败 MUST NOT 抛异常跨边界。公开方法一律返回 `MediaResult`。
// code 是机检依据；message 只供人读（CTR-MDP-ERR-03）。

import type { MediaErrorCode, MediaResult } from './types.ts'

/** 成功码（唯一） */
export const OK: MediaErrorCode = 0

/** 错误码名称表（禁止字面量散落） */
export const MEDIA_ERROR = {
  OK: 0,
  // 复用 protocol.md §3（语义不扩大）
  BAD_PARAM: 1000,
  CONFLICT: 1002,
  PRECONDITION: 1003,
  NOT_FOUND: 1004,
  INTERNAL: 1005,
  SCHEMA_MISMATCH: 1006,
  // 本模块私有扩展（契约 §4.2 已给理由）
  SOURCE_UNREACHABLE: 3001,
  DECODE_UNSUPPORTED: 3002,
  FRAMES_UNAVAILABLE: 3003,
  LIMIT_REJECTED: 3004,
  CAPABILITY_MISSING: 3005,
} as const satisfies Record<string, MediaErrorCode>

/** 可读中文消息（每码一句；具体上下文由调用方补 `detail`） */
const CODE_MESSAGE: Record<number, string> = {
  0: '成功',
  1000: '请求参数错误',
  1002: '冲突拒绝：存在互斥动作',
  1003: '前置条件未满足',
  1004: '资源不存在',
  1005: '模块内部错误',
  1006: '清单 schema 版本不匹配',
  3001: '媒体源不可达',
  3002: '媒体格式或解码不受支持',
  3003: '帧序列不可用',
  3004: '被上限或策略拒绝',
  3005: '宿主环境能力缺失',
}

/** 该码是否可重试（供 `media.error.recoverable`） */
const RECOVERABLE: ReadonlySet<number> = new Set([3001, 3003, 1005])

/** 成功结果 */
export function ok<T>(data?: T, extra?: { idempotent?: boolean; clamped?: boolean }): MediaResult<T> {
  const r: MediaResult<T> = { ok: true, code: OK, message: CODE_MESSAGE[0] }
  if (data !== undefined) r.data = data
  if (extra?.idempotent) r.idempotent = true
  if (extra?.clamped) r.clamped = true
  return r
}

/** 幂等命中：code 恒 0 + `idempotent:true`（CTR-MDP-EC-02） */
export function okIdempotent<T>(data?: T): MediaResult<T> {
  return ok(data, { idempotent: true })
}

/** 失败结果（不抛异常） */
export function fail<T = unknown>(
  code: MediaErrorCode,
  detail?: string,
  data?: T,
  clamped?: boolean,
): MediaResult<T> {
  const base = CODE_MESSAGE[code] ?? '未知错误'
  const r: MediaResult<T> = {
    ok: false,
    code,
    message: detail ? `${base}：${detail}` : base,
  }
  if (data !== undefined) r.data = data
  if (clamped) r.clamped = true
  return r
}

/** 该错误码是否可重试（`recoverable=false` 表示需换素材，契约 §5.2） */
export function isRecoverable(code: MediaErrorCode): boolean {
  return RECOVERABLE.has(code)
}

/** 码 → 可读消息（不含上下文） */
export function codeMessage(code: MediaErrorCode): string {
  return CODE_MESSAGE[code] ?? '未知错误'
}

/**
 * 执行一段可能抛错的动作并兜底为 `MediaResult`（CTR-MDP-EC-01）。
 * 内部异常的码为 `1005`。
 */
export function guard<T>(fn: () => MediaResult<T>, fallbackDetail: string): MediaResult<T> {
  try {
    return fn()
  } catch (e) {
    return fail(1005, `${fallbackDetail}（${errText(e)}）`)
  }
}

/** 把任意抛出物转成可读文本 */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
