// media-player · 零依赖单元自测（node 直接跑，不引测试框架）
//
//   node tests/unit-test.mjs
//
// 为什么能直接跑 TS：只 import **核心层**（src/core/**，MUST NOT import react），
// 由 Node 原生的类型剥离（Node ≥ 22.6 的 --experimental-strip-types，24 起默认开启）执行。
// 这也正是契约 §11.3-① 的"分层落实"：机制层可脱离框架单测，框架只在视图层。

import { MEDIA_ERROR } from '../src/core/errors.ts'
import {
  CHANNEL_STATES,
  DEFAULT_OPTIONS,
  EMPTY_REASONS,
  MAX_DECODE_RETRY,
  MEDIA_EVENTS,
  MEDIA_SCHEMA_VERSION,
  OVERLAY_KEYS,
  SUPPORTED_SCHEMA_MAJOR,
  autoColumns,
} from '../src/core/constants.ts'
import { expandFrames, expandTemplate, hasFramePlaceholder, resolveFrameUrl } from '../src/core/frames.ts'
import {
  clampNormRect,
  countDroppedBoxes,
  isRectInUnit,
  mediaContentBox,
  normToPx,
  pxToNorm,
} from '../src/core/geometry.ts'
import { normalizeChannels, normalizeKind, normalizeOverlayKeys } from '../src/core/normalize.ts'
import { isSameOriginOrRelative } from '../src/core/adapters.ts'
import { pickAudible } from '../src/core/audio.ts'
import { buildSummary } from '../src/core/status.ts'
import { MediaEmitter, isValidEventName } from '../src/core/emitter.ts'
import { MediaControllerImpl, createMediaController } from '../src/core/controller.ts'

/* ================================================================== *
 * 断言器
 * ================================================================== */

let cases = 0
let asserts = 0
let failed = 0
const failures = []

function check(name, cond, detail = '') {
  asserts++
  if (!cond) {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
  return !!cond
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  return check(name, a === b, `期望 ${b}，实际 ${a}`)
}

function near(name, actual, expected, tol = 1e-6) {
  return check(name, Math.abs(actual - expected) <= tol, `期望 ≈${expected}，实际 ${actual}`)
}

function testCase(title, fn) {
  cases++
  try {
    fn()
  } catch (e) {
    failed++
    failures.push(`${title} → 抛出异常：${e && e.message ? e.message : e}`)
  }
}

/** 假时钟：注入后时序完全可复现（契约 §3.2 MUST） */
function makeClock(start = 1_700_000_000_000) {
  let now = start
  return {
    clock: { nowMs: () => now },
    advance: (ms) => {
      now += ms
      return now
    },
    set: (v) => {
      now = v
    },
  }
}

/**
 * 假计时器：手动推进，用于图像流轮播与不可见延迟暂停的可复现测试。
 * 计时器的"现在"接在注入时钟上（控制器的时间语义一律来自 IClock），
 * 因此 advance() 同时推进两者，节流/轮播/延迟暂停的时序才可复现。
 */
function makeTimer(clockRef) {
  let seq = 1
  const pending = new Map()
  return {
    timer: {
      set: (fn, ms) => {
        const id = seq++
        pending.set(id, { at: clockRef.clock.nowMs() + Math.max(0, ms), fn })
        return id
      },
      clear: (id) => pending.delete(id),
    },
    advance: (ms) => {
      clockRef.advance(ms)
      const now = clockRef.clock.nowMs()
      const due = [...pending.entries()].filter(([, v]) => v.at <= now).sort((a, b) => a[1].at - b[1].at)
      for (const [id, v] of due) {
        pending.delete(id)
        v.fn()
      }
      return due.length
    },
    pendingCount: () => pending.size,
  }
}

const VIDEO = (id, extra = {}) => ({ id, name: id, kind: 'video', url: `/media/${id}.mp4`, ...extra })

/* ================================================================== *
 * 1. 常量与缺省值（契约 §2.6）
 * ================================================================== */

testCase('常量表逐字实现', () => {
  eq('MEDIA_SCHEMA_VERSION', MEDIA_SCHEMA_VERSION, '1.0.0')
  eq('SUPPORTED_SCHEMA_MAJOR', SUPPORTED_SCHEMA_MAJOR, 1)
  eq('CHANNEL_STATES 顺序冻结', CHANNEL_STATES, ['idle', 'loading', 'ready', 'playing', 'paused', 'error'])
  eq('OVERLAY_KEYS 顺序冻结', OVERLAY_KEYS, ['live', 'magnification', 'timestamp', 'channelName', 'source', 'boxes'])
  eq('EMPTY_REASONS', EMPTY_REASONS, ['no-source', 'no-channels', 'all-unavailable', 'source-error', 'schema-mismatch'])
  eq('MEDIA_EVENTS', MEDIA_EVENTS, {
    state: 'media.state',
    error: 'media.error',
    empty: 'media.empty',
    degraded: 'media.degraded',
    frame: 'media.frame',
  })
  eq('DEFAULT_OPTIONS.maxChannels', DEFAULT_OPTIONS.maxChannels, 6)
  eq('DEFAULT_OPTIONS.maxChannelsByKind', DEFAULT_OPTIONS.maxChannelsByKind, { video: 6, 'image-seq': 6 })
  eq('DEFAULT_OPTIONS.audioPolicy', DEFAULT_OPTIONS.audioPolicy, 'single')
  eq('DEFAULT_OPTIONS.columns', DEFAULT_OPTIONS.columns, 'auto')
  eq('DEFAULT_OPTIONS.defaultVolume', DEFAULT_OPTIONS.defaultVolume, 0.8)
  eq('DEFAULT_OPTIONS.minFrameIntervalMs', DEFAULT_OPTIONS.minFrameIntervalMs, 100)
  eq('DEFAULT_OPTIONS.throttleMs', DEFAULT_OPTIONS.throttleMs, 100)
  eq('DEFAULT_OPTIONS.preloadFrames', DEFAULT_OPTIONS.preloadFrames, 1)
  eq('DEFAULT_OPTIONS.rateOptions', DEFAULT_OPTIONS.rateOptions, [0.5, 1, 2])
  eq('DEFAULT_OPTIONS.bufferLimitFrames', DEFAULT_OPTIONS.bufferLimitFrames, 24)
  eq('DEFAULT_OPTIONS.frameEvents', DEFAULT_OPTIONS.frameEvents, false)
  eq('DEFAULT_OPTIONS.overlay.pointerEvents', DEFAULT_OPTIONS.overlay.pointerEvents, 'none')
  eq('DEFAULT_OPTIONS.overlay.fit', DEFAULT_OPTIONS.overlay.fit, 'contain')
  eq('MEDIA_ERROR 私有码不重叠冻结码', [MEDIA_ERROR.SOURCE_UNREACHABLE, MEDIA_ERROR.DECODE_UNSUPPORTED, MEDIA_ERROR.FRAMES_UNAVAILABLE, MEDIA_ERROR.LIMIT_REJECTED, MEDIA_ERROR.CAPABILITY_MISSING], [3001, 3002, 3003, 3004, 3005])
  eq('MEDIA_ERROR 不含 1001/2001/2002', [MEDIA_ERROR.BAD_PARAM, MEDIA_ERROR.CONFLICT, MEDIA_ERROR.PRECONDITION, MEDIA_ERROR.NOT_FOUND, MEDIA_ERROR.INTERNAL, MEDIA_ERROR.SCHEMA_MISMATCH], [1000, 1002, 1003, 1004, 1005, 1006])
})

testCase('columns:auto 列数规则（契约 §2.6）', () => {
  eq('1 路 → 1 列', autoColumns(1), 1)
  eq('2 路 → 2 列', autoColumns(2), 2)
  eq('3 路 → 2 列', autoColumns(3), 2)
  eq('4 路 → 2 列', autoColumns(4), 2)
  eq('5 路 → 3 列', autoColumns(5), 3)
  eq('6 路 → 3 列', autoColumns(6), 3)
  eq('9 路 → 3 列', autoColumns(9), 3)
  eq('10 路 → 4 列', autoColumns(10), 4)
})

testCase('事件名匹配命名规范且不占保留命名空间（CTR-EV-01/02）', () => {
  const names = Object.values(MEDIA_EVENTS)
  check('全部匹配 ^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)+$', names.every((n) => isValidEventName(n)), names.join(','))
  check('不占 sys./up.', names.every((n) => !n.startsWith('sys.') && !n.startsWith('up.')))
  check(
    '非法事件名被拒（大小写/缺 subject/保留命名空间）',
    !isValidEventName('Media.State') && !isValidEventName('media') && !isValidEventName('Media.state'),
  )
  check('保留命名空间可识别', isValidEventName('sys.x') && MEDIA_EVENTS.state.startsWith('media.'))
})

/* ================================================================== *
 * 2. 清单归一化（MDP-CHN-01/03、CTR-MDP-MDP-EC-06）
 * ================================================================== */

testCase('入参非法时 normalizeChannels 不抛异常且逐条给原因（§11.2-6）', () => {
  const inputs = [
    ['非对象非数组', 42],
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'channels'],
    ['对象但 channels 非数组', { channels: 'x' }],
    ['数组里混入非对象', [VIDEO('a'), 7, null, 'x', VIDEO('b')]],
    ['缺 url 的 video', [{ id: 'v', kind: 'video' }]],
    ['未知 kind', [{ id: 'u', kind: 'rtsp', url: '/media/u.mp4' }]],
    ['空 frames 且无 url', [{ id: 'f', kind: 'image-seq', frames: [] }]],
    ['schema MAJOR 不符', { schemaVersion: '9.0.0', channels: [VIDEO('a')] }],
    ['schemaVersion 非语义化', { schemaVersion: 'v1', channels: [VIDEO('a')] }],
    ['三字段全缺', [{ meta: {} }]],
  ]
  for (const [label, input] of inputs) {
    let r
    try {
      r = normalizeChannels(input)
    } catch (e) {
      check(`normalizeChannels(${label}) 不抛异常`, false, String(e))
      continue
    }
    check(`normalizeChannels(${label}) 返回信封`, typeof r.ok === 'boolean' && typeof r.code === 'number')
    check(`normalizeChannels(${label}) 有 channels 数组`, Array.isArray(r.channels))
    if (!r.ok) check(`normalizeChannels(${label}) 失败带可读消息`, typeof r.message === 'string' && r.message.length > 0)
    if (r.data && r.data.rejected.length > 0) {
      check(`normalizeChannels(${label}) 拒绝项带原因`, r.data.rejected.every((x) => typeof x.reason === 'string' && x.reason.length > 0))
    }
  }
})

testCase('既有接口 [{name,url}] 原样可消费（§11.2-7、MDP-CHN-03）', () => {
  const r = normalizeChannels([
    { name: '通道 1', url: '/media/a.mp4' },
    { name: '通道 2', url: '/media/b.mp4' },
  ])
  check('整包成功', r.ok && r.code === 0)
  eq('数量', r.channels.length, 2)
  check('全部归一为 video', r.channels.every((c) => c.kind === 'video'))
  check('全部可用', r.channels.every((c) => c.available))
  eq('id 由 name 派生', r.channels.map((c) => c.id), ['通道 1', '通道 2'])
  eq('usable', r.data.usable, 2)
  eq('schemaVersion 缺省为 null', r.data.schemaVersion, null)
})

testCase('三种兼容输入形状（契约 §6.5）', () => {
  const legacy = normalizeChannels([{ name: 'a', url: '/media/a.mp4' }])
  const full = normalizeChannels([VIDEO('a')])
  const envelope = normalizeChannels({ schemaVersion: '1.2.3', channels: [VIDEO('a')] })
  eq('① 既有接口形状', legacy.channels.length, 1)
  eq('② 完整条目形状', full.channels.map((c) => c.id), ['a'])
  eq('③ 信封形状', envelope.channels.map((c) => c.id), ['a'])
  eq('③ 记录 schemaVersion', envelope.data.schemaVersion, '1.2.3')
  check('MINOR/PATCH 更高仍可装载', envelope.ok)
})

testCase('schema MAJOR 不符 → 拒绝装载 + 1006（契约 §6.6）', () => {
  const r = normalizeChannels({ schemaVersion: '2.0.0', channels: [VIDEO('a')] })
  check('不成功', !r.ok)
  eq('code = 1006', r.code, 1006)
  eq('无通道装载', r.channels.length, 0)
  check('消息含期望/实际 MAJOR', r.message.includes('2') && r.message.includes('1'))
  const bad = normalizeChannels({ schemaVersion: 'x.y', channels: [VIDEO('a')] })
  eq('非语义化版本 → 1000', bad.code, 1000)
})

testCase('kind 归一化别名表（契约 §6.2）', () => {
  eq('video', normalizeKind('video'), 'video')
  eq('mp4', normalizeKind('mp4'), 'video')
  eq('image-seq', normalizeKind('image-seq'), 'image-seq')
  eq('imageSeq', normalizeKind('imageSeq'), 'image-seq')
  eq('缺省取 defaultKind', normalizeKind(undefined, 'image-seq'), 'image-seq')
  eq('未知 → null（不猜测）', normalizeKind('rtsp'), null)
  const unknown = normalizeChannels([{ id: 'u', kind: 'rtsp', url: '/media/u.mp4' }])
  check('未知 kind 判不可用', !unknown.channels[0].available)
  check('原因含 unknown-kind', String(unknown.channels[0].unavailableReason).includes('unknown-kind'))
  check('未知 kind 不报错（前向兼容）', unknown.ok)
})

testCase('条目级缺省与矛盾输入（契约 §7.2）', () => {
  const r = normalizeChannels([
    { id: 'a', url: '/media/a.mp4' },
    { id: 'b', kind: 'image-seq', url: '/media/{i}.png', frameCount: 3 },
    { id: 'c', kind: 'image-seq', url: '/media/c.png', frameCount: 4 },
    { id: 'd', kind: 'image-seq', frames: ['/1.png', '/2.png'], frameCount: 5 },
    { id: 'e', kind: 'image-seq', frames: ['/1.png', '/2.png'], frameCount: 2 },
    { id: 'g', kind: 'video', url: '/media/g.mp4', available: false, unavailableReason: '宿主声明不可用' },
    { id: 'h', kind: 'video', url: '/media/h.mp4', frameIntervalMs: 10 },
  ])
  const by = Object.fromEntries(r.channels.map((c) => [c.id, c]))
  check('缺 kind → video 可用', by.a.kind === 'video' && by.a.available)
  check('模板 + frameCount → 可用', by.b.available && by.b.frameCount === 3)
  check('无占位符 + frameCount>1 → 不可用（no-frames/3003）', !by.c.available && by.c.unavailableReason === 'no-frames')
  check('frames 长度与 frameCount 不符 → 不可用', !by.d.available && by.d.unavailableReason === 'frames-length-mismatch')
  check('frames 长度一致 → 可用且 frameCount=frames.length', by.e.available && by.e.frameCount === 2)
  check('available:false 保留可读原因', !by.g.available && by.g.unavailableReason === '宿主声明不可用')
  check('frameIntervalMs 夹紧到 minFrameIntervalMs', by.h.frameIntervalMs === DEFAULT_OPTIONS.minFrameIntervalMs)
  eq('video 的 frames 恒 null', by.a.frames, null)
  eq('video 的 frameCount 恒 0', by.a.frameCount, 0)
  eq('image-seq 的 frameCount', by.b.frameCount, 3)
})

testCase('id/name 派生与重名追加（契约 §7.2）', () => {
  const r = normalizeChannels([
    { name: 'dup', url: '/media/1.mp4' },
    { name: 'dup', url: '/media/2.mp4' },
    { name: 'dup', url: '/media/3.mp4' },
    { id: 'x', url: '/media/4.mp4' },
    { id: 'x', url: '/media/5.mp4' },
  ])
  eq('重名追加 #2/#3', r.channels.map((c) => c.id), ['dup', 'dup#2', 'dup#3', 'x', 'x#2'])
  eq('name 同步唯一化', r.channels.map((c) => c.name), ['dup', 'dup#2', 'dup#3', 'x', 'x#2'])
})

testCase('overlayKeys 过滤与缺省（契约 §7.2）', () => {
  eq('合法键保持 OVERLAY_KEYS 顺序', normalizeOverlayKeys(['boxes', 'live']), ['live', 'boxes'])
  eq('非法键被剔除', normalizeOverlayKeys(['live', 'nope', 42]), ['live'])
  eq('非数组 → null', normalizeOverlayKeys('live'), null)
  const r = normalizeChannels([VIDEO('a'), VIDEO('b', { overlayKeys: ['live'] })])
  eq('缺省取 options.overlay.keys', r.channels[0].overlayKeys, [...OVERLAY_KEYS])
  eq('显式 overlayKeys 生效', r.channels[1].overlayKeys, ['live'])
})

testCase('重复归一化必须幂等（组件重渲染不改变状态）', () => {
  const raw = [VIDEO('a'), VIDEO('b'), { id: 'c', kind: 'image-seq', url: '/media/{i}.png', frameCount: 2 }]
  const a = normalizeChannels(raw)
  const b = normalizeChannels(raw)
  eq('两次结果一致', JSON.stringify(a.channels), JSON.stringify(b.channels))
})

/* ================================================================== *
 * 3. 帧展开（契约 §2.4、§6.2）
 * ================================================================== */

testCase('模板占位符展开（契约 §6.2）', () => {
  eq('{i}', expandTemplate('/media/s/{i}.jpg', 7), '/media/s/7.jpg')
  eq('{i:4} 左补零', expandTemplate('/media/s/{i:4}.jpg', 7), '/media/s/0007.jpg')
  eq('{i:3}', expandTemplate('/media/seq/frame-{i:3}.png', 12), '/media/seq/frame-012.png')
  check('有占位符', hasFramePlaceholder('/a/{i}.png') && hasFramePlaceholder('/a/{i:2}.png'))
  check('无占位符', !hasFramePlaceholder('/a/b.png') && !hasFramePlaceholder(null))
})

testCase('expandFrames / resolveFrameUrl（契约 §2.4）', () => {
  const tpl = normalizeChannels([{ id: 't', kind: 'image-seq', url: '/media/{i:2}.png', frameCount: 3 }]).channels[0]
  eq('模板展开 3 帧', expandFrames(tpl), ['/media/00.png', '/media/01.png', '/media/02.png'])
  const explicit = normalizeChannels([
    { id: 'e', kind: 'image-seq', frames: ['/a.png', '/b.png'] },
  ]).channels[0]
  eq('显式 frames 优先', expandFrames(explicit), ['/a.png', '/b.png'])
  eq('下标越界 → null', resolveFrameUrl(tpl, 9), null)
  eq('负下标 → null', resolveFrameUrl(tpl, -1), null)
  const single = normalizeChannels([{ id: 's', kind: 'image-seq', url: '/only.png' }]).channels[0]
  eq('单帧 url 下标 0 可用', resolveFrameUrl(single, 0), '/only.png')
  eq('单帧 url 下标 1 越界', resolveFrameUrl(single, 1), null)
  const none = normalizeChannels([{ id: 'n', kind: 'image-seq', url: null, frames: [] }]).channels[0]
  eq('不可展开 → []', expandFrames(none), [])
  const video = normalizeChannels([VIDEO('v')]).channels[0]
  eq('video 不展开帧', expandFrames(video), [])
  const viaResolver = normalizeChannels([{ id: 'r', kind: 'image-seq', url: null, frameCount: 2 }]).channels[0]
  eq(
    'resolver 兜底',
    expandFrames(viaResolver, { resolve: (id, i) => `${id}-${i}.png` }),
    ['r-0.png', 'r-1.png'],
  )
})

/* ================================================================== *
 * 4. 内容框与归一化坐标（契约 §8、§11.2-12/13）
 * ================================================================== */

testCase('mediaContentBox 三档取值符合 §8.2', () => {
  const c = { w: 200, h: 200 }
  // contain：s = min(200/100, 200/50) = 2 → 200×100，垂直居中
  const contain = mediaContentBox(c, { w: 100, h: 50 }, 'contain')
  eq('contain：比例正确', [contain.x, contain.y, contain.w, contain.h], [0, 50, 200, 100])
  // cover：s = max(200/100, 200/50) = 4 → 400×200，水平溢出（未裁剪）
  const cover = mediaContentBox(c, { w: 100, h: 50 }, 'cover')
  eq('cover：返回未裁剪内容框', [cover.x, cover.y, cover.w, cover.h], [-100, 0, 400, 200])
  const fill = mediaContentBox(c, { w: 100, h: 50 }, 'fill')
  eq('fill：内容框 = 容器', [fill.x, fill.y, fill.w, fill.h], [0, 0, 200, 200])
  eq('media 未知 → 整容器', mediaContentBox(c, null), { x: 0, y: 0, w: 200, h: 200 })
  eq('零尺寸容器 → 零矩形', mediaContentBox({ w: 0, h: 0 }, { w: 10, h: 10 }), { x: 0, y: 0, w: 0, h: 0 })
  eq('NaN 容器 → 零矩形', mediaContentBox({ w: NaN, h: 10 }, { w: 10, h: 10 }), { x: 0, y: 0, w: 0, h: 0 })
  const wide = mediaContentBox({ w: 400, h: 100 }, { w: 100, h: 100 }, 'contain')
  eq('contain 左右留黑边', [wide.x, wide.y, wide.w, wide.h], [150, 0, 100, 100])
})

testCase('normToPx / pxToNorm 互逆（误差 ≤ 1px，§11.2-12）', () => {
  const box = { x: 20, y: 10, w: 640, h: 360 }
  const rects = [
    { x: 0, y: 0, w: 1, h: 1 },
    { x: 0.42, y: 0.35, w: 0.18, h: 0.24 },
    { x: 0.1, y: 0.9, w: 0.05, h: 0.05 },
  ]
  for (const r of rects) {
    const back = pxToNorm(normToPx(r, box), box)
    near(`x 往返 ${JSON.stringify(r)}`, back.x, r.x, 1e-9)
    near(`y 往返`, back.y, r.y, 1e-9)
    near(`w 往返`, back.w, r.w, 1e-9)
    near(`h 往返`, back.h, r.h, 1e-9)
  }
  eq('零尺寸 box → 零矩形', normToPx({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, { x: 0, y: 0, w: 0, h: 0 }), { x: 0, y: 0, w: 0, h: 0 })
  eq('pxToNorm 零尺寸 box → 零矩形', pxToNorm({ x: 1, y: 1, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 0 }), { x: 0, y: 0, w: 0, h: 0 })
})

testCase('resize 后比例一致（不同分辨率下同框）', () => {
  const norm = { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }
  const boxes = [
    { x: 0, y: 0, w: 320, h: 180 },
    { x: 0, y: 0, w: 1280, h: 720 },
    { x: 40, y: 20, w: 640, h: 360 },
  ]
  boxes.forEach((b, i) => {
    const px = normToPx(norm, b)
    // 相对**画面内容框**的比例恒定（与容器是否偏移无关）
    near(`box${i} 相对 x`, (px.x - b.x) / b.w, norm.x, 1e-9)
    near(`box${i} 相对 y`, (px.y - b.y) / b.h, norm.y, 1e-9)
    near(`box${i} 相对 w`, px.w / b.w, norm.w, 1e-9)
    near(`box${i} 相对 h`, px.h / b.h, norm.h, 1e-9)
  })
  const a = normToPx(norm, { x: 0, y: 0, w: 320, h: 180 })
  const b2 = normToPx(norm, { x: 0, y: 0, w: 1280, h: 720 })
  near('不同分辨率下宽高比一致', a.w / a.h, b2.w / b2.h, 1e-9)
  near('不同分辨率下相对宽度一致', a.w / 320, b2.w / 1280, 1e-9)
})

testCase('越界框裁剪规则（契约 §8.4、§11.2-13）', () => {
  const approx = (r, e, tol = 1e-9) =>
    !!r &&
    Math.abs(r.x - e.x) <= tol &&
    Math.abs(r.y - e.y) <= tol &&
    Math.abs(r.w - e.w) <= tol &&
    Math.abs(r.h - e.h) <= tol
  check('完全在内 → 原样', approx(clampNormRect({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }))
  check('部分越界 → 裁剪', approx(clampNormRect({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }))
  check('负坐标 → 裁剪', approx(clampNormRect({ x: -0.2, y: -0.2, w: 0.5, h: 0.5 }), { x: 0, y: 0, w: 0.3, h: 0.3 }))
  eq('完全越界 → 不渲染（null）', clampNormRect({ x: 2, y: 2, w: 0.1, h: 0.1 }), null)
  eq('零宽 → 不渲染', clampNormRect({ x: 0.1, y: 0.1, w: 0, h: 0.2 }), null)
  eq('NaN → 不渲染', clampNormRect({ x: NaN, y: 0, w: 0.1, h: 0.1 }), null)
  eq('Infinity → 不渲染', clampNormRect({ x: 0, y: 0, w: Infinity, h: 0.1 }), null)
  check('未越界判定', isRectInUnit({ x: 0, y: 0, w: 1, h: 1 }) && !isRectInUnit({ x: 0.5, y: 0.5, w: 0.6, h: 0.1 }))
})

/* ================================================================== *
 * 5. 出声仲裁（契约 §7.5、§11.2-10）
 * ================================================================== */

function statusOf(id, patch = {}) {
  return {
    id,
    kind: 'video',
    state: 'playing',
    since: 0,
    reason: null,
    errorCode: null,
    positionMs: 0,
    durationMs: null,
    bufferedMs: 0,
    volume: 0.8,
    muted: false,
    userMuted: false,
    mutedByPolicy: false,
    audible: false,
    rate: 1,
    loop: false,
    frameIndex: 0,
    frameCount: 0,
    videoSize: null,
    visible: true,
    fullscreen: false,
    degraded: { range: false, hint: null },
    diagnostics: {
      loadMs: null,
      seekMs: null,
      bufferingCount: 0,
      droppedFrames: 0,
      loadFailures: 0,
      lastErrorAt: null,
      pausedByPolicy: false,
      throttleMs: 100,
      updatedAt: 0,
    },
    ...patch,
  }
}

const chans = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    name: `c${i + 1}`,
    kind: 'video',
    url: `/media/c${i + 1}.mp4`,
    available: true,
  }))

testCase('pickAudible 仲裁矩阵（§7.5）', () => {
  const c6 = chans(6)
  const playing = c6.map((c) => statusOf(c.id))
  eq("'none' → 恒 null", pickAudible(c6, playing, 'c1', 'none'), null)
  eq("'single' + 主路可用 → 主路", pickAudible(c6, playing, 'c3', 'single'), 'c3')
  eq(
    "'single' + 主路用户静音 → null（MUST NOT 让位）",
    pickAudible(c6, playing.map((s) => (s.id === 'c3' ? statusOf(s.id, { userMuted: true }) : s)), 'c3', 'single'),
    null,
  )
  eq(
    "'single' + 无主路 → 候选之一",
    pickAudible(c6, playing, null, 'single'),
    'c1',
  )
  eq(
    "'single' + 无主路无候选 → null",
    pickAudible(c6, playing.map((s) => statusOf(s.id, { state: 'paused' })), null, 'single'),
    null,
  )
  eq(
    "'all' → 候选之一（用户静音各自生效）",
    pickAudible(c6, playing.map((s) => (s.id === 'c1' ? statusOf(s.id, { userMuted: true }) : s)), null, 'all'),
    'c2',
  )
  eq('不可见不算候选', pickAudible(c6, playing.map((s) => statusOf(s.id, { visible: false })), null, 'all'), null)
  eq('不可用通道不算候选', pickAudible(c6.map((c) => ({ ...c, available: false })), playing, null, 'all'), null)
  eq('空清单 → null', pickAudible([], [], null, 'single'), null)
  eq('error 态不算候选', pickAudible(c6, playing.map((s) => statusOf(s.id, { state: 'error' })), null, 'all'), null)
})

testCase("'single' 下 6 路至多一路出声（CTR-MDP-AU-01、§11.2-10）", () => {
  const c6 = chans(6)
  const statuses = c6.map((c) => statusOf(c.id))
  const audibleId = pickAudible(c6, statuses, 'c1', 'single')
  const flags = statuses.map((s) => (s.id === audibleId ? true : false))
  eq('只有一个 audible:true', flags.filter(Boolean).length, 1)
  eq('主路跟随', audibleId, 'c1')
  eq('切主路后声音跟随', pickAudible(c6, statuses, 'c5', 'single'), 'c5')
  eq('取消主路回到唯一候选', pickAudible(c6, statuses, null, 'single'), 'c1')
})

/* ================================================================== *
 * 6. 摘要与事件总线
 * ================================================================== */

testCase('buildSummary 汇总口径', () => {
  const ch = chans(3)
  const st = [statusOf('c1', { state: 'playing' }), statusOf('c2', { state: 'error' }), statusOf('c3', { state: 'idle', visible: false })]
  const s = buildSummary({
    channels: ch,
    statuses: st,
    mainId: 'c1',
    audibleId: 'c1',
    fullscreenId: null,
    layout: 'grid',
    emptyReason: null,
    policyRejections: 2,
  })
  eq('total', s.total, 3)
  eq('usable', s.usable, 3)
  eq('visible', s.visible, 2)
  eq('states', s.states, { idle: 1, loading: 0, ready: 0, playing: 1, paused: 0, error: 1 })
  eq('empty=false', s.empty, false)
  eq('emptyReason=null', s.emptyReason, null)
  eq('policyRejections', s.policyRejections, 2)
  const empty = buildSummary({
    channels: [],
    statuses: [],
    mainId: null,
    audibleId: null,
    fullscreenId: null,
    layout: 'grid',
    emptyReason: 'no-channels',
    policyRejections: 0,
  })
  eq('空清单 empty=true', empty.empty, true)
  eq('空清单原因透出', empty.emptyReason, 'no-channels')
})

testCase('事件总线：限频、环形缓冲、回调异常隔离（§5.1、CTR-MDP-EC-05）', () => {
  const em = new MediaEmitter(100)
  const got = []
  const off = em.subscribe((ev) => got.push(ev.type))
  const mk = (ts) => ({ type: 'media.state', data: { channelId: 'a', at: ts, state: 'playing', prevState: 'ready', kind: 'video' }, ts })
  em.emit(mk(0), { rateKey: 'a' })
  em.emit(mk(50), { rateKey: 'a' }) // 被限频吞掉
  em.emit(mk(100), { rateKey: 'a' }) // 距上次 100ms，允许
  eq('限频后只收到 2 条（ts=0 首条 + ts=100 一条）', got.length, 2)
  em.emit(mk(101), { rateKey: 'a', force: true })
  eq('force 绕过限频', got.length, 3)
  off()
  em.emit(mk(500), { rateKey: 'a' })
  eq('退订后不再收到', got.length, 3)
  const before = em.callbackErrorCount
  em.subscribe(() => {
    throw new Error('宿主回调故意抛错')
  })
  em.emit(mk(900), { rateKey: 'a' })
  eq('回调异常被计数', em.callbackErrorCount, before + 1)
  check('异常未中断发射', em.snapshot().length >= 4)
  for (let i = 0; i < 400; i++) em.emit({ type: 'media.error', data: { channelId: 'a', errorCode: 3001, reason: 'x', recoverable: true, at: i }, ts: i }, undefined, true)
  eq('环形缓冲容量 256', em.snapshot().length, 256)
})

/* ================================================================== *
 * 7. 控制器：清单与状态（MDP-DGR-01、§11.2-17）
 * ================================================================== */

/** 最近一次 mk() 的时钟与计时器 */
let lastClock = null
let lastTimer = null

/**
 * 推进注入时钟**并**触发到点的假计时器（节流 / 轮播 / 延迟暂停 / 定位超时 / 退避重试）。
 *
 * 只推时钟不推计时器会让"排程类"行为永远不触发 —— 这类断言必须走这里，
 * 而不能只 `clock.advance(ms)`。
 */
function advance(ms) {
  if (!lastClock) throw new Error('advance() 需要在 mk() 之后使用')
  if (lastTimer) return lastTimer.advance(ms)
  return lastClock.advance(ms)
}

function mk(options = {}, channels = undefined, extra = {}) {
  const c = makeClock()
  lastClock = c
  const t = makeTimer(c)
  lastTimer = t
  const { adapters = {}, ...rest } = extra
  // 注入时钟优先：适配器里的其它项（probe/source/frameResolver）与注入时钟合并，
  // 保证"同一被测序列在注入固定时钟下完全可复现"（契约 §3.2）
  const controller = new MediaControllerImpl(
    { channels, options, ...rest, adapters: { ...adapters, clock: c.clock } },
    { timer: t.timer },
  )
  return { controller, ...c, timer: t }
}

testCase('setChannels 全量替换与释放（§11.2-17）', () => {
  const { controller } = mk({}, [VIDEO('a'), VIDEO('b')])
  eq('初始 2 路', controller.getChannels().map((c) => c.id), ['a', 'b'])
  const r = controller.setChannels({ schemaVersion: '1.0.0', channels: [VIDEO('a'), VIDEO('c')] })
  check('替换成功', r.ok)
  eq('移除 b、新增 c', controller.getChannels().map((c) => c.id).sort(), ['a', 'c'])
  eq('旧 id 不在清单内', controller.getChannel('b'), null)
  check('被移除通道无 audible:true', controller.getAllStatus().every((s) => !s.audible))
  eq('applied 顺序同输入', r.data.applied, ['a', 'c'])
  eq('usable', r.data.usable, 2)
})

testCase('同 id 同源复用（MUST NOT 重建），换源回 idle', () => {
  const { controller } = mk({}, [VIDEO('a')])
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 160, h: 90, durationMs: 1000 })
  eq('进入 ready', controller.getStatus('a').state, 'ready')
  controller.setChannels([VIDEO('a')])
  eq('同源复用：位置与状态保留', controller.getStatus('a').state, 'ready')
  controller.setChannels([{ id: 'a', name: 'a', kind: 'video', url: '/media/other.mp4' }])
  eq('换源后回 idle', controller.getStatus('a').state, 'idle')
})

testCase('上限保护：maxChannels / maxChannelsByKind → 3004（§11.2-14）', () => {
  const { controller } = mk({ maxChannels: 6, maxChannelsByKind: { video: 6, 'image-seq': 6 } }, chans(8))
  eq('装载 6 路', controller.getChannels().length, 6)
  eq('policyRejections 计数', controller.getSummary().policyRejections, 2)
  const kindLimited = mk({ maxChannels: 6, maxChannelsByKind: { video: 2, 'image-seq': 6 } }, [
    VIDEO('v1'),
    VIDEO('v2'),
    VIDEO('v3'),
    { id: 's1', kind: 'image-seq', url: '/media/{i}.png', frameCount: 2 },
  ])
  eq('每类上限生效', kindLimited.controller.getChannels().map((c) => c.id), ['v1', 'v2', 's1'])
  eq('视频类超限计数', kindLimited.controller.getSummary().policyRejections, 1)
})

testCase('状态机：play/pause/stop 与幂等（§7.4、§11.2-11）', () => {
  const { controller, advance } = mk({}, [VIDEO('a')])
  eq('初始 idle', controller.getStatus('a').state, 'idle')
  const p1 = controller.play('a')
  check('play 成功', p1.ok)
  eq('play → loading', controller.getStatus('a').state, 'loading')
  const p2 = controller.play('a')
  check('重复 play 幂等', p2.ok && p2.idempotent === true)
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 640, h: 360, durationMs: 5000 })
  eq('首帧可绘 → ready', controller.getStatus('a').state, 'ready')
  eq('loadMs 落值', controller.getStatus('a').diagnostics.loadMs, 150)
  eq('videoSize 记录实际分辨率', controller.getStatus('a').videoSize, { w: 640, h: 360 })
  eq('durationMs 落值', controller.getStatus('a').durationMs, 5000)
  advance(150)
  controller.reportMediaEvent('a', 'playing')
  eq('playing', controller.getStatus('a').state, 'playing')
  const pause1 = controller.pause('a')
  check('pause 成功', pause1.ok)
  eq('paused', controller.getStatus('a').state, 'paused')
  const pause2 = controller.pause('a')
  check('重复 pause 幂等', pause2.ok && pause2.idempotent === true)
  const stop = controller.stop('a')
  check('stop 成功', stop.ok)
  eq('stop → idle', controller.getStatus('a').state, 'idle')
  eq('位置归零', controller.getStatus('a').positionMs, 0)
})

testCase('状态闭集与 error 态不变量（§11.2-9）', () => {
  const { controller } = mk({}, [VIDEO('a'), VIDEO('b')])
  const states = new Set(CHANNEL_STATES)
  const transitions = []
  controller.subscribe((ev) => {
    if (ev.type === 'media.state') transitions.push(ev.data)
  })
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 10, h: 10 })
  advance(150)
  controller.reportMediaEvent('a', 'playing')
  controller.pause('a')
  controller.stop('a')
  advance(150)
  controller.reportMediaEvent('a', 'error', { errorCode: 3001, reason: '故意失败' })
  const err = controller.getStatus('a')
  eq('error 态', err.state, 'error')
  check('error 态 reason 非空', typeof err.reason === 'string' && err.reason.length > 0)
  check('error 态 errorCode 非空', err.errorCode !== null)
  check('全部迁移落在闭集内', transitions.every((t) => states.has(t.state) && states.has(t.prevState)))
  eq('b 未受影响', controller.getStatus('b').state, 'idle')
  check('error 后仍可恢复（play 重试 → loading）', controller.play('a').ok && controller.getStatus('a').state === 'loading')
})

testCase('状态迁移与回调去重（同一次迁移只回调一次）', () => {
  const seen = []
  const { controller, advance } = mk({ audioPolicy: 'none' }, [VIDEO('a')], { onEvent: (ev) => seen.push(ev.type) })
  const stateEvents = []
  controller.subscribe((ev) => {
    if (ev.type === 'media.state') stateEvents.push(ev.data)
  })
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 1, h: 1 })
  // 时钟 MUST 越过 throttleMs：同一窗口内的两次迁移会被限频合并（§5.1 频率约束）
  advance(200)
  controller.reportMediaEvent('a', 'loadeddata', { w: 1, h: 1 })
  const aStates = stateEvents.filter((e) => e.channelId === 'a').map((e) => `${e.prevState}>${e.state}`)
  eq('无重复迁移', aStates, ['idle>loading', 'loading>ready'])
  check('onEvent 也收到了事件', seen.includes('media.state'))
  eq('事件信封恰好三字段', Object.keys(JSON.parse(JSON.stringify({ type: 'media.state', data: {}, ts: 1 }))), ['type', 'data', 'ts'])
})

testCase('seek 语义：夹紧、无 Range 提示、image-seq 拒绝（MDP-PLY-02）', () => {
  const { controller, advance } = mk({}, [VIDEO('a'), { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 4 }])
  eq('idle 时 seek → 1003', controller.seek('a', 100).code, 1003)
  advance(150)
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 10, h: 10, durationMs: 1000 })
  check('就绪后可定位（前置条件）', controller.getStatus('a').state === 'ready', controller.getStatus('a').state)
  const r = controller.seek('a', 1500)
  check('越界夹紧', r.ok && r.clamped === true)
  eq('夹紧到 duration', controller.getStatus('a').positionMs, 1000)
  const neg = controller.seek('a', -50)
  // 负值被夹紧到 [0, duration] 内（clamped 只标记「超出 duration」的夹紧）
  check('负值夹紧到 0', neg.ok && controller.getStatus('a').positionMs === 0)
  eq('image-seq 上 seek → 1000', controller.seek('s', 100).code, 1000)
  eq('不存在的通道 → 1004', controller.seek('nope', 1).code, 1004)
  // 注入"无 Range"探测（时钟仍用 mk 注入的那个，保证时序可复现）
  const noRange = mk({}, [VIDEO('a')], {
    adapters: { probe: { probe: async () => ({ reachable: true, acceptRanges: false }) } },
  })
  noRange.controller.play('a')
  noRange.controller.reportMediaEvent('a', 'loadeddata', { w: 10, h: 10, durationMs: 1000 })
  return waitFor(() => noRange.controller.getStatus('a').degraded.range, 50).then((okDeg) => {
    check('无 Range → degraded.range=true', okDeg)
    const hint = noRange.controller.getStatus('a').degraded.hint
    check('无 Range → 可读提示非空', typeof hint === 'string' && hint.length > 0)
    const s = noRange.controller.seek('a', 100)
    check('无 Range 时 seek 不静默失败（消息含提示）', s.ok && s.message.includes('Range'))
  })
})

/** 简易轮询等待（微任务/计时器驱动的异步收敛） */
function waitFor(pred, tries = 20) {
  return new Promise((resolve) => {
    let n = 0
    const tick = () => {
      if (pred()) return resolve(true)
      if (++n >= tries) return resolve(false)
      setTimeout(tick, 0)
    }
    tick()
  })
}

/* ================================================================== *
 * 8. 控制器：音量、静态、倍速、循环、帧（MDP-PLY-03/04/06）
 * ================================================================== */

testCase("'single' 策略：6 路至多一路出声，切主路声音跟随（MDP-PLY-03）", () => {
  const { controller } = mk({}, chans(6))
  for (const c of controller.getChannels()) {
    controller.play(c.id)
    advance(150)
    controller.reportMediaEvent(c.id, 'loadeddata', { w: 10, h: 10 })
    advance(150)
    controller.reportMediaEvent(c.id, 'playing')
  }
  controller.setMain('c3')
  const audible = controller.getAllStatus().filter((s) => s.audible)
  eq('至多一路 audible', audible.length, 1)
  eq('主路出声', audible.length === 1 ? audible[0].id : null, 'c3')
  eq('getAudible 与状态一致', controller.getAudible(), 'c3')
  eq('其余路 mutedByPolicy', controller.getAllStatus().filter((s) => s.mutedByPolicy).length, 5)
  controller.setMain('c5')
  eq('切主路后声音跟随', controller.getAudible(), 'c5')
  const m = controller.mute('c5', true)
  check('主路用户静音成功', m.ok)
  eq('主路静音后无声（MUST NOT 让位）', controller.getAudible(), null)
  const unmute = controller.mute('c5', false)
  check('取消静音后策略覆盖提示', unmute.ok)
  eq('恢复出声', controller.getAudible(), 'c5')
  controller.setMain(null)
  eq('取消主路回到唯一候选', controller.getAudible() !== null && controller.getAllStatus().filter((s) => s.audible).length === 1, true)
})

testCase('mute 幂等与策略覆盖回执（CTR-MDP-AU-03）', () => {
  const { controller } = mk({}, [VIDEO('a'), VIDEO('b')])
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 1, h: 1 })
  controller.play('b')
  advance(150)
  controller.reportMediaEvent('b', 'loadeddata', { w: 1, h: 1 })
  controller.setMain('a')
  eq('b 被策略静音', controller.getStatus('b').mutedByPolicy, true)
  const r = controller.mute('b', false)
  check('策略覆盖时仍 code 0', r.ok)
  eq('data.policyOverride', r.data && r.data.policyOverride, true)
  eq('b 仍有效静音', controller.getStatus('b').muted, true)
  const idem = controller.mute('b', false)
  check('重复取消静音幂等', idem.ok && idem.idempotent === true)
  eq("audioPolicy='none' → 全部静音", mk({ audioPolicy: 'none' }, [VIDEO('x')]).controller.getAudible(), null)
})

testCase('音量夹紧与静音（MDP-PLY-03）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  const r1 = controller.setVolume('a', 1.5)
  check('音量 >1 夹紧', r1.ok && r1.clamped === true)
  eq('夹紧到 1', controller.getStatus('a').volume, 1)
  const r2 = controller.setVolume('a', -1)
  check('音量 <0 夹紧', r2.ok && r2.clamped === true)
  eq('夹紧到 0', controller.getStatus('a').volume, 0)
  const r3 = controller.setVolume('a', 0.5)
  check('合法音量不夹紧', r3.ok && !r3.clamped)
  eq('音量生效', controller.getStatus('a').volume, 0.5)
  const r4 = controller.setVolume('a', NaN)
  check('NaN 回退缺省值并夹紧', r4.ok && r4.clamped === true)
})

testCase('倍速仅接受 rateOptions（MDP-PLY-04）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  eq('非法倍速 → 1000', controller.setRate('a', 3).code, 1000)
  check('0.5× 生效', controller.setRate('a', 0.5).ok)
  eq('rate 落值', controller.getStatus('a').rate, 0.5)
  check('2× 生效', controller.setRate('a', 2).ok)
})

testCase('单帧步进：先暂停再推进（MDP-PLY-04）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  eq('未就绪时 stepFrame → 1003', controller.stepFrame('a', 1).code, 1003)
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 10, h: 10, durationMs: 10_000 })
  advance(150)
  controller.reportMediaEvent('a', 'playing')
  const r = controller.stepFrame('a', 1)
  check('步进成功', r.ok)
  eq('终态为 paused', controller.getStatus('a').state, 'paused')
  eq('按 stepFallbackMs 推进', controller.getStatus('a').positionMs, DEFAULT_OPTIONS.stepFallbackMs)
  controller.stepFrame('a', -1)
  eq('可回退', controller.getStatus('a').positionMs, 0)
  eq('delta=0 → 1000', controller.stepFrame('a', 0).code, 1000)
})

testCase('循环与帧间隔夹紧（MDP-PLY-06、MDP-MUL-05）', () => {
  const { controller } = mk({}, [
    { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 4, frameIntervalMs: 200 },
    VIDEO('v'),
  ])
  check('设循环', controller.setLoop('s', true).ok)
  eq('循环落值', controller.getStatus('s').loop, true)
  const idem = controller.setLoop('s', true)
  check('重复设置幂等', idem.ok && idem.idempotent === true)
  const clamped = controller.setFrameInterval('s', 10)
  check('低于下限被夹紧', clamped.ok && clamped.clamped === true)
  eq('夹紧到 minFrameIntervalMs', controller.getChannel('s').frameIntervalMs, DEFAULT_OPTIONS.minFrameIntervalMs)
  eq('video 上 setFrameInterval → 1000', controller.setFrameInterval('v', 100).code, 1000)
  eq('不存在的通道 → 1004', controller.setFrameInterval('nope', 100).code, 1004)
})

testCase('图像流轮播可复现（假计时器驱动）', () => {
  const { controller, timer } = mk({}, [
    { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 4, frameIntervalMs: 200, loop: true },
  ])
  // 起播口径：图像流的"第一个节拍"从 play 开始算 —— 首帧 onload 只把它带进 playing
  controller.play('s')
  controller.reportImageEvent('s', 0, true)
  eq('首帧可绘且已请求播放 → playing', controller.getStatus('s').state, 'playing')
  advance(150)
  eq('初始帧 0', controller.getStatus('s').frameIndex, 0)
  advance(49)
  eq('未到间隔不推进（199ms）', controller.getStatus('s').frameIndex, 0)
  advance(1)
  eq('到间隔推进第 1 帧（200ms）', controller.getStatus('s').frameIndex, 1)
  timer.advance(200)
  eq('400ms 后第 2 帧', controller.getStatus('s').frameIndex, 2)
  timer.advance(200)
  eq('600ms 后第 3 帧（末帧）', controller.getStatus('s').frameIndex, 3)
  timer.advance(200)
  eq('循环回到 0', controller.getStatus('s').frameIndex, 0)
  controller.pause('s')
  const frozen = controller.getStatus('s').frameIndex
  timer.advance(2000)
  eq('暂停后停轮播', controller.getStatus('s').frameIndex, frozen)
  eq('暂停后无残留节拍', timer.pendingCount(), 0)
  eq('positionMs 与帧号一致', controller.getStatus('s').positionMs, frozen * 200)
  // 暂停后再播放 MUST 继续推进（图像流没有 DOM 事件把它带回 playing）
  controller.play('s')
  eq('恢复播放回到 playing', controller.getStatus('s').state, 'playing')
  timer.advance(200)
  eq('恢复后继续换帧', controller.getStatus('s').frameIndex, (frozen + 1) % 4)
})

testCase('图像流不循环时停在末帧（MDP-PLY-06）', () => {
  const { controller, timer } = mk({}, [
    { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 3, frameIntervalMs: 100, loop: false },
  ])
  controller.play('s')
  controller.reportImageEvent('s', 0, true)
  timer.advance(100)
  eq('第 1 帧', controller.getStatus('s').frameIndex, 1)
  timer.advance(100)
  eq('第 2 帧（末帧）', controller.getStatus('s').frameIndex, 2)
  timer.advance(500)
  eq('停在末帧', controller.getStatus('s').frameIndex, 2)
  eq('末帧后转 paused', controller.getStatus('s').state, 'paused')
  eq('末帧原因可读（MDP-DGR-01）', controller.getStatus('s').reason, '已到末帧')
  eq('末帧后无残留节拍', timer.pendingCount(), 0)
})

testCase('pushFrame：实时推帧与有界缓存（MDP-PLY-06、MDP-MUL-03）', () => {
  const { controller } = mk({ bufferLimitFrames: 4 }, [
    { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 3 },
    VIDEO('v'),
  ])
  check('按下标推帧', controller.pushFrame('s', 2).ok)
  eq('帧下标生效', controller.getStatus('s').frameIndex, 2)
  eq('越界下标 → 1004', controller.pushFrame('s', 9).code, 1004)
  check('按 URL 推帧', controller.pushFrame('s', '/media/live-1.png').ok)
  eq('新帧进队首', controller.getFrames('s')[0], '/media/live-1.png')
  for (let i = 0; i < 10; i++) controller.pushFrame('s', `/media/live-${i}.png`)
  eq('有界缓存不超上限', controller.getFrames('s').length, 4)
  eq('video 上 pushFrame → 1000', controller.pushFrame('v', 1).code, 1000)
})

/* ================================================================== *
 * 9. 控制器：可见性、布局、全屏
 * ================================================================== */

testCase('按需加载：不可见延迟暂停并可恢复（MDP-MUL-03）', () => {
  const { controller, timer } = mk({ lazyVisibility: true, hiddenPauseDelayMs: 500 }, [VIDEO('a')])
  controller.play('a')
  advance(150)
  controller.reportMediaEvent('a', 'loadeddata', { w: 1, h: 1 })
  advance(150)
  controller.reportMediaEvent('a', 'playing')
  eq('播放中', controller.getStatus('a').state, 'playing')
  controller.setVisible('a', false)
  eq('未到延迟仍播放', controller.getStatus('a').state, 'playing')
  timer.advance(500)
  eq('延迟后暂停', controller.getStatus('a').state, 'paused')
  eq('标记 pausedByPolicy', controller.getStatus('a').diagnostics.pausedByPolicy, true)
  eq('不可见时不出声', controller.getStatus('a').audible, false)
  controller.setVisible('a', true)
  eq('重新可见自动恢复', controller.getStatus('a').state, 'playing')
  eq('pausedByPolicy 复位', controller.getStatus('a').diagnostics.pausedByPolicy, false)
  const idem = controller.setVisible('a', true)
  check('重复 setVisible 幂等', idem.ok && idem.idempotent === true)
})

testCase('布局与主路（MDP-MUL-04）', () => {
  const { controller } = mk({}, [VIDEO('a'), VIDEO('b')])
  eq('缺省 grid', controller.getLayout(), 'grid')
  check('切 focus', controller.setLayout('focus').ok)
  eq('focus 生效', controller.getLayout(), 'focus')
  eq('非法 layout → 1000', controller.setLayout('x').code, 1000)
  check('设主路', controller.setMain('a').ok)
  eq('getMain', controller.getMain(), 'a')
  eq('不存在的主路 → 1004', controller.setMain('zz').code, 1004)
  const idem = controller.setMain('a')
  check('重复设主路幂等', idem.ok && idem.idempotent === true)
  check('取消主路', controller.setMain(null).ok)
  eq('getMain=null', controller.getMain(), null)
})

testCase('全屏：互斥 1002、无能力 3005、幂等（§11.2-11）', () => {
  const { controller } = mk({}, [VIDEO('a'), VIDEO('b')])
  const noApi = controller.enterFullscreen('a')
  return noApi.then((r) => {
    eq('无 Fullscreen API → 3005', r.code, 3005)
    eq('不存在通道 → 1004', controller.getFullscreen(), null)
    return controller.exitFullscreen().then((e) => {
      check('未全屏时 exit 幂等', e.ok && e.idempotent === true)
      return controller.enterFullscreen('zz').then((r2) => {
        eq('不存在通道 → 1004', r2.code, 1004)
      })
    })
  })
})

/* ================================================================== *
 * 10. 控制器：叠加层、配置、生命周期
 * ================================================================== */

testCase('叠加层：逐项开关与深拷贝（MDP-OVL-01/02）', () => {
  const { controller } = mk({}, [{ ...VIDEO('a'), overlayKeys: ['live', 'boxes'] }])
  eq('初始叠加项', controller.getChannel('a').overlayKeys, ['live', 'boxes'])
  check('关闭 timestamp', controller.toggleOverlay('a', 'timestamp', false).ok)
  eq('关闭后不含该项', controller.getChannel('a').overlayKeys, ['live', 'boxes'])
  check('打开 timestamp', controller.toggleOverlay('a', 'timestamp', true).ok)
  eq('打开后按 OVERLAY_KEYS 顺序', controller.getChannel('a').overlayKeys, ['live', 'timestamp', 'boxes'])
  const toggled = controller.toggleOverlay('a', 'live')
  check('不传 on 时取反', toggled.ok && !controller.getChannel('a').overlayKeys.includes('live'))
  eq('非法叠加项 → 1000', controller.toggleOverlay('a', 'nope').code, 1000)
  check('写入叠加内容', controller.setOverlay('a', { magnification: '×4', live: true }).ok)
  eq('内容生效', controller.getOverlay('a').magnification, '×4')
  const copy = controller.getOverlay('a')
  copy.magnification = '改了'
  eq('getOverlay 返回副本', controller.getOverlay('a').magnification, '×4')
})

testCase('叠加层内容与通道列表均为副本（宿主改动不影响内部）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  const list = controller.getChannels()
  list[0].name = '被改了'
  eq('通道列表是副本', controller.getChannel('a').name, 'a')
  const ch = controller.getChannel('a')
  ch.meta.injected = true
  eq('meta 也是副本', controller.getChannel('a').meta.injected, undefined)
})

testCase('setOptions 部分覆盖、夹紧与非法保留原值（契约 §6.3）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  check('改音量', controller.setOptions({ defaultVolume: 0.3 }).ok)
  eq('生效', controller.getOptions().defaultVolume, 0.3)
  const clamped = controller.setOptions({ maxChannels: 2.7 })
  check('小数夹紧为整数', clamped.ok && clamped.clamped === true)
  eq('夹紧结果', controller.getOptions().maxChannels, 2)
  const bad = controller.setOptions({ audioPolicy: 'stereo' })
  check('非法枚举 → 1000', !bad.ok && bad.code === 1000)
  eq('非法值保留原值', controller.getOptions().audioPolicy, 'single')
  check('未知字段被忽略（前向兼容）', controller.setOptions({ notAnOption: 1 }).ok)
  const opts = controller.getOptions()
  opts.rateOptions.push(99)
  eq('getOptions 返回副本', controller.getOptions().rateOptions.includes(99), false)
})

testCase('dispose 后一切方法回 1005（契约 §7.3）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  controller.dispose()
  eq('play', controller.play('a').code, 1005)
  eq('pause', controller.pause('a').code, 1005)
  eq('stop', controller.stop('a').code, 1005)
  eq('seek', controller.seek('a', 1).code, 1005)
  eq('setVolume', controller.setVolume('a', 0.1).code, 1005)
  eq('setMain', controller.setMain(null).code, 1005)
  eq('setChannels', controller.setChannels([]).code, 1005)
  eq('setOptions', controller.setOptions({ defaultVolume: 0.1 }).code, 1005)
  check('dispose 幂等且不抛', (controller.dispose(), true))
  eq('诊断标记 disposed', controller.getDiagnostics().disposed, true)
})

testCase('宿主回调抛异常不影响状态机（CTR-MDP-EC-05）', () => {
  const { controller } = mk({ audioPolicy: 'none' }, [VIDEO('a')], {
    onEvent: () => {
      throw new Error('回调故意抛错')
    },
  })
  controller.subscribe(() => {
    throw new Error('订阅者故意抛错')
  })
  check('play 仍成功', controller.play('a').ok)
  eq('状态仍推进', controller.getStatus('a').state, 'loading')
  check('异常被计数', controller.getDiagnosticSnapshot().callbackErrors >= 1)
})

testCase('空清单降级：onEmpty 与 summary（MDP-DGR-02、§11.2-8）', () => {
  const cases = []
  const c1 = mk({}, [])
  cases.push(['空数组 → no-channels', c1.controller.getSummary().emptyReason, 'no-channels'])
  const c2 = mk({}, [{ id: 'a', kind: 'video', available: false, unavailableReason: '维护' }])
  cases.push(['全部不可用 → all-unavailable', c2.controller.getSummary().emptyReason, 'all-unavailable'])
  const c3 = mk({}, { schemaVersion: '9.0.0', channels: [VIDEO('a')] })
  cases.push(['schema 不符 → schema-mismatch', c3.controller.getSummary().emptyReason, 'schema-mismatch'])
  const c4 = mk({}, { nope: 1 })
  cases.push(['形状不支持 → no-channels', c4.controller.getSummary().emptyReason, 'no-channels'])
  for (const [label, actual, expected] of cases) eq(label, actual, expected)
  for (const [label, , expected] of cases) {
    const target = { 'no-channels': c1, 'all-unavailable': c2, 'schema-mismatch': c3 }[expected]
    check(`${label}：summary.empty=true`, target.controller.getSummary().empty === true)
    check(`${label}：可用通道为 0`, target.controller.getSummary().usable === 0)
  }
})

testCase('空清单 → onEmpty 只回调一次（同一次迁移去重）', () => {
  const seen = []
  const c = makeClock()
  const t = makeTimer(c)
  const controller = new MediaControllerImpl(
    {
      channels: [],
      adapters: { clock: c.clock },
      onEmpty: (reason) => seen.push(reason),
    },
    { timer: t.timer },
  )
  eq('onEmpty 收到 no-channels', seen, ['no-channels'])
  controller.setChannels([])
  eq('重复空装载不重复回调', seen.length, 1)
})

testCase('refreshChannels：来源失败保留现有清单（MDP-CHN-02）', () => {
  const c = makeClock()
  const t = makeTimer(c)
  const controller = new MediaControllerImpl(
    { channels: [VIDEO('a')], adapters: { clock: c.clock }, options: {} },
    { timer: t.timer },
  )
  return controller.refreshChannels().then((r) => {
    eq('未注入来源 → 1003', r.code, 1003)
    const withSource = new MediaControllerImpl(
      {
        channels: [VIDEO('a')],
        adapters: {
          clock: c.clock,
          source: {
            list: async () => {
              throw new Error('来源炸了')
            },
          },
        },
      },
      { timer: t.timer },
    )
    return withSource.refreshChannels().then((r2) => {
      eq('来源失败 → 3001', r2.code, 3001)
      eq('现有清单保持不变', withSource.getChannels().map((x) => x.id), ['a'])
      const okSource = new MediaControllerImpl(
        {
          channels: [],
          adapters: { clock: c.clock, source: { list: async () => [{ name: 'n', url: '/media/n.mp4' }] } },
        },
        { timer: t.timer },
      )
      return okSource.refreshChannels().then((r3) => {
        check('来源成功装载', r3.ok && okSource.getChannels().length === 1)
      })
    })
  })
})

/* ================================================================== *
 * 11. 视图桥：内容框单一来源（CTR-MDP-OVL-01）
 * ================================================================== */

testCase('视图实测尺寸驱动内容框（resize/全屏不错位的前提）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  eq('未挂载时内容框为零矩形', controller.getViewState('a').box, { x: 0, y: 0, w: 0, h: 0 })
  controller.reportContainerSize('a', { w: 200, h: 200 })
  eq('仅容器 → 内容框 = 容器', controller.getViewState('a').box, { x: 0, y: 0, w: 200, h: 200 })
  controller.reportMediaSize('a', { w: 100, h: 50 })
  eq('媒体尺寸到达 → contain 内容框', controller.getViewState('a').box, { x: 0, y: 50, w: 200, h: 100 })
  eq('分辨率进入诊断', controller.getStatus('a').videoSize, { w: 100, h: 50 })
  const rev1 = controller.getViewState('a').rev
  controller.reportContainerSize('a', { w: 400, h: 100 })
  const rev2 = controller.getViewState('a').rev
  check('尺寸变化触发重算（rev 递增）', rev2 > rev1)
  eq('resize 后内容框跟随', controller.getViewState('a').box, { x: 100, y: 0, w: 200, h: 100 })
  // 容器尺寸归零：内容框回落到媒体自身基准（不出现负尺寸/NaN）
  controller.reportContainerSize('a', { w: 0, h: 0 })
  eq('零尺寸容器 → 回落到媒体基准', controller.getViewState('a').box, { x: 0, y: 0, w: 100, h: 50 })
  controller.reportContainerSize('a', { w: 200, h: 200 })
})

testCase('getElement / setElement 与元素句柄挂载', () => {
  const { controller } = mk({}, [VIDEO('a')])
  eq('未挂载 → null', controller.getElement('a'), null)
  const fakeEl = { tagName: 'DIV' }
  controller.setElement('a', fakeEl)
  eq('挂载后可取', controller.getElement('a'), fakeEl)
  const calls = []
  controller.attachHandle({
    id: 'a',
    kind: 'video',
    play: () => calls.push('play'),
    pause: () => calls.push('pause'),
    stop: () => calls.push('stop'),
    seek: (ms) => calls.push(`seek:${ms}`),
    setVolume: (v) => calls.push(`vol:${v}`),
    setMuted: (m) => calls.push(`mute:${m}`),
    setRate: (r) => calls.push(`rate:${r}`),
    setLoop: (l) => calls.push(`loop:${l}`),
    setFrame: (i) => calls.push(`frame:${i}`),
  })
  controller.play('a')
  check('命令抵达元素', calls.includes('play'))
  check('音量下发', calls.some((c) => c.startsWith('vol:')))
  controller.setVolume('a', 0.25)
  check('后续命令继续抵达', calls.includes('vol:0.25'))
  controller.detachHandle('a')
  calls.length = 0
  controller.pause('a')
  eq('卸载后命令不再抵达 DOM', calls.length, 0)
})

/* ================================================================== *
 * 12. 依赖注入（契约 §3.2 P9：时间 MUST 可注入）
 *
 * 这一节的存在理由：`createMediaController` 一旦丢掉 `deps`，注入的假计时器就不会
 * 生效，"节流 / 轮播 / 延迟暂停 / 定位超时"全部退回真实 `setTimeout`，时序不再可复现。
 * ================================================================== */

testCase('工厂 createMediaController 必须透传注入的 clock 与 timer（P9）', () => {
  const c = makeClock(1_000)
  const t = makeTimer(c)
  const controller = createMediaController(
    {
      channels: [{ id: 'v', name: 'v', kind: 'video', url: '/media/v.mp4' }],
      adapters: { clock: c.clock },
      options: { seekTimeoutMs: 3_000 },
    },
    { timer: t.timer },
  )
  eq('注入时钟生效（diagnostics.ts 用注入值）', controller.getDiagnostics().ts, 1_000)
  controller.play('v')
  controller.reportMediaEvent('v', 'loadeddata', { w: 160, h: 90, durationMs: 10_000 })
  controller.seek('v', 5_000)
  eq('定位超时排程进入注入计时器', t.pendingCount(), 1)
  t.advance(3_500)
  const s = controller.getStatus('v')
  eq('超时判为 Range 降级', s.degraded.range, true)
  eq('seekMs 记入诊断（DGR-04）', s.diagnostics.seekMs, 3_500)
  check('降级提示可读非空', typeof s.degraded.hint === 'string' && s.degraded.hint.length > 0)
  controller.dispose()
})

testCase('构造失败回落也不抛异常（P10）', () => {
  const boom = {
    get channels() {
      throw new Error('宿主输入爆炸')
    },
  }
  let controller = null
  const prevError = console.error
  console.error = () => {} // 回落路径会打一条诊断日志，测试期静音
  try {
    controller = createMediaController(boom)
  } catch (e) {
    check('createMediaController MUST NOT 抛异常', false, String(e))
  } finally {
    console.error = prevError
  }
  check('回落对象仍可用', !!controller && typeof controller.getSummary === 'function')
  eq('回落对象无通道', controller.getSummary().total, 0)
  controller.dispose()
})

/* ================================================================== *
 * 13. MDP-CHN-04 运行时切换通道 20 次：无残留、无泄漏
 * ================================================================== */

testCase('连续切换通道 20 次：旧通道全释放、无残留出声、无在途排程（MDP-CHN-04）', () => {
  const { controller, timer } = mk({ audioPolicy: 'single' })
  const handled = new Map()
  const total = 20
  for (let i = 0; i < total; i++) {
    const id = `c${i}`
    controller.setChannels([{ id, name: id, kind: 'video', url: `/media/${id}.mp4` }])
    controller.play(id)
    advance(50)
    controller.reportMediaEvent(id, 'loadeddata', { w: 160, h: 90, durationMs: 5_000 })
    advance(50)
    controller.reportMediaEvent(id, 'playing')
    eq(`第 ${i + 1} 次切换后仅 1 路`, controller.getChannels().length, 1)
    eq(`第 ${i + 1} 次切换后 1 路出声`, controller.getAllStatus().filter((s) => s.audible).length, 1)
    handled.set(id, 1)
  }
  eq(`共装载 ${total} 个不同 id`, handled.size, total)
  eq('旧 id 全部不可查（无残留运行时）', controller.getStatus('c0'), null)
  eq('当前仅第 20 路', controller.getSummary().total, 1)
  eq('无残留出声', controller.getAllStatus().filter((s) => s.audible).length, 1)
  eq('释放后无遗留定时排程', timer.pendingCount(), 0)
  controller.stop('c19')
  eq('stop 后无路出声', controller.getAllStatus().filter((s) => s.audible).length, 0)
  controller.dispose()
  eq('dispose 后无排程', timer.pendingCount(), 0)
})

/* ================================================================== *
 * 14. MDP-PLY-02 定位超时（契约 §7.3）
 * ================================================================== */

testCase('定位超 seekTimeoutMs → Range 降级 + seekMs（MDP-PLY-02）', () => {
  const { controller } = mk({ seekTimeoutMs: 3_000 }, [VIDEO('a')])
  controller.play('a')
  controller.reportMediaEvent('a', 'loadeddata', { w: 160, h: 90, durationMs: 10_000 })
  controller.seek('a', 4_000)
  advance(2_999)
  eq('未到时限不降级', controller.getStatus('a').degraded.range, false)
  eq('未到时限 seekMs 仍为空', controller.getStatus('a').diagnostics.seekMs, null)
  advance(1)
  eq('到点判为 Range 降级', controller.getStatus('a').degraded.range, true)
  eq('seekMs = 实际等待', controller.getStatus('a').diagnostics.seekMs, 3_000)
  const again = controller.seek('a', 10)
  check('降级后 seek 仍执行且带可读提示', again.ok && again.message.includes('Range'))
  controller.dispose()
})

testCase('定位在时限内完成 → 不降级，seekMs 记实际耗时', () => {
  const { controller } = mk({ seekTimeoutMs: 3_000 }, [VIDEO('a')])
  controller.play('a')
  controller.reportMediaEvent('a', 'loadeddata', { w: 160, h: 90, durationMs: 10_000 })
  controller.seek('a', 4_000)
  advance(480)
  controller.reportMediaEvent('a', 'seeked', { positionMs: 4_000 })
  advance(60_000)
  const s = controller.getStatus('a')
  eq('不误判为 Range 降级', s.degraded.range, false)
  eq('seekMs 记实际耗时（NFR-01 拖动定位口径）', s.diagnostics.seekMs, 480)
  eq('位置落值', s.positionMs, 4_000)
  controller.dispose()
})

/* ================================================================== *
 * 15. MDP-DGR-03 单路失败隔离 + 退避重试（契约 §7.3）
 * ================================================================== */

testCase('解码失败退避重试 1s/2s、上限 2 次后停死（MDP-DGR-03）', () => {
  const { controller, timer } = mk({}, [VIDEO('a')])
  controller.play('a')
  controller.reportMediaEvent('a', 'error', { errorCode: 3002, reason: '解码失败' })
  eq('先进入 error（可查询）', controller.getStatus('a').state, 'error')
  eq('第 1 次重试排在 1s', timer.pendingCount(), 1)
  timer.advance(999)
  eq('999ms 仍在 error', controller.getStatus('a').state, 'error')
  timer.advance(1)
  eq('1000ms 回到 loading（可恢复）', controller.getStatus('a').state, 'loading')
  controller.reportMediaEvent('a', 'error', { errorCode: 3002, reason: '再次解码失败' })
  timer.advance(1_999)
  eq('第 2 次退避 2s：1999ms 仍在 error', controller.getStatus('a').state, 'error')
  timer.advance(1)
  eq('2001ms 回到 loading', controller.getStatus('a').state, 'loading')
  controller.reportMediaEvent('a', 'error', { errorCode: 3002, reason: '第三次失败' })
  eq('重试上限用尽（MAX_DECODE_RETRY=2）', MAX_DECODE_RETRY, 2)
  timer.advance(600_000)
  eq('超上限后停死在 error（MUST NOT 重试轰炸）', controller.getStatus('a').state, 'error')
  eq('重试次数记录进诊断', controller.getStatus('a').diagnostics.loadFailures, 3)
  controller.dispose()
})

testCase('策略类失败（3004）不进入重试循环', () => {
  const { controller, timer } = mk({}, [VIDEO('a')])
  controller.play('a')
  controller.reportMediaEvent('a', 'error', { errorCode: 3004, reason: '被策略拒绝' })
  advance(600_000)
  eq('停在 error 不重试', controller.getStatus('a').state, 'error')
  eq('无遗留排程', timer.pendingCount(), 0)
  controller.dispose()
})

testCase('自动播放被拒 → 降级不回 error、不循环重试（契约 §7.3）', () => {
  const { controller, timer } = mk({}, [VIDEO('a')])
  const degraded = []
  controller.subscribe((ev) => {
    if (ev.type === 'media.degraded') degraded.push(ev.data)
  })
  controller.play('a')
  controller.reportMediaCommandError('a', 'play', '浏览器拒绝自动播放')
  eq('回 ready（首帧可绘）', controller.getStatus('a').state, 'ready')
  eq('MUST NOT 进 error', controller.getStatus('a').errorCode, null)
  eq('发出 autoplay 降级事件', degraded.filter((d) => d.capability === 'autoplay').length >= 1, true)
  eq('不排重试', timer.pendingCount(), 0)
  advance(600_000)
  eq('长时间后仍不循环重试', controller.getStatus('a').state, 'ready')
  controller.dispose()
})

testCase('一路 404/失败不影响其余五路（MDP-DGR-03、CTR-MDP-EC-04）', () => {
  const { controller } = mk({}, [...chans(5), VIDEO('bad')])
  const others = ['c1', 'c2', 'c3', 'c4', 'c5']
  for (const id of others) {
    controller.play(id)
    controller.reportMediaEvent(id, 'loadeddata', { w: 160, h: 90, durationMs: 5_000 })
    controller.reportMediaEvent(id, 'playing')
  }
  controller.play('bad')
  advance(50)
  controller.reportMediaEvent('bad', 'error', { errorCode: 3001, reason: 'HTTP 404' })
  const bad = controller.getStatus('bad')
  eq('失败路 error', bad.state, 'error')
  eq('失败路错误码可读', bad.errorCode, 3001)
  check('失败路原因可读非空', typeof bad.reason === 'string' && bad.reason.length > 0)
  for (const id of others) {
    eq(`${id} 仍在播放`, controller.getStatus(id).state, 'playing')
    eq(`${id} 未被连带报错`, controller.getStatus(id).errorCode, null)
  }
  eq('五路可用性不变', controller.getSummary().usable, 6)
  eq('仅 1 路 error', controller.getSummary().states.error, 1)
  controller.dispose()
})

/* ================================================================== *
 * 16. MDP-OVL-04/05：内容框重算触发点、全屏基准、穿透配置
 * ================================================================== */

testCase('全屏不重建元素、进度连续、退出后基准恢复（MDP-PLY-05、OVL-04）', () => {
  const g = globalThis
  const prevWin = { w: g.innerWidth, h: g.innerHeight }
  const prevDoc = g.document
  let element = null
  g.innerWidth = 1_600
  g.innerHeight = 900
  g.document = {
    fullscreenElement: null,
    documentElement: { requestFullscreen: async () => {} },
    exitFullscreen: async () => {
      g.document.fullscreenElement = null
    },
  }
  const { controller } = mk({}, [VIDEO('a')])
  element = {
    requestFullscreen: async () => {
      g.document.fullscreenElement = element
    },
  }
  controller.setElement('a', element)
  controller.reportContainerSize('a', { w: 200, h: 200 })
  controller.reportMediaSize('a', { w: 1_600, h: 900 })
  const tileBox = controller.getViewState('a').box
  controller.play('a')
  controller.reportMediaEvent('a', 'loadeddata', { w: 1_600, h: 900, durationMs: 10_000 })
  controller.reportMediaEvent('a', 'playing')
  controller.reportMediaEvent('a', 'timeupdate', { positionMs: 2_500 })

  return controller.enterFullscreen('a').then((r) => {
    check('进入全屏成功', r.ok, JSON.stringify(r))
    eq('全屏态标记', controller.getStatus('a').fullscreen, true)
    eq('getFullscreen 一致', controller.getFullscreen(), 'a')
    const fsBox = controller.getViewState('a').box
    eq('全屏基准切到视口（contain 无黑边）', [fsBox.w, fsBox.h], [1_600, 900])
    return controller.exitFullscreen().then((e) => {
      check('退出全屏成功', e.ok)
      eq('退出后 fullscreen=false', controller.getStatus('a').fullscreen, false)
      eq('退出后回到 tile 基准（布局一致）', controller.getViewState('a').box, tileBox)
      eq('进度不丢', controller.getStatus('a').positionMs, 2_500)
      eq('媒体元素实例未被重建', controller.getElement('a'), element)
      // 外部退出（ESC）：视图层上报后基准与状态 MUST 一起收敛
      controller.reportFullscreenElement('a', true)
      eq('外部进入全屏：状态跟随', controller.getStatus('a').fullscreen, true)
      controller.reportFullscreenElement('a', false)
      eq('外部退出全屏：状态收敛', controller.getStatus('a').fullscreen, false)
      eq('外部退出后基准恢复', controller.getViewState('a').box, tileBox)
      controller.dispose()
      g.innerWidth = prevWin.w
      g.innerHeight = prevWin.h
      if (prevDoc === undefined) delete g.document
      else g.document = prevDoc
    })
  })
})

testCase('内容框重算触发点齐备（§8.3）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  // 用 boxRev（重算次数）而非 rev（box 是否变化）判定"触发点是否发生"
  const rev = () => controller.getViewState('a').boxRev
  const r0 = rev()
  controller.reportContainerSize('a', { w: 320, h: 180 })
  const r1 = rev()
  check('容器尺寸变化 → 重算（ResizeObserver 路径）', r1 > r0)
  controller.reportMediaSize('a', { w: 640, h: 360 })
  const r2 = rev()
  check('媒体实际尺寸到达 → 重算', r2 > r1)
  eq('重算后内容框为整容器（contain 同比）', controller.getViewState('a').box, { x: 0, y: 0, w: 320, h: 180 })
  controller.reportContainerSize('a', { w: 800, h: 450 })
  const r3 = rev()
  check('再次 resize → 重算', r3 > r2)
  eq('resize 后内容框跟随（等比、无错位）', controller.getViewState('a').box, { x: 0, y: 0, w: 800, h: 450 })
  // 源切换：媒体尺寸 MUST 失效，待新源 loadedmetadata 后重算
  controller.setChannels([{ id: 'a', name: 'a', kind: 'video', url: '/media/other.mp4', frameIntervalMs: 200 }])
  eq('换源后媒体尺寸失效', controller.getStatus('a').videoSize, null)
  eq('换源后回 idle', controller.getStatus('a').state, 'idle')
  controller.reportContainerSize('a', { w: 400, h: 400 })
  eq('换源后以容器为基准（尺寸未知）', controller.getViewState('a').box, { x: 0, y: 0, w: 400, h: 400 })
  controller.reportMediaSize('a', { w: 1_600, h: 900 })
  eq('新源尺寸到达后按新基准重算', controller.getViewState('a').box, { x: 0, y: 87.5, w: 400, h: 225 })
  // 全屏切换也是触发点（§8.3）
  const r4 = rev()
  controller.reportFullscreenElement('a', true)
  check('全屏态变化 → 重算', rev() > r4)
  controller.reportFullscreenElement('a', false)
  eq('退出全屏回 tile 基准', controller.getViewState('a').box, { x: 0, y: 87.5, w: 400, h: 225 })
  controller.dispose()
})

testCase('越界/非法框计入叠加层诊断，且不让整层失败（契约 §8.4）', () => {
  eq('无内容 → 0', countDroppedBoxes({}), 0)
  eq('合法框不计数', countDroppedBoxes({ boxes: [{ id: 'k', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] }), 0)
  eq(
    'NaN / Infinity / 零宽 各计一次',
    countDroppedBoxes({
      boxes: [
        { id: 'a', rect: { x: NaN, y: 0, w: 0.2, h: 0.2 } },
        { id: 'b', rect: { x: 0, y: 0, w: Infinity, h: 0.2 } },
        { id: 'c', rect: { x: 0.5, y: 0.5, w: 0, h: 0.2 } },
        { id: 'd', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      ],
    }),
    3,
  )
  eq(
    '完全越界算丢弃（MUST NOT 夹紧成边缘假框）',
    countDroppedBoxes({ boxes: [{ id: 'x', rect: { x: 2, y: 2, w: 0.1, h: 0.1 } }] }),
    1,
  )
  const { controller } = mk({}, [VIDEO('a')])
  controller.setOverlay('a', { boxes: [{ id: 'nan', rect: { x: NaN, y: 0, w: 1, h: 1 } }] })
  controller.reportDroppedBoxes(countDroppedBoxes(controller.getOverlay('a')))
  eq('诊断计数落值', controller.getDiagnosticSnapshot().droppedBoxes, 1)
  controller.reportDroppedBoxes(0)
  eq('零/负值不改变计数', controller.getDiagnosticSnapshot().droppedBoxes, 1)
  eq('通道状态仍可查（未整层失败）', controller.getStatus('a').state, 'idle')
  controller.dispose()
})

testCase('穿透配置：缺省 none，可切 auto，非法值保留原值（MDP-OVL-05）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  const ch = controller.getChannel('a')
  eq('缺省穿透', controller.getOptions().overlay.pointerEvents, 'none')
  eq('叠加项缺省为全部 6 项', ch.overlayKeys, [...OVERLAY_KEYS])
  check('切 auto', controller.setOptions({ overlay: { pointerEvents: 'auto' } }).ok)
  eq('auto 生效', controller.getOptions().overlay.pointerEvents, 'auto')
  const bad = controller.setOptions({ overlay: { pointerEvents: 'nope' } })
  check('非法值 → 1000', !bad.ok && bad.code === 1000)
  eq('非法值保留原值', controller.getOptions().overlay.pointerEvents, 'auto')
  controller.dispose()
})

/* ================================================================== *
 * 17. MDP-NFR-02：零外网（模块自身 MUST NOT 发起请求）
 * ================================================================== */

testCase('零外网：只允许同源 Range 能力探测，MUST NOT 请求外域（MDP-NFR-02、契约 §1.4）', () => {
  const g = globalThis
  const prevFetch = g.fetch
  const prevXhr = g.XMLHttpRequest
  const prevImage = g.Image
  const calls = []
  const allowProbe = (url) => typeof url === 'string' && url.startsWith('/media/')
  g.fetch = (url) => {
    calls.push(String(url))
    if (!allowProbe(url)) throw new Error(`本模块 MUST NOT 请求非素材地址：${String(url)}`)
    // 模拟"静态托管支持 Range"的探测响应
    return Promise.resolve({
      ok: true,
      status: 206,
      headers: { get: () => 'bytes' },
      arrayBuffer: async () => new ArrayBuffer(1),
    })
  }
  g.XMLHttpRequest = function XhrStub() {
    calls.push('XHR')
    throw new Error('本模块 MUST NOT 使用 XHR')
  }
  g.Image = function ImageStub() {
    calls.push('Image')
    throw new Error('本模块（机制层）MUST NOT 直接取图')
  }
  try {
    const { controller } = mk({}, [
      VIDEO('a'),
      { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 3 },
    ])
    controller.setChannels([VIDEO('a'), VIDEO('b')])
    controller.play('a')
    advance(120)
    controller.reportMediaEvent('a', 'loadeddata', { w: 160, h: 90, durationMs: 5_000 })
    controller.reportMediaEvent('a', 'timeupdate', { positionMs: 1_000 })
    controller.seek('a', 2_000)
    controller.getFrames('s')
    controller.getPreloadUrls('s')
    controller.getFrameUrl('s')
    controller.setOverlay('a', { magnification: '×4', boxes: [] })
    controller.getDiagnostics()
    controller.getSummary()
    controller.getDiagnosticSnapshot()
    controller.dispose()
    check(
      '除同源 Range 探测外无任何请求',
      calls.every((u) => allowProbe(u)),
      `calls=${JSON.stringify(calls)}`,
    )
    eq('未使用 XHR', calls.filter((u) => u === 'XHR').length, 0)
    eq('未直接取图', calls.filter((u) => u === 'Image').length, 0)

    // 注入 probe：MUST 完全取代内建探测（零 fetch）
    const probeCalls = []
    const injected = mk({}, [VIDEO('p')], {
      adapters: {
        probe: {
          probe: async (url) => {
            probeCalls.push(url)
            return { reachable: true, acceptRanges: true }
          },
        },
      },
    })
    const before = calls.length
    injected.controller.play('p')
    injected.controller.dispose()
    eq('注入 probe 后不再走内建 fetch', calls.length, before)
  } finally {
    if (prevFetch === undefined) delete g.fetch
    else g.fetch = prevFetch
    if (prevXhr === undefined) delete g.XMLHttpRequest
    else g.XMLHttpRequest = prevXhr
    if (prevImage === undefined) delete g.Image
    else g.Image = prevImage
  }
})

testCase('时间未注入时回落到真实时钟且不抛（P9 缺省行为）', () => {
  const before = Date.now()
  const controller = new MediaControllerImpl({
    channels: [{ id: 'v', name: 'v', kind: 'video', url: '/media/v.mp4' }],
  })
  const after = Date.now()
  const ts = controller.getDiagnostics().ts
  check('ts 落在真实时钟区间内', ts >= before && ts <= after, `before=${before} ts=${ts} after=${after}`)
  eq('未注入时仍为 epoch ms', Number.isFinite(ts) && ts > 1_000_000_000_000, true)
  const st = controller.getStatus('v')
  check('since 也是 epoch ms', st.since >= before && st.since <= after)
  check('播放仍可驱动', controller.play('v').ok)
  eq('状态推进', controller.getStatus('v').state, 'loading')
  controller.dispose()
})

/* ================================================================== *
 * 18. MDP-MUL-01/03/05：六路同屏、有界缓存、节流
 * ================================================================== */

testCase('六路同屏：6 路同时 playing、互不顶掉（MDP-MUL-01）', () => {
  const { controller } = mk({ maxChannels: 6 }, chans(6))
  eq('装载 6 路', controller.getChannels().length, 6)
  for (const c of controller.getChannels()) {
    controller.play(c.id)
    advance(150)
    controller.reportMediaEvent(c.id, 'loadeddata', { w: 160, h: 90, durationMs: 5_000 })
    advance(150)
    controller.reportMediaEvent(c.id, 'playing')
  }
  eq('六路全部 playing', controller.getSummary().states.playing, 6)
  eq('六路全部可见', controller.getSummary().visible, 6)
  eq('六路至多一路出声', controller.getAllStatus().filter((s) => s.audible).length, 1)
  eq('autoColumns(6) = 3', autoColumns(6), 3)
  controller.dispose()
})

testCase('有界缓存：pushFrame 超过 bufferLimitFrames 不增长（MDP-MUL-03、§9）', () => {
  const { controller } = mk({ bufferLimitFrames: 4 }, [
    { id: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 3, frameIntervalMs: 100 },
  ])
  for (let i = 1; i <= 40; i++) controller.pushFrame('s', `/media/live-${i}.png`)
  eq('缓冲被裁剪到上限', controller.getFrames('s').length, 4)
  eq('frameCount 同步收敛', controller.getChannel('s').frameCount, 4)
  eq('最新帧在首位', controller.getFrames('s')[0], '/media/live-40.png')
  eq('缓存内无重复帧', new Set(controller.getFrames('s')).size, 4)
  const idx = controller.getStatus('s').frameIndex
  check('当前帧下标仍在界内', idx >= 0 && idx < 4)
  controller.dispose()
})

testCase('显式帧数组 ≤ 上限时不被裁剪（模板帧不受上限影响）', () => {
  const { controller } = mk({ bufferLimitFrames: 4 }, [
    { id: 'e', kind: 'image-seq', frames: ['/a.png', '/b.png'] },
    { id: 't', kind: 'image-seq', url: '/media/f-{i:2}.png', frameCount: 9 },
  ])
  eq('显式帧全部可用（未超上限）', controller.getFrames('e'), ['/a.png', '/b.png'])
  eq('模板帧全部展开（bufferLimitFrames 不裁剪合成 URL）', controller.getFrames('t').length, 9)
  eq('末尾帧仍可解析（MDP-PLY-06 不停帧）', controller.getFrameUrl('t'), '/media/f-00.png')
  controller.dispose()
})

testCase('节流：throttleMs 内的密集事件被合并（MDP-MUL-05）', () => {
  const { controller } = mk({ throttleMs: 100 }, [VIDEO('a')])
  const frames = []
  controller.subscribe((ev) => {
    if (ev.type === 'media.state') frames.push(ev.data.state)
  })
  controller.play('a')
  for (let i = 0; i < 12; i++) {
    advance(5)
    controller.reportMediaEvent('a', 'timeupdate', { positionMs: i * 5 })
  }
  check('12 次 5ms 间隔的事件未被放大成 12 条 state', frames.length <= 3, `state=${frames.length}`)
  controller.dispose()
})

/* ================================================================== *
 * 19. 🚫 阶段名与演示数值零硬编码（R6 / §7）
 * ================================================================== */

testCase('源码常量表内不含任何具体通道名/URL/演示数值（MDP-CHN-02、R6）', () => {
  // 「可机检」口径：模块**常量**必须只含结构性取值，任何具体素材都只能由宿主注入。
  const opts = DEFAULT_OPTIONS
  eq('缺省列数用 auto（不写死 3 列）', opts.columns, 'auto')
  eq('缺省布局为 grid（结构性取值）', opts.layout, 'grid')
  eq('缺省不自动播放（演示开关归宿主）', opts.autoPlay, false)
  eq('缺省音量是结构性缺省而非某素材实测值', opts.defaultVolume, 0.8)
  eq('缺省倍速集', opts.rateOptions, [0.5, 1, 2])
  const { controller } = mk({}, [])
  eq('空清单控制器不产生任何通道', controller.getChannels(), [])
  eq('空清单 summary.total = 0', controller.getSummary().total, 0)
  controller.dispose()
})

testCase('叠加内容全部来自宿主注入，模块不产生业务语义（MDP-OVL-02）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  eq('未注入时不显示任何叠加项', controller.getOverlay('a'), {})
  check('未注入时 setOverlay 不报错', controller.setOverlay('a', {}).ok)
  eq('仍为空', controller.getOverlay('a'), {})
  const text = '任意宿主文本 ✦ ①②③'
  controller.setOverlay('a', {
    magnification: text,
    timestampText: text,
    channelName: text,
    sourceLabel: text,
    extra: [{ key: 'k', text }],
  })
  const got = controller.getOverlay('a')
  eq('任意文本原样渲染（不转义、不解释）', got.magnification, text)
  eq('时间戳文本原样', got.timestampText, text)
  eq('来源文本原样', got.sourceLabel, text)
  eq('自定义角标原样', got.extra[0].text, text)
  check('null 删除该项', controller.setOverlay('a', { magnification: null }).ok)
  eq('删除生效', controller.getOverlay('a').magnification, undefined)
  controller.dispose()
})

testCase('来源标识：不传不报错、任意字符串原样保留（MDP-CHN-05）', () => {
  const r = normalizeChannels([
    VIDEO('a'),
    VIDEO('b', { sourceLabel: '任意来源串-01' }),
    VIDEO('c', { sourceLabel: '' }),
  ])
  const by = Object.fromEntries(r.channels.map((c) => [c.id, c]))
  eq('不传 → null（不显示徽标）', by.a.sourceLabel, null)
  eq('任意字符串原样', by.b.sourceLabel, '任意来源串-01')
  eq('空串 → null（视同未传）', by.c.sourceLabel, null)
  check('全部条目仍可用（MUST NOT 报错）', r.channels.every((c) => c.available))
  const { controller } = mk({}, [VIDEO('a'), VIDEO('b', { sourceLabel: '任意来源串-01' })])
  eq('控制器内同样保留', controller.getChannel('b').sourceLabel, '任意来源串-01')
  eq('未传者为 null', controller.getChannel('a').sourceLabel, null)
  controller.dispose()
})

/* ================================================================== *
 * 20. MDP-DGR-04 诊断信息可读
 * ================================================================== */

testCase('诊断信息齐备：加载耗时 / 分辨率 / 缓冲次数 / 丢帧（MDP-DGR-04）', () => {
  const { controller } = mk({}, [VIDEO('a')])
  controller.play('a')
  advance(320)
  controller.reportMediaEvent('a', 'loadeddata', { w: 1_280, h: 720, durationMs: 20_000 })
  controller.reportMediaEvent('a', 'waiting')
  controller.reportMediaEvent('a', 'waiting')
  controller.reportMediaEvent('a', 'droppedframes', { count: 7 })
  const s = controller.getStatus('a')
  eq('加载耗时（loadMs）', s.diagnostics.loadMs, 320)
  eq('实际分辨率（videoSize）', s.videoSize, { w: 1_280, h: 720 })
  eq('缓冲次数', s.diagnostics.bufferingCount, 2)
  eq('丢帧次数', s.diagnostics.droppedFrames, 7)
  eq('时长', s.durationMs, 20_000)
  check('诊断时间戳可读（epoch ms）', s.diagnostics.updatedAt > 1_000_000_000_000)
  const d = controller.getDiagnostics()
  eq('全局诊断含通道明细', Object.keys(d.channels).sort(), ['a'])
  eq('全局诊断含 degradation 维度', Object.keys(d.degraded).sort(), ['range', 'throttled', 'visibility'])
  eq('聚合可用数', d.totals.usable, 1)
  controller.dispose()
})

testCase('一路 error 不影响其它路 + 时间戳仍为假时钟（故障隔离与可复现并重）', () => {
  const clock = makeClock(1_700_000_000_000)
  const t = makeTimer(clock)
  const controller = createMediaController(
    {
      channels: [VIDEO('ok'), VIDEO('bad')],
      adapters: { clock: clock.clock },
      options: { audioPolicy: 'none' },
    },
    { timer: t.timer },
  )
  controller.play('ok')
  controller.play('bad')
  clock.advance(100)
  controller.reportMediaEvent('ok', 'loadeddata', { w: 160, h: 90, durationMs: 1_000 })
  controller.reportMediaEvent('ok', 'playing')
  controller.reportMediaEvent('bad', 'error', { errorCode: 3001, reason: '404' })
  eq('正常路仍在 playing', controller.getStatus('ok').state, 'playing')
  eq('失败路 error', controller.getStatus('bad').state, 'error')
  eq('事件时间戳来自注入时钟', controller.getStatus('ok').diagnostics.updatedAt, 1_700_000_000_100)
  controller.dispose()
})



/* ================================================================== *
 * 21. 机检清单（--json）：给验收脚本一份"证据 → 结论"的结构化出口
 *
 * 为什么需要：验收脚本**不得**靠正则去猜测试输出里的中文用例名（改一个字就假阴性）。
 * 断言逻辑仍全部落在本文件（就在上面那些用例里），这里只是把结论按固定键导出。
 * ================================================================== */

/** 键 → 结论；值必须是可直接机检的标量或数组 */
const EVIDENCE = {}

function evidence(key, value) {
  EVIDENCE[key] = value
  return value
}

/** 字段是否存在（`null` 值也要算"存在"） */
function HasProp(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key)
}

testCase('机检证据：兼容形态 / 边界拒绝 / 超时与幂等（供 acceptance 读取）', () => {
  /* MDP-CHN-01 两类通道均可被列举与播放 */
  const twoKinds = createMediaController({
    channels: [
      { id: 'v', name: 'v', kind: 'video', url: '/media/v.mp4' },
      { id: 's', name: 's', kind: 'image-seq', url: '/media/{i}.png', frameCount: 3 },
    ],
    adapters: { clock: makeClock().clock },
  }, { timer: makeTimer(makeClock()).timer })
  evidence('channelKinds', twoKinds.getChannels().map((c) => c.kind))
  evidence('videoPlayable', twoKinds.play('v').ok)
  evidence('imageSeqPlayable', twoKinds.play('s').ok)
  evidence('missingFieldDefaultKind', normalizeChannels([{ name: 'n', url: '/media/n.mp4' }]).channels[0].kind)
  evidence('missingFieldNoThrow', normalizeChannels([null, 1, 'x', {}, { id: 'ok', url: '/media/ok.mp4' }]).ok)
  twoKinds.dispose()

  /* MDP-CHN-02 清单完全由宿主注入：换一份清单即换通道 */
  const srcA = createMediaController({ channels: [{ id: 'a1', url: '/media/a1.mp4' }] }, { timer: makeTimer(makeClock()).timer })
  const srcB = createMediaController({ channels: [{ id: 'b1', url: '/media/b1.mp4' }] }, { timer: makeTimer(makeClock()).timer })
  evidence('channelListFromHost', [
    srcA.getChannels().map((c) => c.id).join(','),
    srcB.getChannels().map((c) => c.id).join(','),
  ])
  srcA.dispose()
  srcB.dispose()

  /* MDP-CHN-03 既有接口 [{name,url}] 原样可消费 */
  const legacy = normalizeChannels([{ name: 'legacy-1', url: '/media/legacy-1.mp4' }])
  evidence('legacyShape', {
    kind: legacy.channels[0].kind,
    available: legacy.channels[0].available,
    id: legacy.channels[0].id,
  })

  /* MDP-CHN-05 来源标识：不传不报错、任意字符串原样 */
  evidence('sourceLabelAbsent', normalizeChannels([{ id: 'x', url: '/media/x.mp4' }]).channels[0].sourceLabel)
  evidence('sourceLabelArbitrary', normalizeChannels([{ id: 'y', url: '/media/y.mp4', sourceLabel: '任意串-9' }]).channels[0].sourceLabel)

  /* MDP-PLY-01 三个动作可由接口触发且状态可查询 */
  const ply = createMediaController({ channels: [VIDEO('p')] }, { timer: makeTimer(makeClock()).timer })
  const s1 = ply.play('p').ok
  const st1 = ply.getStatus('p').state
  const s2 = ply.pause('p').ok
  const st2 = ply.getStatus('p').state
  const s3 = ply.stop('p').ok
  const st3 = ply.getStatus('p').state
  evidence('playPauseStop', [s1, st1, s2, st2, s3, st3])
  /* 幂等 */
  const idem1 = ply.play('p')
  const idem2 = ply.play('p')
  evidence('idempotent', [idem1.code, idem1.idempotent === true, idem2.code, idem2.idempotent === true])
  /* 拒绝路径 */
  evidence('rejects', {
    unknownChannel: ply.play('nope').code,
    unavailable: ply.play('p').ok,
  })
  ply.dispose()

  /* MDP-PLY-02 Range 降级与定位超时（无 Range / 超时都必须给可读提示） */
  const rangeFail = createMediaController(
    {
      channels: [VIDEO('r')],
      adapters: {
        clock: makeClock().clock,
        probe: { probe: async () => ({ reachable: true, acceptRanges: false }) },
      },
    },
    { timer: makeTimer(makeClock()).timer },
  )
  rangeFail.play('r')
  rangeFail.reportMediaEvent('r', 'loadeddata', { w: 8, h: 8, durationMs: 1000 })
  // 探测是异步的：这里把"无 Range → 可读提示 + seek 不静默失败"的结论留给异步断言，
  // 待后面的 waitFor 收敛后再写回证据（同步读会拿到尚未落值的中间态）。
  evidence('seekWithoutRangeHint', 'pending')

  /* MDP-PLY-04 倍速与单帧步进：非法值拒绝 */
  const rate = createMediaController({ channels: [VIDEO('v')] }, { timer: makeTimer(makeClock()).timer })
  rate.play('v')
  rate.reportMediaEvent('v', 'loadeddata', { w: 8, h: 8, durationMs: 1000 })
  const step1 = rate.stepFrame('v', 1)
  const step2 = rate.stepFrame('v', 0)
  evidence('ratePolicy', {
    options: rate.getOptions().rateOptions,
    ok: rate.setRate('v', 0.5).ok,
    applied: rate.getStatus('v').rate,
    reject: rate.setRate('v', 3).code,
    stepOk: step1.ok && step2.code === 1000,
  })
  rate.dispose()

  /* MDP-OVL-01/02/05 叠加项与穿透缺省 */
  const ovl = createMediaController({ channels: [{ ...VIDEO('v'), overlayKeys: ['live'] }] }, { timer: makeTimer(makeClock()).timer })
  evidence('overlayToggle', [
    ovl.getChannel('v').overlayKeys.join(','),
    ovl.toggleOverlay('v', 'timestamp', false).ok,
    ovl.getChannel('v').overlayKeys.join(','),
    ovl.toggleOverlay('v', 'boxes', true).ok,
    ovl.getChannel('v').overlayKeys.join(','),
    ovl.toggleOverlay('v', 'nope').code,
  ])
  evidence('overlayInjectedAbsent', JSON.stringify(ovl.getOverlay('v')))
  evidence('pointerEventsDefault', ovl.getOptions().overlay.pointerEvents)
  evidence('pointerEventsSwitch', [
    ovl.setOptions({ overlay: { pointerEvents: 'auto' } }).ok,
    ovl.getOptions().overlay.pointerEvents,
    ovl.setOptions({ overlay: { pointerEvents: 'x' } }).code,
    ovl.getOptions().overlay.pointerEvents,
  ])
  ovl.dispose()

  /* MDP-OVL-03/04 归一化坐标不变式（含 resize 前后比例一致） */
  const box = { x: 20, y: 10, w: 640, h: 360 }
  const r = { x: 0.42, y: 0.32, w: 0.18, h: 0.26 }
  const back = pxToNorm(normToPx(r, box), box)
  evidence('normRoundTripMaxErr', Math.max(
    Math.abs(back.x - r.x), Math.abs(back.y - r.y), Math.abs(back.w - r.w), Math.abs(back.h - r.h),
  ))
  const rot = createMediaController({ channels: [VIDEO('v')] }, { timer: makeTimer(makeClock()).timer })
  rot.reportContainerSize('v', { w: 400, h: 300 })
  rot.reportMediaSize('v', { w: 160, h: 90 })
  const b1 = rot.getViewState('v').box
  const p1 = normToPx({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, b1)
  rot.reportContainerSize('v', { w: 800, h: 600 })
  const b2 = rot.getViewState('v').box
  const p2 = normToPx({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, b2)
  evidence('resizeProportional', [
    Math.abs((p2.x - b2.x) / (p1.x - b1.x) - 2) < 1e-9,
    Math.abs(p2.w / p1.w - 2) < 1e-9,
  ])
  evidence('droppedBoxes', [
    countDroppedBoxes({ boxes: [{ id: 'a', rect: { x: NaN, y: 0, w: 1, h: 1 } }] }),
    countDroppedBoxes({ boxes: [{ id: 'b', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }] }),
  ])
  rot.dispose()

  /* MDP-MUL-01/02/04/05 六路同屏 / 上限 / 主路 / 节流配置 */
  const mul = createMediaController(
    { channels: chans(8), options: { maxChannels: 6, audioPolicy: 'single' } },
    { timer: makeTimer(makeClock()).timer },
  )
  evidence('sixUp', [mul.getChannels().length, mul.getSummary().policyRejections])
  evidence('maxByKindConfigured', [
    mul.getOptions().maxChannelsByKind.video,
    mul.getOptions().maxChannelsByKind['image-seq'],
  ])
  evidence('mainSwitch', [
    mul.setMain('c2').ok,
    mul.getMain(),
    mul.setMain(null).ok,
    mul.getMain(),
  ])
  evidence('layoutSwitch', [mul.getLayout(), mul.setLayout('focus').ok, mul.getLayout(), mul.setLayout('x').code])
  evidence('throttleMs', mul.getOptions().throttleMs)
  mul.dispose()

  /* MDP-DGR-01/04 状态可观测与诊断字段 */
  const dgr = createMediaController({ channels: [VIDEO('v')] }, { timer: makeTimer(makeClock()).timer })
  dgr.play('v')
  dgr.reportMediaEvent('v', 'loadeddata', { w: 320, h: 180, durationMs: 2000 })
  dgr.reportMediaEvent('v', 'waiting')
  const ds = dgr.getStatus('v')
  // `reason` 在 ready 态为 null（错误痕迹已清空），因此用"类型可为 null、字段存在"
  // 与"六态闭集完整"两项判定状态可观测性，而不是强求 typeof reason === 'string'
  evidence('stateObservable', [
    ds.state,
    HasProp(ds, 'reason'),
    Object.keys(dgr.getSummary().states).join(','),
    typeof dgr.getAllStatus,
  ])
  evidence('diagnosticsFields', [
    ds.diagnostics.loadMs !== null,
    ds.videoSize.w,
    ds.diagnostics.bufferingCount,
    typeof ds.diagnostics.droppedFrames,
  ])
  dgr.dispose()

  /* MDP-DGR-02/03 空清单原因与故障隔离 */
  const empty = createMediaController({ channels: [] }, { timer: makeTimer(makeClock()).timer })
  evidence('emptyReason', empty.getSummary().emptyReason)
  const iso = createMediaController({ channels: [VIDEO('ok'), VIDEO('bad')] }, { timer: makeTimer(makeClock()).timer })
  iso.play('ok')
  iso.reportMediaEvent('ok', 'loadeddata', { w: 8, h: 8, durationMs: 10 })
  iso.reportMediaEvent('ok', 'playing')
  iso.play('bad')
  iso.reportMediaEvent('bad', 'error', { errorCode: 3001, reason: '404' })
  evidence('faultIsolation', [
    iso.getStatus('ok').state,
    iso.getStatus('bad').state,
    iso.getStatus('bad').errorCode !== null,
    typeof iso.getStatus('bad').reason === 'string',
  ])
  iso.dispose()
  empty.dispose()

  /* MDP-NFR-02 零外网：内建探测只对同源/相对地址发起（外域一律跳过，MUST NOT 请求） */
  evidence('externalProbeSkipped', isSameOriginOrRelative('https://cdn.example.com/a.mp4') === false)
  evidence('relativeProbeAllowed', isSameOriginOrRelative('/media/local.mp4') === true)
  evidence('protocolRelativeSkipped', isSameOriginOrRelative('//cdn.example.com/a.mp4') === false)

  // 异步收尾放最后：Range 探测落地后再把结论写回证据
  return waitFor(() => rangeFail.getStatus('r').degraded.range, 60).then(() => {
    const st = rangeFail.getStatus('r')
    const seekRes = rangeFail.seek('r', 100)
    EVIDENCE.seekWithoutRangeHint =
      st.degraded.range === true &&
      typeof st.degraded.hint === 'string' &&
      st.degraded.hint.length > 0 &&
      seekRes.ok &&
      /Range/.test(seekRes.message)
    EVIDENCE.seekImageSeqRejected = rangeFail.seek('r', 1).ok
    rangeFail.dispose()
  })
})

/* ================================================================== *
 * 汇总
 * ================================================================== */

// 抽取了 Promise 的用例需要等待收敛后再汇总
await new Promise((r) => setTimeout(r, 60))

const line = '─'.repeat(64)
console.log(line)
console.log(`media-player · selftest（零依赖）`)
console.log(`用例：${cases}　断言：${asserts}　失败：${failed}`)
console.log(line)
if (process.argv.includes('--json')) {
  console.log('EVIDENCE:' + JSON.stringify({ cases, asserts, failed, evidence: EVIDENCE }))
}
if (failed > 0) {
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error(`\n[selftest] 失败 ${failed} 项`)
  process.exit(1)
}
console.log('[selftest] 全绿 ✓')
process.exit(0)
