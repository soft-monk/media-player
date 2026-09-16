// media-player · MediaControls（契约 §2.1.4）
//
// 每个控件动作 MUST 走 `controller` 对应方法（界面与接口同一路径，MDP-PLY-01）；
// 全屏按钮 MUST 走 enterFullscreen/exitFullscreen（MUST NOT 自行调 DOM API，MDP-PLY-05）。

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { ChannelStatus, MediaController } from '../core/types.ts'

export type MediaControlsKey =
  | 'play'
  | 'stop'
  | 'seek'
  | 'volume'
  | 'mute'
  | 'rate'
  | 'step'
  | 'loop'
  | 'frame'
  | 'fullscreen'
  | 'main'
  | 'state'

export interface MediaControlsProps {
  channelId: string
  controller: MediaController
  /** 缺省：除 'step' 外全部（'step' 仅 video 通道默认开启） */
  keys?: MediaControlsKey[]
  compact?: boolean
  className?: string
  style?: CSSProperties
}

const DEFAULT_KEYS: MediaControlsKey[] = [
  'play',
  'stop',
  'seek',
  'volume',
  'mute',
  'rate',
  'loop',
  'frame',
  'fullscreen',
  'main',
  'state',
]

/** 控制条：所有动作经 `controller`，界面不直接操作媒体元素 */
export function MediaControls(props: MediaControlsProps): ReactNode {
  const { channelId, controller, compact = false, className, style } = props
  const [, force] = useState(0)
  const rerender = (): void => force((n) => n + 1)

  const status: ChannelStatus | null = controller.getStatus(channelId)
  const channel = controller.getChannel(channelId)
  if (!status || !channel) return null

  const keys = new Set<MediaControlsKey>(
    props.keys ?? [...DEFAULT_KEYS, ...(channel.kind === 'video' ? (['step'] as MediaControlsKey[]) : [])],
  )
  const playing = status.state === 'playing'
  const isMain = controller.getMain() === channelId
  const isFull = controller.getFullscreen() === channelId
  const rateIndex = controller.getOptions().rateOptions.indexOf(status.rate)

  const act = (fn: () => void): (() => void) => () => {
    fn()
    rerender()
  }

  return (
    <div className={className} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', ...style }}>
      {keys.has('play') && (
        <button type="button" onClick={act(() => void controller.toggle(channelId))} title="播放/暂停">
          {playing ? '暂停' : '播放'}
        </button>
      )}
      {keys.has('stop') && (
        <button type="button" onClick={act(() => void controller.stop(channelId))} title="停止">
          停止
        </button>
      )}
      {keys.has('seek') && channel.kind === 'video' && (
        <input
          type="range"
          min={0}
          max={Math.max(1, status.durationMs ?? 0)}
          step={100}
          value={Math.min(status.positionMs, status.durationMs ?? status.positionMs)}
          disabled={status.durationMs === null}
          onChange={(e) => {
            controller.seek(channelId, Number(e.target.value))
            rerender()
          }}
          title={status.degraded.range ? status.degraded.hint ?? '当前源不支持 Range' : '进度'}
          style={{ flex: '1 1 80px', minWidth: 60 }}
        />
      )}
      {keys.has('frame') && channel.kind === 'image-seq' && (
        <span title="帧序号">
          帧 {status.frameIndex + 1}/{Math.max(1, status.frameCount)}
        </span>
      )}
      {keys.has('volume') && (
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(status.volume * 100)}
          onChange={(e) => {
            controller.setVolume(channelId, Number(e.target.value) / 100)
            rerender()
          }}
          title={`音量 ${Math.round(status.volume * 100)}%`}
          style={{ flex: '0 1 70px', minWidth: 48 }}
        />
      )}
      {keys.has('mute') && (
        <button
          type="button"
          onClick={act(() => void controller.mute(channelId, !status.userMuted))}
          title={status.mutedByPolicy ? '被出声策略静音（多路同屏至多一路出声）' : '静音切换'}
        >
          {status.userMuted ? '取消静音' : '静音'}
          {status.mutedByPolicy ? '（策略）' : ''}
        </button>
      )}
      {keys.has('rate') && (
        <select
          value={status.rate}
          onChange={(e) => {
            controller.setRate(channelId, Number(e.target.value))
            rerender()
          }}
          title="倍速"
        >
          {controller.getOptions().rateOptions.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
      )}
      {keys.has('step') && channel.kind === 'video' && (
        <>
          <button type="button" onClick={act(() => void controller.stepFrame(channelId, -1))} title="后退一帧">
            ◀|
          </button>
          <button type="button" onClick={act(() => void controller.stepFrame(channelId, 1))} title="前进一帧">
            |▶
          </button>
        </>
      )}
      {keys.has('loop') && (
        <button type="button" onClick={act(() => void controller.setLoop(channelId, !status.loop))} title="循环">
          {status.loop ? '循环开' : '循环关'}
        </button>
      )}
      {keys.has('main') && (
        <button
          type="button"
          onClick={act(() => void controller.setMain(isMain ? null : channelId))}
          title="指定/取消主路（声音跟随）"
        >
          {isMain ? '取消主路' : '设为主路'}
        </button>
      )}
      {keys.has('fullscreen') && (
        <button
          type="button"
          onClick={act(() => {
            if (isFull) void controller.exitFullscreen()
            else void controller.enterFullscreen(channelId)
          })}
          title="全屏"
        >
          {isFull ? '退出全屏' : '全屏'}
        </button>
      )}
      {keys.has('state') && !compact && (
        <span data-state={status.state} title={status.reason ?? ''}>
          {status.state}
          {status.errorCode !== null ? `(${status.errorCode})` : ''}
        </span>
      )}
      {status.degraded.range && !compact && (
        <span className="mp-hint" title={status.degraded.hint ?? ''}>
          Range 降级
        </span>
      )}
      {rateIndex < 0 && !compact && <span className="mp-hint">倍速非法</span>}
      {status.mutedByPolicy && !compact && <span className="mp-hint">策略静音</span>}
    </div>
  )
}
