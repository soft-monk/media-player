// media-player · 控制器内部扩展访问（视图层用）
//
// 视图层需要若干"契约之外的最小扩展面"：上报元素事件、实测尺寸、帧图片结果。
// 为避免闭包捕获旧值，媒体元素事件一律用 `getController()` 实时读取控制器，
// 该函数即这一读法的唯一入口。

import type { MediaController } from '../core/types.ts'

/** 视图层可用的控制器扩展面（`MediaControllerImpl` 的子集） */
export interface ViewControllerExtensions {
  reportContainerSize(id: string, size: { w: number; h: number } | null): void
  reportMediaSize(id: string, size: { w: number; h: number } | null): void
  reportMediaEvent(id: string, name: string, payload?: unknown): void
  reportMediaCommandError(id: string, name: string, reason: string): void
  reportImageEvent(id: string, index: number, ok: boolean, url?: string): void
  /** 原生全屏态变化（`fullscreenchange`；MDP-OVL-04 基准重算的触发点之一） */
  reportFullscreenElement(id: string, inFullscreen: boolean): void
  /** 被判定不渲染的叠加框数量（契约 §8.4 叠加层诊断计数） */
  reportDroppedBoxes(count: number): void
  reportFps(fps: number | null): void
  shouldMeasureFps(): boolean
  setElement(id: string, el: HTMLElement | null): void
  setCallbacks(cbs: {
    onEvent?: (ev: import('../core/types.ts').MediaEvent) => void
    onChannelState?: (s: import('../core/types.ts').ChannelStatus) => void
  }): void
  setEmptyCallback(
    cb:
      | ((
          reason: import('../core/types.ts').EmptyReason,
          detail: { total: number; usable: number; message: string },
        ) => void)
      | undefined,
  ): void
  getContentBox(id: string): import('../core/types.ts').Rect
}

/** 取控制器扩展面；未实现时（宿主自建控制器）返回 null */
export function ext(c: MediaController | null | undefined): ViewControllerExtensions | null {
  const candidate = c as unknown as Partial<ViewControllerExtensions> | undefined
  if (!candidate || typeof candidate.reportMediaEvent !== 'function') return null
  return candidate as ViewControllerExtensions
}
