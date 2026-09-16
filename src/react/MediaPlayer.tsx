// media-player · MediaPlayer（契约 §2.1.1）—— 面板唯一入口组件
//
// 空清单 MUST 返回 null（不渲染任何容器/占位/黑框），并回调 onEmpty（MDP-DGR-02）。
// 组件 MUST NOT 提供 renderEmpty 之类接口（防止被用来渲染空面板）。

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { MediaTile } from './MediaTile.ts'
import { ext } from './internal.ts'
import { panelStyle } from './styles.ts'
import { createMediaController, resolveColumns } from '../core/controller.ts'
import type { CSSProperties, ReactElement, ReactNode, Ref } from 'react'
import type {
  ChannelStatus,
  EmptyReason,
  IChannelSource,
  LayoutMode,
  MediaChannel,
  MediaController,
  MediaEventListener,
  MediaPlayerAdapters,
  MediaPlayerHandle,
  MediaPlayerOptions,
  OverlaysConfig,
} from '../core/types.ts'

export interface MediaPlayerProps {
  /** 直投清单纯数据；与 source 二选一 */
  channels?: unknown
  /** 清单来源（MDP-CHN-02/03）；仅用于首次与 refreshChannels */
  source?: IChannelSource
  /** 注入既有控制器（受控模式）；不传则组件内部自建 */
  controller?: MediaController
  options?: Partial<MediaPlayerOptions>
  adapters?: MediaPlayerAdapters
  overlays?: OverlaysConfig
  /** 主路（MDP-MUL-04）；缺省 null */
  mainChannelId?: string | null
  /** 缺省 options.layout（默认 'grid'） */
  layout?: LayoutMode
  /** 缺省 'auto' */
  columns?: number | 'auto'
  onEvent?: MediaEventListener
  onChannelState?: (status: ChannelStatus) => void
  onEmpty?: (
    reason: EmptyReason,
    detail: { total: number; usable: number; message: string },
  ) => void
  renderTile?: (ctx: { channel: MediaChannel; status: ChannelStatus }) => ReactNode
  className?: string
  style?: CSSProperties
}

/** 面板：网格 / 主路聚焦；空清单隐藏入口 */
export const MediaPlayer = forwardRef(function MediaPlayer(
  props: MediaPlayerProps,
  ref: Ref<MediaPlayerHandle>,
): ReactElement | null {
  const {
    channels,
    source,
    controller: injected,
    options,
    adapters,
    overlays,
    mainChannelId = null,
    layout,
    columns,
    className,
    style,
    renderTile,
  } = props

  // 控制器引用 MUST 稳定（不因 props 变化重建）
  const ownRef = useRef<MediaController | null>(null)
  if (ownRef.current === null) {
    ownRef.current = createMediaController({
      channels: 'channels' in props ? channels : undefined,
      options,
      adapters: source ? { ...adapters, source: adapters?.source ?? source } : adapters,
    })
  }
  const controller: MediaController = injected ?? ownRef.current

  const [version, setVersion] = useState(0)
  const [emptyInfo, setEmptyInfo] = useState<{ reason: EmptyReason; message: string } | null>(null)

  // 回调与最新 props 放 ref：订阅只建一次，避免闭包捕获旧值
  const latest = useRef({ props, controller })
  latest.current = { props, controller }

  useEffect(() => {
    const ctl = controller
    const e = ext(ctl)
    if (!e) return
    let queued = false
    const bump = (): void => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        setVersion((n) => n + 1)
      })
    }
    const unsubscribe = ctl.subscribe(() => bump())
    e.setCallbacks({
      onEvent: (ev) => {
        const at = latest.current
        at.props.onEvent?.(ev)
      },
      onChannelState: (s) => {
        const at = latest.current
        at.props.onChannelState?.(s)
      },
    })
    e.setEmptyCallback((reason, detail) => {
      setEmptyInfo({ reason, message: detail.message })
      latest.current.props.onEmpty?.(reason, detail)
    })
    return () => {
      unsubscribe()
      e.setCallbacks({})
      e.setEmptyCallback(undefined)
    }
  }, [controller])

  // 清单直投：深层比较避免无脑重装（保持播放位置与元素复用）
  const channelsKey = useMemo(() => safeKey(channels), [channels])
  useEffect(() => {
    if (!('channels' in props)) return
    controller.setChannels(channels)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelsKey, controller])

  // 适配器与配置热更新
  const adaptersKey = useMemo(() => safeKey(adapters), [adapters])
  useEffect(() => {
    if (adapters) controller.setAdapters({ ...adapters, ...(source ? { source } : {}) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adaptersKey, source, controller])

  useEffect(() => {
    if (options) controller.setOptions(options)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeKey(options), controller])

  useEffect(() => {
    controller.setMain(mainChannelId)
  }, [mainChannelId, controller])

  useEffect(() => {
    if (layout) controller.setLayout(layout)
  }, [layout, controller])

  const overlaysKey = useMemo(() => safeKey(overlays), [overlays])
  useEffect(() => {
    if (!overlays) return
    const current = controller.getOptions().overlay
    if (overlays.keys || overlays.pointerEvents || overlays.fit) {
      controller.setOptions({
        overlay: {
          keys: overlays.keys ?? current.keys,
          pointerEvents: overlays.pointerEvents ?? current.pointerEvents,
          fit: overlays.fit ?? current.fit,
        },
      })
    }
    for (const [id, content] of Object.entries(overlays.byChannel ?? {})) {
      controller.setOverlay(id, content)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlaysKey, controller])

  useImperativeHandle(ref, () => controller, [controller])

  void version // 订阅事件驱动的重渲染

  const list = controller.getChannels()
  const statuses = controller.getAllStatus()
  const usable = list.filter((c) => c.available)
  const visible = list.filter((c) => {
    const s = statuses.find((x) => x.id === c.id)
    return c.available && (s?.visible ?? true)
  })

  // 空清单：隐藏入口（MUST NOT 渲染空面板/黑框）
  if (usable.length === 0 || visible.length === 0) return null

  const cols: number =
    columns === undefined || columns === 'auto'
      ? resolveColumns(controller.getOptions(), visible.length)
      : Math.max(1, Math.floor(columns))
  const mode: LayoutMode = layout ?? controller.getLayout()
  const statusOf = (id: string): ChannelStatus | null => statuses.find((s) => s.id === id) ?? null
  const mainId = controller.getMain()

  const ordered =
    mode === 'focus' && mainId
      ? [...visible].sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0))
      : visible

  return (
    <div
      className={className}
      style={{
        ...panelStyle,
        ...style,
        gridTemplateColumns:
          mode === 'focus' && mainId ? '1fr' : `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`,
        gridAutoRows: mode === 'focus' && mainId ? '1fr' : 'minmax(0, 1fr)',
      }}
      data-media-player=""
      data-empty={emptyInfo ? '1' : '0'}
      data-layout={mode}
    >
      {ordered.map((channel) => {
        const status = statusOf(channel.id)
        if (!status) return null
        if (renderTile) {
          return <div key={channel.id}>{renderTile({ channel, status })}</div>
        }
        return (
          <MediaTile
            key={channel.id}
            channel={channel}
            controller={controller}
            status={status}
            overlay={overlays?.byChannel?.[channel.id]}
            focused={mode === 'focus' && channel.id === mainId}
          />
        )
      })}
    </div>
  )
})

/** 稳定的深层键：用于判断清单/叠加配置是否真的变了 */
function safeKey(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return String(Math.random())
  }
}
