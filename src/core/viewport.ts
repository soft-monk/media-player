// media-player · 视图桥的 DOM 形态（控制器 ←→ 视图层）
//
// 本文件属于 core 层：只描述接口，不 import react。
// React 组件（`src/react/MediaTile.tsx`）把控制器命令经本接口落到真实元素上，
// 从而"界面与接口走同一路径"（MDP-PLY-01）。

import type { ChannelKind, MediaElementHandle } from './types.ts'

/** 媒体元素业务命令面（DOM 无关，便于无 DOM 替身） */
export interface MediaCommandSink {
  play(): void
  pause(): void
  stop(): void
  seek(positionMs: number): void
  setVolume(v: number): void
  setMuted(m: boolean): void
  setRate(r: number): void
  setLoop(l: boolean): void
  setFrame(index: number, url: string | null): void
}

/** 组装一个媒体元素句柄（控制器只认这个句柄） */
export function makeElementHandle(
  id: string,
  kind: ChannelKind,
  sink: MediaCommandSink,
): MediaElementHandle {
  return {
    id,
    kind,
    play: () => sink.play(),
    pause: () => sink.pause(),
    stop: () => sink.stop(),
    seek: (ms) => sink.seek(ms),
    setVolume: (v) => sink.setVolume(v),
    setMuted: (m) => sink.setMuted(m),
    setRate: (r) => sink.setRate(r),
    setLoop: (l) => sink.setLoop(l),
    setFrame: (i, url) => sink.setFrame(i, url),
  }
}
