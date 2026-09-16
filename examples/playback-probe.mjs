// media-player · 6 路真播自检（headless 浏览器，本地静态服务，零外网）
//
// 为什么要单独有一个：素材"能被解码"与"6 路能一起播、单路坏了不影响别人"是两件事。
// 这里直接驱动 7 个 <video>（6 好 + 1 坏），验证：
//   · 6 路同时播放且 currentTime 真的在前进；
//   · 第 7 路（404）只报自己的错，不影响其余 6 路。
//
// 用法：node examples/playback-probe.mjs [--require]
//   --require：没有 Chrome/Edge 时判失败，否则跳过（退出码 0）

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, runChrome, serveStatic } from './_browser.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function check(name, condition, detail = '') {
  const ok = !!condition
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

async function main() {
  const requireChrome = process.argv.includes('--require')
  const mediaDir = join(ROOT, 'demo', 'public', 'media')
  if (!existsSync(join(mediaDir, 'sample-1.mp4'))) {
    console.error('[playback-probe] 缺少素材：先运行 node scripts/gen-placeholder-assets.mjs')
    process.exit(1)
  }

  const chrome = findChrome()
  if (!chrome) {
    console.log('[playback-probe] 未找到 Chrome/Edge：跳过 6 路真播自检')
    process.exit(requireChrome ? 1 : 0)
  }

  const port = 5276
  const server = await serveStatic(port, [
    { prefix: '/media/', dir: mediaDir },
    { prefix: '/', dir: join(ROOT, 'examples') },
  ])
  console.log(`[playback-probe] 本地静态服务 http://127.0.0.1:${port}/（仅 127.0.0.1）`)

  const { stdout, stderr, code } = await runChrome(
    chrome,
    `http://127.0.0.1:${port}/playback-probe.html`,
    { userDataDir: join(ROOT, '.chrome-playback-profile'), timeoutMs: 90000 },
  )
  server.close()

  const m = /RESULT:(\{[\s\S]*?\})<\/pre>/.exec(stdout)
  if (!m) {
    console.error(`[playback-probe] 未取到结果（chrome exit=${code}）`)
    const tail = stderr.trim().split('\n').slice(-5).join('\n')
    if (tail) console.error(tail)
    process.exit(1)
  }
  const r = JSON.parse(m[1])
  if (r.error) {
    console.error('[playback-probe] 页面报错：', r.error)
    process.exit(1)
  }
  console.log(`[playback-probe] 结果：playing=${r.playing} advanced=${r.advanced} errored=${r.errored} size=${r.size} 用时=${r.ms}ms`)

  const results = [
    check('6 路同时播放', r.playing === 6, `playing=${r.playing}`),
    check('6 路 currentTime 均在前进', r.advanced === 6, `advanced=${r.advanced}`),
    check('实际分辨率正确', r.size === '160x90', `size=${r.size}`),
    check('坏链通道只影响自己（1 路报错）', r.errored === 1, `errored=${r.errored}`),
    check('坏链通道确有可读错误码', typeof r.badError === 'number' && r.badError > 0, `err=${r.badError}`),
  ]
  if (results.filter((x) => !x).length > 0) {
    console.error('[playback-probe] 失败')
    process.exit(1)
  }
  console.log('[playback-probe] 通过：6 路真播 + 单路失败隔离')
  process.exit(0)
}

main()
