// media-player · 文档头与基础样式
//
// 视图层不引入任何 CSS 框架；样式内联 + 一个常量表（零运行时依赖）。

import type { CSSProperties } from 'react'

/** 面板根容器（父容器 MUST 提供确定尺寸，契约 H-2） */
export const panelStyle: CSSProperties = {
  position: 'relative',
  display: 'grid',
  gap: 4,
  width: '100%',
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  boxSizing: 'border-box',
}

/** 单通道卡：`position: relative` 容器（叠加层与媒体元素同处其内，CTR-MDP-OVL-03） */
export const tileStyle: CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  background: '#0b0f14',
  borderRadius: 4,
  minWidth: 0,
  minHeight: 0,
}

/** 媒体元素：铺满容器，贴合方式由 objectFit 决定 */
export const mediaStyle = (fit: 'contain' | 'cover' | 'fill'): CSSProperties => ({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: fit,
  background: '#0b0f14',
})

/**
 * 未起播（`idle`）时媒体元素的呈现：**保留元素、隐藏呈现**。
 *
 * MUST NOT 卸载元素 —— 图像流没有 'playing' 事件，卸载会丢掉首帧 `onload` 的上下文，
 * 恢复播放时将永久停在 loading；同时元素复用也是 MDP-PLY-05 的硬约束。
 */
export const hiddenStyle: CSSProperties = {
  visibility: 'hidden',
  pointerEvents: 'none',
}

/** 可读原因态（MUST NOT 空白黑框，契约 §2.1.2） */
export const noticeStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: 12,
  textAlign: 'center',
  color: '#e5e7eb',
  background: '#111827',
  fontSize: 12,
  lineHeight: 1.5,
}

/** 叠加层容器（默认穿透，MDP-OVL-05） */
export const overlayRootStyle = (pointerEvents: 'none' | 'auto'): CSSProperties => ({
  position: 'absolute',
  inset: 0,
  pointerEvents,
  overflow: 'hidden',
  zIndex: 2,
})

/** 输出到 HTML 的样式表（示例页与宿主可直接引用） */
export const MEDIA_PLAYER_CSS = `
.mp-root { position: relative; display: grid; gap: 4px; }
.mp-tile { position: relative; overflow: hidden; background: #0b0f14; border-radius: 4px; }
.mp-tile video, .mp-tile img { display: block; width: 100%; height: 100%; }
.mp-overlay { position: absolute; inset: 0; z-index: 2; }
.mp-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: 4px 6px; background: rgba(17,24,39,.86); color: #e5e7eb; font-size: 12px; }
.mp-controls button { font: inherit; color: inherit; background: #1f2937; border: 1px solid #374151;
  border-radius: 3px; padding: 2px 6px; cursor: pointer; }
.mp-controls button:disabled { opacity: .5; cursor: not-allowed; }
.mp-controls input[type=range] { flex: 1 1 80px; min-width: 60px; }
.mp-hint { color: #fbbf24; }
.mp-corner { position: absolute; color: #e5e7eb; text-shadow: 0 0 3px #000; font-size: 12px; }
`
