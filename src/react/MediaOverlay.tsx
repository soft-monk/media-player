// media-player · MediaOverlay（契约 §2.1.3）
//
// 对齐基准 MUST 为画面**内容框**（§8.1），MUST NOT 用容器百分比或 vw/vh 定位。
// 归一化坐标由 `normToPx` 映射（与画面共用同一份 box，CTR-MDP-OVL-01）。

import { useMemo } from 'react'
import { DEFAULT_BOX_COLOR, DEFAULT_BOX_THICKNESS } from '../core/constants.ts'
import { clampNormRect, normToPx } from '../core/geometry.ts'
import { overlayRootStyle } from './styles.ts'
import type { CSSProperties, ReactNode } from 'react'
import type { NormRect, OverlayBox, OverlayContent, OverlayKey, Rect } from '../core/types.ts'

export interface MediaOverlayProps {
  content: OverlayContent
  /** 缺省取 options.overlay.keys（默认全部 6 项） */
  keys?: OverlayKey[]
  /** 缺省 'none'（穿透，MDP-OVL-05） */
  pointerEvents?: 'none' | 'auto'
  /** 缺省 'contain'，MUST 与媒体元素 object-fit 一致 */
  fit?: 'contain' | 'cover' | 'fill'
  className?: string
  style?: CSSProperties
  children?: ReactNode
  /**
   * 内容框（CSS 像素，相对容器左上）。由控制器给出，保证与画面同源；
   * 不传时回落到"整容器"基准（宿主单独使用本组件时的退化口径）。
   */
  box?: Rect
  /** 容器尺寸（`box` 缺省时用于退化计算） */
  container?: { w: number; h: number } | null
}

/** 角标位置 → 内联样式 */
function cornerStyle(corner: 'tl' | 'tr' | 'bl' | 'br'): CSSProperties {
  const base: CSSProperties = { position: 'absolute', padding: 4 }
  switch (corner) {
    case 'tl':
      return { ...base, left: 0, top: 0 }
    case 'tr':
      return { ...base, right: 0, top: 0 }
    case 'bl':
      return { ...base, left: 0, bottom: 0 }
    default:
      return { ...base, right: 0, bottom: 0 }
  }
}

/** 单个锁定框（矩形 / 十字 / 锁定） */
function BoxShape({
  box,
  norm,
  contentBox,
}: {
  box: OverlayBox
  norm: NormRect
  contentBox: Rect
}): ReactNode {
  const style = box.style ?? 'rect'
  const color = box.color ?? DEFAULT_BOX_COLOR
  const thickness = box.thickness ?? DEFAULT_BOX_THICKNESS
  if (style === 'crosshair') {
    const cx = norm.x + norm.w / 2
    const cy = norm.y + norm.h / 2
    const size = 12
    return (
      <>
        <div
          style={{
            position: 'absolute',
            left: cx,
            top: cy - size / 2,
            width: thickness,
            height: size,
            background: color,
            transform: 'translateX(-50%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: cx - size / 2,
            top: cy,
            width: size,
            height: thickness,
            background: color,
            transform: 'translateY(-50%)',
          }}
        />
      </>
    )
  }
  const corner = Math.max(6, Math.min(norm.w * contentBox.w, norm.h * contentBox.h) * 0.25)
  return (
    <>
      <div
        data-overlay-box={box.id}
        data-box-style={style}
        style={{
          position: 'absolute',
          left: norm.x,
          top: norm.y,
          width: norm.w,
          height: norm.h,
          border: `${thickness}px ${box.dashed ? 'dashed' : 'solid'} ${color}`,
          boxSizing: 'border-box',
        }}
      />
      {style === 'lock' && (
        <Corner norm={norm} color={color} thickness={thickness} corner={corner} />
      )}
      {box.label && (
        <div
          style={{
            position: 'absolute',
            left: norm.x,
            top: Math.max(0, norm.y - 16),
            color,
            fontSize: 11,
            textShadow: '0 0 3px #000',
          }}
        >
          {box.label}
        </div>
      )}
    </>
  )
}

/** 锁定框四角标记（相对像素框内缩绘制） */
function Corner({
  norm,
  color,
  thickness,
  corner,
}: {
  norm: NormRect
  color: string
  thickness: number
  corner: number
}): ReactNode {
  const marks: Array<{ h: 'left' | 'right'; v: 'top' | 'bottom' }> = [
    { h: 'left', v: 'top' },
    { h: 'right', v: 'top' },
    { h: 'left', v: 'bottom' },
    { h: 'right', v: 'bottom' },
  ]
  return (
    <>
      {marks.map(({ h, v }) => (
        <div key={`${h}-${v}`} style={{ position: 'absolute', left: norm.x, top: norm.y, width: norm.w, height: norm.h }}>
          <div
            style={{
              position: 'absolute',
              [h]: 0,
              [v]: 0,
              width: corner,
              height: thickness,
              background: color,
            }}
          />
          <div
            style={{
              position: 'absolute',
              [h]: 0,
              [v]: 0,
              width: thickness,
              height: corner,
              background: color,
            }}
          />
        </div>
      ))}
    </>
  )
}

/** 叠加层：只渲染**有内容**且**已开启**的项（未注入 MUST 不显示、不留占位） */
export function MediaOverlay(props: MediaOverlayProps): ReactNode {
  const {
    content,
    keys,
    pointerEvents = 'none',
    fit = 'contain',
    className,
    style,
    children,
    box,
    container,
  } = props

  const activeKeys: OverlayKey[] = keys ?? [
    'live',
    'magnification',
    'timestamp',
    'channelName',
    'source',
    'boxes',
  ]

  const contentBox: Rect = useMemo(() => {
    if (box) return box
    const w = container?.w ?? 0
    const h = container?.h ?? 0
    return { x: 0, y: 0, w, h }
  }, [box, container?.w, container?.h])

  const enabled = (k: OverlayKey): boolean => activeKeys.includes(k)

  const liveText =
    content.live === undefined ? null : content.live ? '【实时】' : '【回放】'
  const timestampText =
    content.timestampText ??
    (content.timestampMs !== undefined ? String(content.timestampMs) : null)

  const boxes = (content.boxes ?? [])
    .map((b) => {
      const norm = clampNormRect(b.rect)
      if (!norm) return null
      return { b, norm }
    })
    .filter((v): v is { b: OverlayBox; norm: NormRect } => v !== null)

  return (
    <div
      className={className}
      style={{ ...overlayRootStyle(pointerEvents), ...style }}
      data-media-overlay=""
      data-fit={fit}
    >
      {enabled('live') && liveText && (
        <div className="mp-corner" style={{ ...cornerStyle('tl'), color: content.live ? '#ef4444' : '#e5e7eb' }}>
          {liveText}
        </div>
      )}
      {enabled('magnification') && content.magnification && (
        <div className="mp-corner" style={cornerStyle('tr')}>
          {content.magnification}
        </div>
      )}
      {enabled('channelName') && content.channelName && (
        <div className="mp-corner" style={{ ...cornerStyle('bl'), padding: 4 }}>
          {content.channelName}
        </div>
      )}
      {enabled('source') && content.sourceLabel && (
        <div className="mp-corner" style={cornerStyle('br')}>
          {content.sourceLabel}
        </div>
      )}
      {enabled('timestamp') && timestampText && (
        <div className="mp-corner" style={{ ...cornerStyle('bl'), left: 0, right: 0, textAlign: 'center' }}>
          {timestampText}
        </div>
      )}
      {enabled('boxes') &&
        boxes.map(({ b, norm }) => (
          <BoxShape
            key={b.id}
            box={b}
            norm={normToPx(norm, contentBox)}
            contentBox={contentBox}
          />
        ))}      {content.extra
        ?.filter((e) => !!e.text)
        .map((e) => (
          <div key={e.key} className="mp-corner" style={cornerStyle(e.corner ?? 'tr')}>
            {e.text}
          </div>
        ))}
      {children}
    </div>
  )
}
