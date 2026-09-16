// media-player · 事件发射与背压（契约 §5.1、§5.2、§7.3）
//
// - 信封恰好三字段 `{ type, data, ts }`；
// - 每通道每 `throttleMs` 至多发一条 `media.state` / `media.frame`；
// - 未订阅的事件 MUST 被丢弃但计数（进环形缓冲，供排障）。

import { EVENT_BUFFER_CAPACITY, MEDIA_EVENTS } from './constants.ts'
import type { MediaEvent, MediaEventListener, MediaEventType } from './types.ts'

/** 事件类型集合（用于"未知事件名"判定） */
const KNOWN_EVENT_TYPES: readonly MediaEventType[] = [
  MEDIA_EVENTS.state,
  MEDIA_EVENTS.error,
  MEDIA_EVENTS.empty,
  MEDIA_EVENTS.degraded,
  MEDIA_EVENTS.frame,
]

export function isKnownEventType(t: unknown): t is MediaEventType {
  return KNOWN_EVENT_TYPES.includes(t as MediaEventType)
}

/** 事件名是否满足 `media.<subject>` 命名规范（CTR-EV-01） */
export function isValidEventName(name: string): boolean {
  return /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(name)
}

/** 事件总线：订阅 + 频率合并 + 环形缓冲 */
export class MediaEmitter {
  private listeners = new Set<MediaEventListener>()
  private buffer: MediaEvent[] = []
  private lastAt = new Map<string, number>()
  private throttleMs: number
  private ignored = 0
  private callbackErrors = 0

  constructor(throttleMs: number) {
    this.throttleMs = throttleMs
  }

  setThrottleMs(ms: number): void {
    this.throttleMs = ms
  }

  subscribe(listener: MediaEventListener): () => void {
    if (typeof listener !== 'function') return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 订阅者数量（诊断用） */
  get subscriberCount(): number {
    return this.listeners.size
  }

  /** 宿主回调抛异常的累计次数（CTR-MDP-EC-05） */
  get callbackErrorCount(): number {
    return this.callbackErrors
  }

  /** 未知事件名（未订阅但被计数）的次数 */
  get ignoredCount(): number {
    return this.ignored
  }

  /** 事件环形缓冲快照（容量 256，契约 §7.3） */
  snapshot(): MediaEvent[] {
    return this.buffer.map((e) => ({ type: e.type, data: { ...e.data }, ts: e.ts }) as MediaEvent)
  }

  /**
   * 发射事件。
   *
   * @param rateKey 需要限频时给 `channelId`（每通道每 throttleMs 至多一条）
   * @param force   恒发（错误/降级/空清单等低频关键事件）
   */
  emit(ev: MediaEvent, opts?: { rateKey?: string; force?: boolean }): boolean {
    if (!isKnownEventType(ev.type)) {
      this.ignored += 1
      return false
    }
    const key = opts?.rateKey
    if (key && !opts?.force) {
      const last = this.lastAt.get(key)
      // 首次一律放行；此后每通道每 throttleMs 至多一条
      if (last !== undefined && (ev.ts - last < this.throttleMs || ev.ts < last)) return false
      this.lastAt.set(key, ev.ts)
    }

    this.buffer.push(ev)
    if (this.buffer.length > EVENT_BUFFER_CAPACITY) {
      this.buffer.splice(0, this.buffer.length - EVENT_BUFFER_CAPACITY)
    }

    for (const l of Array.from(this.listeners)) {
      try {
        l(ev)
      } catch {
        // 宿主回调抛错 MUST 被捕获并计数，MUST NOT 中断播放（CTR-MDP-EC-05）
        this.callbackErrors += 1
      }
    }
    return true
  }

  /** 安全调用任一宿主回调（异常捕获 + 计数） */
  safeCall(fn: (() => void) | undefined): void {
    if (typeof fn !== 'function') return
    try {
      fn()
    } catch {
      this.callbackErrors += 1
    }
  }

  clear(): void {
    this.listeners.clear()
    this.buffer = []
    this.lastAt.clear()
  }
}
