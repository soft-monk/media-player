// media-player · MediaTile（契约 §2.1.2）
//
// 关键约束：
// - 通道已知不可用 / 已失败 MUST 渲染**可读原因态**，MUST NOT 空白黑框；
// - 全屏、切主路、隐藏再显示 MUST **复用同一媒体元素实例**（MUST NOT 重建）；
// - 媒体元素事件一律经 `ext(getController())` 实时读取，MUST NOT 闭包捕获旧控制器。

import { useEffect, useRef } from 'react'
import { MediaControls } from './MediaControls.ts'
import { MediaOverlay } from './MediaOverlay.ts'
import { ext } from './internal.ts'
import { countDroppedBoxes } from '../core/geometry.ts'
import { mediaStyle, hiddenStyle, noticeStyle, tileStyle } from './styles.ts'
import type React from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type {
  ChannelStatus,
  MediaChannel,
  MediaController,
  MediaElementHandle,
  OverlayContent,
} from '../core/types.ts'
export interface MediaTileProps {
  channel: MediaChannel
  /** 提供则卡内控制条可驱动播放 */
  controller?: MediaController
  /** 受控状态（不传则由 controller 订阅取得） */
  status?: ChannelStatus
  /** 该路叠加内容（宿主注入，MDP-OVL-02） */
  overlay?: OverlayContent
  /** 缺省 true */
  showControls?: boolean
  onEvent?: import('../core/types').MediaEventListener
  className?: string
  style?: CSSProperties
  /** 主路（放大）标记，由 MediaPlayer 注入 */
  focused?: boolean
}

/** 单通道卡：媒体元素 + 叠加层 + 控制条 */
export function MediaTile(props: MediaTileProps): ReactElement | null {
  const {
    channel,
    controller,
    status: controlledStatus,
    showControls = true,
    className,
    style,
    focused,
  } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const status = controlledStatus ?? controller?.getStatus(channel.id) ?? null
  const view = controller?.getViewState(channel.id) ?? null
  // 帧 URL：由控制器统一解析（模板 / 显式帧 / 解析器三来源同一入口，MDP-PLY-06 不停帧）
  const frameUrl = controller ? currentFrameUrl(controller, channel.id) : null
  /**
   * 媒体元素挂载窗口：由状态机决定，MUST NOT 只在"暂停/未起播"时卸载。
   *
   * 图像流没有 'playing' 事件，卸载 `<img>` 就丢掉了首帧 onload 的上下文，
   * 恢复播放时会停在 loading。控制器用 `canPlay()` 询问视图层是否可播，
   * 因此这里只在 `idle`（未起播）时不挂元素。
   */
  const mounted = status === null || status.state !== 'idle'
  // 元素挂载窗口经 ref 实时读取：`canPlay` MUST NOT 被闭包冻结在首次渲染的取值上
  const mountedRef = useRef(mounted)
  mountedRef.current = mounted

  /* ── 元素登记 + 尺寸回报（画面与叠加层共用同一份 box 的来源） ── */
  useEffect(() => {
    const ctl = controller
    const host = hostRef.current
    const e = ext(ctl)
    if (!ctl || !e || !host) return
    e.setElement(channel.id, host)
    ctl.attachHandle(makeHandle(channel, { videoRef, imgRef }, ctl, mountedRef))
    return () => {
      ctl.detachHandle(channel.id)
      e.setElement(channel.id, null)
    }
  }, [channel.id, channel.kind, channel.url, channel.frames?.length, controller])

  /* ── 容器尺寸变化（ResizeObserver）→ 重算内容框 ── */
  useEffect(() => {
    const ctl = controller
    const host = hostRef.current
    const e = ext(ctl)
    if (!ctl || !e || !host) return
    const measure = (): void => {
      const rect = host.getBoundingClientRect()
      e.reportContainerSize(channel.id, { w: rect.width, h: rect.height })
      const m = measureMedia(channel.kind, videoRef.current, imgRef.current)
      if (m) e.reportMediaSize(channel.id, m)
    }
    measure()
    const RO: typeof ResizeObserver | undefined = (
      globalThis as { ResizeObserver?: typeof ResizeObserver }
    ).ResizeObserver
    if (!RO) return
    const ro = new RO(() => measure())
    ro.observe(host)
    return () => ro.disconnect()
  }, [channel.id, channel.kind, controller])

  /* ── 预加载下一帧（有界：preloadFrames ≤ 2；R3 应对） ── */
  const frameIndex = status?.frameIndex ?? 0
  useEffect(() => {
    const ctl = controller
    if (!ctl || channel.kind !== 'image-seq') return
    const preload = ctl.getPreloadUrls(channel.id)
    const images = preload.map((url) => {
      const im = new Image()
      im.src = url
      return im
    })
    return () => {
      for (const im of images) im.src = ''
    }
  }, [channel.id, channel.kind, controller, frameIndex])

  /* ── 不可用：可读原因态（MUST NOT 空白黑框） ── */
  if (!channel.available) {
    return (
      <div className={className} style={{ ...tileStyle, ...style }} data-media-tile={channel.id}>
        <div style={noticeStyle} data-media-unavailable="">
          <strong>{channel.name}</strong>
          <span>{channel.unavailableReason ?? '通道不可用'}</span>
        </div>
      </div>
    )
  }

  /* ── 单路失败：可读错误态 + 重试（MUST NOT 影响其它路） ── */
  if (status && status.state === 'error') {
    return (
      <div className={className} style={{ ...tileStyle, ...style }} data-media-tile={channel.id}>
        <div style={noticeStyle} data-media-error="">
          <strong>{channel.name}</strong>
          <span>{status.reason ?? '加载失败'}</span>
          <span style={{ opacity: 0.7 }}>
            {status.errorCode !== null ? `错误码 ${status.errorCode}` : '无错误码'}
          </span>
          {controller && (
            <button
              type="button"
              onClick={() => {
                controller.play(channel.id)
              }}
            >
              重试
            </button>
          )}
        </div>
      </div>
    )
  }

  const e = ext(controller)
  const box = e && controller ? e.getContentBox(channel.id) : { x: 0, y: 0, w: 0, h: 0 }
  const fit = controller?.getOptions().overlay.fit ?? 'contain'
  const overlayContent = props.overlay ?? controller?.getOverlay(channel.id) ?? {}

  return (
    <div
      ref={hostRef}
      className={className}
      style={{ ...tileStyle, ...style, ...(focused ? { outline: '1px solid #38bdf8' } : {}) }}
      data-media-tile={channel.id}
      data-state={status?.state ?? 'idle'}
    >
      <FullscreenSync channelId={channel.id} controller={controller} hostRef={hostRef} />
      <DroppedBoxReporter content={overlayContent} controller={controller} channelId={channel.id} />
      {channel.kind === 'video' ? (
        <video
          ref={videoRef}
          src={channel.url ?? undefined}
          poster={channel.poster ?? undefined}
          playsInline
          preload="metadata"
          style={{ ...mediaStyle(fit), ...(mounted ? null : hiddenStyle) }}
          onLoadedMetadata={onVideoMeta(controller, channel.id)}
          onLoadedData={onVideoMeta(controller, channel.id)}
          onPlaying={() => ext(controller)?.reportMediaEvent(channel.id, 'playing')}
          onPlay={() => ext(controller)?.reportMediaEvent(channel.id, 'play')}
          onPause={() => ext(controller)?.reportMediaEvent(channel.id, 'pause')}
          onWaiting={() => ext(controller)?.reportMediaEvent(channel.id, 'waiting')}
          onTimeUpdate={(ev) => {
            const el = ev.currentTarget
            const buffered = el.buffered.length > 0 ? el.buffered.end(el.buffered.length - 1) : 0
            ext(controller)?.reportMediaEvent(channel.id, 'timeupdate', {
              positionMs: el.currentTime * 1000,
              bufferedMs: buffered * 1000,
            })
          }}
          onSeeked={(ev) =>
            ext(controller)?.reportMediaEvent(channel.id, 'seeked', {
              positionMs: ev.currentTarget.currentTime * 1000,
            })
          }
          onEnded={() => ext(controller)?.reportMediaEvent(channel.id, 'ended')}
          onError={(ev) => {
            const code = ev.currentTarget.error?.code
            // MEDIA_ERR_DECODE(3) / MEDIA_ERR_SRC_NOT_SUPPORTED(4) → 解码不支持；其余按不可达
            const errorCode = code === 3 || code === 4 ? 3002 : 3001
            ext(controller)?.reportMediaEvent(channel.id, 'error', {
              errorCode,
              reason: ev.currentTarget.error?.message || `媒体错误（code=${code ?? '?'}）`,
            })
          }}
        />
      ) : (
        <img
          ref={imgRef}
          src={frameUrl ?? undefined}
          alt={channel.name}
          style={{ ...mediaStyle(fit), ...(mounted ? null : hiddenStyle) }}
          onLoad={(ev) => {
            const el = ev.currentTarget
            ext(controller)?.reportMediaSize(channel.id, {
              w: el.naturalWidth,
              h: el.naturalHeight,
            })
            ext(controller)?.reportImageEvent(channel.id, status?.frameIndex ?? 0, true, el.src)
          }}
          onError={(ev) =>
            ext(controller)?.reportImageEvent(
              channel.id,
              status?.frameIndex ?? 0,
              false,
              ev.currentTarget.src,
            )
          }
        />
      )}

      <MediaOverlay
        content={{
          ...overlayContent,
          channelName: overlayContent.channelName ?? channel.name,
          sourceLabel: overlayContent.sourceLabel ?? channel.sourceLabel ?? undefined,
        }}
        keys={channel.overlayKeys}
        pointerEvents={controller?.getOptions().overlay.pointerEvents ?? 'none'}
        fit={fit}
        box={box}
        container={view?.container ?? null}
      />

      {showControls && controller && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3 }}>
          <MediaControls channelId={channel.id} controller={controller} />
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 两处"渲染期副作用"的隔离：都放进独立子组件，保证 MediaTile 的 Hook 顺序恒定
 * ------------------------------------------------------------------ */

/**
 * 原生全屏态 → 控制器（契约 §8.3 `fullscreenchange` 重算）。
 *
 * 不监听的话：宿主/用户按 ESC 退出时控制器仍以为在全屏，叠加层基准会漂移（MDP-OVL-04）。
 */
function FullscreenSync(props: {
  channelId: string
  controller?: MediaController
  hostRef: { current: HTMLDivElement | null }
}): null {
  const { channelId, controller, hostRef } = props
  useEffect(() => {
    const ctl = controller
    const e = ext(ctl)
    if (!ctl || !e) return
    const doc: Document | undefined = (globalThis as { document?: Document }).document
    if (!doc || typeof doc.addEventListener !== 'function') return
    let exited = false
    const sync = (): void => {
      const el = doc.fullscreenElement ?? null
      const host = hostRef.current
      const mine = !!el && !!host && (el === host || host.contains(el))
      e.reportFullscreenElement(channelId, mine)
      if (!mine && !exited && ctl.getFullscreen() === channelId) {
        exited = true
        void ctl.exitFullscreen()
      }
    }
    sync()
    doc.addEventListener('fullscreenchange', sync)
    return () => doc.removeEventListener('fullscreenchange', sync)
  }, [channelId, controller, hostRef])
  return null
}

/** 越界/非法框 → 叠加层诊断计数（契约 §8.4「计入叠加层诊断计数」） */
function DroppedBoxReporter(props: {
  content: OverlayContent
  controller?: MediaController
  channelId: string
}): null {
  const { content, controller, channelId } = props
  const dropped = countDroppedBoxes(content)
  useEffect(() => {
    if (dropped > 0) ext(controller)?.reportDroppedBoxes(dropped)
  }, [dropped, controller, channelId])
  return null
}

/* ------------------------------------------------------------------ *
 * 内部工具
 * ------------------------------------------------------------------ */

/** 首帧/元数据到达 → 上报实际分辨率与时长（MDP-DGR-04） */
function onVideoMeta(
  controller: MediaController | undefined,
  id: string,
): (ev: React.SyntheticEvent<HTMLVideoElement>) => void {
  return (ev) => {
    const el = ev.currentTarget
    const e = ext(controller)
    if (!e) return
    e.reportMediaSize(id, { w: el.videoWidth, h: el.videoHeight })
    e.reportMediaEvent(id, 'loadeddata', {
      w: el.videoWidth,
      h: el.videoHeight,
      durationMs: Number.isFinite(el.duration) ? el.duration * 1000 : null,
    })
  }
}

/** 媒体元素实际分辨率（video: videoWidth；img: naturalWidth） */
function measureMedia(
  kind: MediaChannel['kind'],
  video: HTMLVideoElement | null,
  img: HTMLImageElement | null,
): { w: number; h: number } | null {
  if (kind === 'video') {
    if (!video || !video.videoWidth || !video.videoHeight) return null
    return { w: video.videoWidth, h: video.videoHeight }
  }
  if (!img || !img.naturalWidth || !img.naturalHeight) return null
  return { w: img.naturalWidth, h: img.naturalHeight }
}

/** 把控制器命令落到真实媒体元素（界面与接口同一路径，MDP-PLY-01） */
function makeHandle(
  channel: MediaChannel,
  refs: {
    videoRef: { current: HTMLVideoElement | null }
    imgRef: { current: HTMLImageElement | null }
  },
  controller: MediaController,
  mountedRef: { current: boolean },
): MediaElementHandle {
  const video = (): HTMLVideoElement | null => refs.videoRef.current
  const img = (): HTMLImageElement | null => refs.imgRef.current
  const report = ext(controller)
  return {
    id: channel.id,
    kind: channel.kind,
    /**
     * 播放许可：媒体元素已挂载且能起播。
     *
     * video：`readyState` 已达元数据即可（`play()` 会自行缓冲，并被 `playing` 事件确认）。
     * image-seq：本模块的"播放"是**按间隔换帧**，不需要浏览器解码 —— 只要有元素且帧可解析
     * 即视为可播（它没有 'playing' 事件，等不到事件就必须由这里给出结论）。
     */
    canPlay: () => {
      if (channel.kind === 'image-seq') return mountedRef.current
      const el = video()
      return !!el && el.readyState >= 1
    },
    play: () => {
      const el = video()
      if (!el) return
      try {
        const p = el.play()
        if (p && typeof p.catch === 'function') {
          p.catch((err: unknown) => {
            // 自动播放被浏览器拒绝 → 降级（MUST NOT 循环重试，契约 §7.3）
            report?.reportMediaCommandError(
              channel.id,
              'play',
              err instanceof Error ? err.message : '浏览器拒绝自动播放',
            )
          })
        }
      } catch (err) {
        report?.reportMediaCommandError(
          channel.id,
          'play',
          err instanceof Error ? err.message : '播放被拒绝',
        )
      }
    },
    pause: () => video()?.pause(),
    stop: () => {
      const el = video()
      if (!el) return
      el.pause()
      try {
        el.currentTime = 0
      } catch {
        /* 元数据未就绪时忽略 */
      }
    },
    seek: (ms) => {
      const el = video()
      if (!el) return
      try {
        el.currentTime = ms / 1000
      } catch {
        /* 越界忽略 */
      }
    },
    setVolume: (v) => {
      const el = video()
      if (el) el.volume = Math.min(1, Math.max(0, v))
    },
    setMuted: (m) => {
      const el = video()
      if (el) el.muted = m
    },
    setRate: (r) => {
      const el = video()
      if (el) el.playbackRate = r
    },
    setLoop: (l) => {
      const el = video()
      if (el) el.loop = l
    },
    setFrame: (_index, url) => {
      const el = img()
      if (el && url && el.src !== url) el.src = url
    },
  }
}

/** 当前帧 URL：与控制器共用**同一个**解析入口（模板/显式帧/解析器三种来源都不丢帧） */
function currentFrameUrl(controller: MediaController, id: string): string | null {
  return controller.getFrameUrl(id)
}
