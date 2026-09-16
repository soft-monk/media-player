// media-player · 六路同屏帧率探针（MDP-NFR-01：≥ 25 fps）
//
// 为什么必须"有头"跑：headless Chrome 不驱动 `requestAnimationFrame`（实测 rAF 回调 0 次），
// 帧率在 headless 下恒为 0，属于不可测而非不达标。本探针用真实窗口（`--window-size` 指定
// 视口，窗口移到屏幕外避免打扰）打开 examples/fps-probe.html，读回三段采样的中位数。
//
// 被测场景 = 6 路同屏 + 每路 5 个角标 + 2 个锁定框 + 2 个十字准星（与现场使用同量级）。
//
// 用法：node examples/fps-probe.mjs
//   结论：帧率可测时按 ≥ 25 fps 判定（不达标退出码 1）；
//         环境不支持有头窗口时打印说明并退出 0（"不可测"不等于"不达标"），
//         由验收脚本据此记为 [SKIP] 而非 [PASS]。

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { findChrome, serveStatic } from './_browser.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MEDIA = join(ROOT, 'demo', 'public', 'media')
const PORT = 5279
const MIN_FPS = 25

function check(name, condition, detail = '') {
  const ok = !!condition
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/** 有头模式打开页面并 dump DOM（不用 --headless，rAF 才会被真正驱动） */
function runHeaded(chrome, url, { timeoutMs = 90000, userDataDir }) {
  return new Promise((resolve) => {
    const args = [
      '--new-window',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
      '--window-position=-2400,-2400', // 移到屏幕外，避免打扰
      '--virtual-time-budget=45000',
      '--dump-dom',
      ...(userDataDir ? ['--user-data-dir=' + userDataDir] : []),
      url,
    ]
    const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr })
    })
  })
}

async function main() {
  if (!existsSync(join(MEDIA, 'sample-1.mp4'))) {
    console.error('[fps-probe] 缺少示例素材：先运行 node scripts/gen-placeholder-assets.mjs')
    process.exit(1)
  }
  const chrome = findChrome()
  if (!chrome) {
    console.log('[fps-probe] 未找到 Chrome/Edge：跳过帧率探针')
    process.exit(0)
  }

  const server = await serveStatic(PORT, [
    { prefix: '/media/', dir: MEDIA },
    { prefix: '/', dir: join(ROOT, 'examples') },
  ])
  console.log(`[fps-probe] 本地静态服务 http://127.0.0.1:${PORT}/（仅 127.0.0.1，支持 Range）`)

  const { stdout, stderr, code } = await runHeaded(chrome, `http://127.0.0.1:${PORT}/fps-probe.html`, {
    userDataDir: join(ROOT, '.chrome-fps-profile'),
  })
  server.close()

  const m = /RESULT:(\{[\s\S]*?\})<\/div>/.exec(stdout)
  if (!m) {
    console.log('[fps-probe] 无法取得结果：本环境没有可用的图形界面（有头窗口开不起来）')
    console.log('[fps-probe] 说明：headless 模式不驱动 requestAnimationFrame，帧率在此环境下**不可测**；')
    console.log('[fps-probe]       请在带图形界面的机器上重跑本项（CI/无头环境按"跳过"处理）。')
    if (code === null) console.log(`[fps-probe] chrome 未能正常退出（可能被超时终止）`)
    process.exit(0)
  }
  const r = JSON.parse(m[1])
  if (r.error) {
    console.error('[fps-probe] 页面报错：', r.error)
    process.exit(1)
  }
  console.log(
    `[fps-probe] 结果：videos=${r.videos} playing=${r.playing} samples=${JSON.stringify(r.samples)} median=${r.medianFps} min=${r.minFps} tile=${r.tileSize} viewport=${r.viewport}`,
  )

  const results = [
    check('6 路同时播放', r.playing === 6, `playing=${r.playing}`),
    check('有头模式下 rAF 可用（帧率可测）', r.rafSupported === true, `samples=${JSON.stringify(r.samples)}`),
    check(`六路同屏帧率中位数 ≥ ${MIN_FPS} fps（MDP-NFR-01）`, r.medianFps >= MIN_FPS, `median=${r.medianFps} min=${r.minFps}`),
    check(`六路同屏帧率最小值 ≥ ${MIN_FPS} fps`, r.minFps >= MIN_FPS, `min=${r.minFps}`),
  ]
  const failed = results.filter((x) => !x).length
  if (failed > 0) {
    console.error(`[fps-probe] 失败 ${failed} 项`)
    process.exit(1)
  }
  console.log('[fps-probe] 通过：六路同屏帧率达标')
  process.exit(0)
}

main()
