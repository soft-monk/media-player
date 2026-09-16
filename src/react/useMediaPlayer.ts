// media-player · useMediaPlayer（契约 §2.2）
//
// - 卸载时 MUST 调用 `controller.dispose()`；
// - 返回的 `summary` MUST 随 `media.*` 事件更新（同一渲染帧内批量合并，MUST NOT 每帧 setState）；
// - `controller` 引用 MUST 稳定（options 变化走 setOptions）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { createMediaController } from '../core/controller.ts'
import type {
  MediaController,
  MediaControllerInit,
  MediaPlayerOptions,
  MediaSummary,
} from '../core/types.ts'

export interface UseMediaPlayerResult {
  controller: MediaController
  summary: MediaSummary
}

/** 创建并订阅一个控制器；返回稳定引用与实时汇总 */
export function useMediaPlayer(init?: MediaControllerInit): UseMediaPlayerResult {
  const ref = useRef<MediaController | null>(null)
  if (ref.current === null) {
    ref.current = createMediaController(init)
  }
  const controller = ref.current
  const [summary, setSummary] = useState<MediaSummary>(() => controller.getSummary())

  // 初始化参数只在首次生效：后续变化走 setOptions/setAdapters/setChannels
  const initRef = useRef(init)

  useEffect(() => {
    let queued = false
    const bump = (): void => {
      if (queued) return
      queued = true
      // 合并到同一渲染帧：事件风暴（6 路 × 轮播）不会导致每帧 setState
      queueMicrotask(() => {
        queued = false
        setSummary(controller.getSummary())
      })
    }
    const unsubscribe = controller.subscribe(bump)
    return () => {
      unsubscribe()
      controller.dispose()
    }
  }, [controller])

  // 首次之后传进来的 options 走 setOptions
  const firstOptions = useRef<Partial<MediaPlayerOptions> | undefined>(initRef.current?.options)
  useEffect(() => {
    const next = init?.options
    if (!next) return
    if (firstOptions.current === next) return
    firstOptions.current = next
    controller.setOptions(next)
  }, [init?.options, controller])

  // 首次之后传进来的 channels 走 setChannels
  const firstChannels = useRef<unknown>(initRef.current?.channels)
  useEffect(() => {
    if (!init || !('channels' in init)) return
    if (firstChannels.current === init.channels) return
    firstChannels.current = init.channels
    controller.setChannels(init.channels)
  }, [init?.channels, controller, init])

  return useMemo(() => ({ controller, summary }), [controller, summary])
}
