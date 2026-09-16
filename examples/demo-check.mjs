// media-player · 示例页验收（headless 浏览器，本地静态服务，零外网）
//
// 检查点（MDP-DGR-02/03、MDP-MUL-01/02、MDP-OVL-04）：
//   · 面板真的挂载（说明构建产物 + React 视图层可用）
//   · 6 路同屏渲染；第 7 路视频被 maxChannels 拒绝（不渲染、不静默丢）
//   · 坏链通道渲染**可读错误态**，且不影响其它路
//   · 叠加层与锁定框真的画出来了
//   · autoPlay=false 时无一路出声（'single' 策略下 ≤1 是硬约束）
//
// 用法：node examples/demo-check.mjs [--require]
//   --require：没有 Chrome/Edge 时判失败（退出码 1），否则跳过（退出码 0）

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, runChrome, serveStatic } from './_browser.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build', 'demo')

function check(name, condition, detail = '') {
  const ok = !!condition
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

async function main() {
  const requireChrome = process.argv.includes('--require')
  if (!existsSync(join(BUILD, 'index.html'))) {
    console.error('[demo-check] 缺少 build/demo/index.html：先运行 npm run build:demo')
    process.exit(1)
  }
  if (!existsSync(join(ROOT, 'demo', 'public', 'media', 'sample-1.mp4'))) {
    console.error('[demo-check] 缺少示例素材：先运行 node scripts/gen-placeholder-assets.mjs')
    process.exit(1)
  }

  const chrome = findChrome()
  if (!chrome) {
    console.log('[demo-check] 未找到 Chrome/Edge：跳过示例页验收')
    process.exit(requireChrome ? 1 : 0)
  }

  const port = 5275
  const server = await serveStatic(port, [
    { prefix: '/media/', dir: join(ROOT, 'demo', 'public', 'media') },
    { prefix: '/', dir: BUILD },
  ])
  console.log(`[demo-check] 本地静态服务 http://127.0.0.1:${port}/（仅 127.0.0.1）`)

  // 页面把自检结论写进 <pre id="demo-selfcheck">，这里读 DOM
  const { stdout, stderr, code } = await runChrome(
    chrome,
    `http://127.0.0.1:${port}/index.html?selfcheck=1`,
    { userDataDir: join(ROOT, '.chrome-demo-profile') },
  )
  server.close()

  const m = /RESULT:(\{[\s\S]*?\})<\/pre>/.exec(stdout)
  if (!m) {
    console.error(`[demo-check] 未取到页面自检结果（chrome exit=${code}）`)
    const tail = stderr.trim().split('\n').slice(-6).join('\n')
    if (tail) console.error(tail)
    process.exit(1)
  }
  const r = JSON.parse(m[1])
  console.log('[demo-check] 页面自检：', JSON.stringify(r))

  const results = [
    check('面板已挂载（构建产物可用）', r.playerMounted),
    check(
      `6 路同屏渲染（maxChannels=6）`,
      r.tiles.length === 6,
      `tiles=${r.tiles.length} ids=${r.tiles.map((t) => t.id).join(',')}`,
    ),
    check(
      '第 7 路视频被上限拒绝且不渲染',
      !r.tiles.some((t) => t.id === 'v7'),
      `ids=${r.tiles.map((t) => t.id).join(',')}`,
    ),
    check('坏链通道渲染可读错误态', r.errored >= 1, `errored=${r.errored}`),
    check(
      '单路失败不影响其它路（≥5 路非错误）',
      r.tiles.filter((t) => t.state !== 'error').length >= 5,
      `ok=${r.tiles.filter((t) => t.state !== 'error').length}`,
    ),
    check('叠加层已渲染（非错误路数）', r.overlays >= 5, `overlays=${r.overlays}`),
    check('锁定框已渲染（归一化坐标）', r.boxRects >= 1, `boxRects=${r.boxRects}`),
    check(
      "autoPlay=false → 'single' 策略下 0 路出声",
      !!r.totals && r.totals.audible === 0,
      `audible=${r.totals ? r.totals.audible : 'n/a'}`,
    ),
    check(
      '上限拒绝计入诊断（policyRejections ≥ 1）',
      !!r.summary && r.summary.policyRejections >= 1,
      `policyRejections=${r.summary ? r.summary.policyRejections : 'n/a'}`,
    ),
    check(
      '清单共 8 条（2 条被拒绝、6 条装载）',
      !!r.channels && r.channels.length === 6,
      `channels=${r.channels ? r.channels.length : 'n/a'}`,
    ),
  ]
  const failed = results.filter((x) => !x).length
  if (failed > 0) {
    console.error(`[demo-check] 失败 ${failed} 项`)
    process.exit(1)
  }
  console.log('[demo-check] 通过：示例页在本地静态服务下完整可用')
  process.exit(0)
}

main()
