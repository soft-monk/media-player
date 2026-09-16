// media-player · 出声仲裁（契约 §7.5）
//
// 纯函数实现 CTR-MDP-AU-05：界面与控制器 MUST 共用同一函数（避免两套口径）。

import type { AudioPolicy, ChannelStatus, MediaChannel } from './types.ts'

/**
 * 出声通道仲裁：`pickAudible(channels, statuses, mainId, policy)`。
 *
 * | policy | 结果 |
 * |---|---|
 * | `'none'` | 恒 `null` |
 * | `'single'` | 主路（可用、未用户静音）优先；主路存在但用户静音 → `null`；无主路 → 候选中的一路 |
 * | `'all'` | 候选中的一路（仅供展示），用户静音意图各自生效 |
 *
 * 候选 = `available && !userMuted && visible && state ∈ {playing, ready}`。
 *
 * **"最近一次 play"的取值口径**：本函数为纯函数，拿不到调用历史，
 * 故按**清单顺序**取第一路候选，并在控制器内保证"最近 play 的通道排在候选首位"
 * （见 `src/core/controller.ts` 的 `lastPlayed` 排序）。控制器与界面共用本函数，
 * 不会出现两套口径。
 */
export function pickAudible(
  channels: MediaChannel[],
  statuses: ChannelStatus[],
  mainId: string | null,
  policy: AudioPolicy,
): string | null {
  if (!Array.isArray(channels) || !Array.isArray(statuses)) return null
  if (policy === 'none') return null

  const statusById = new Map<string, ChannelStatus>()
  for (const s of statuses) statusById.set(s.id, s)

  /** 该路是否具备出声条件 */
  const canSound = (c: MediaChannel): boolean => {
    const s = statusById.get(c.id)
    if (!s || !c.available) return false
    if (s.userMuted) return false
    if (s.state !== 'playing' && s.state !== 'ready') return false
    if (!s.visible) return false
    return true
  }

  if (mainId) {
    const main = channels.find((c) => c.id === mainId)
    // 主路存在但不可出声（用户静音/暂停/不可见）→ null，
    // MUST NOT 自动改让别的路出声（契约 §7.5 第 2 行）
    if (main) return canSound(main) ? main.id : null
  }

  for (const c of channels) {
    if (canSound(c)) return c.id
  }
  return null
}
