// media-player · 交互式运行态探针驱动（有头窗口 + 真实用户手势，零外网）
//
// 为什么必须这样做：
//   · MDP-PLY-05 全屏：Chrome 自 71 起要求 **transient user activation**，
//     页面脚本直接 `requestFullscreen()` 会被拒（实测 "Permissions check failed"）。
//     本驱动经 CDP `Input.dispatchMouseEvent` 造一次**真实鼠标点击**，再让页面进入全屏。
//   · MDP-NFR-01 帧率：headless Chrome 不驱动 `requestAnimationFrame`（实测 0 次回调），
//     帧率只能在有头窗口（真实合成器）里采样。
//
// 覆盖：全屏 ↔ 退出（进度连续 / 元素复用 / 叠加层不错位）、六路同屏帧率、
//       六路同屏渲染与出声上限复核。
//
// 用法：node examples/interactive-probe.mjs [--require]
//   --require：全屏或帧率未达标 → 退出码 1；环境不支持有头窗口 → 打印说明并退出 0
//              （由验收脚本按 [SKIP] 处理，而非静默通过）

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, serveStatic } from './_browser.mjs'
import { connectCdp, launchChrome, sleep } from './_cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = join(ROOT, 'build', 'probe')
const MEDIA = join(ROOT, 'demo', 'public', 'media')
const PORT = 5281
const MIN_FPS = 25
const ALIGN_TOL = 1

function check(name, condition, detail = '') {
  const ok = !!condition
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

/** `--out <path>`：把读数 JSON 写成文件（验收脚本按文件读取，避免从混合输出里正则抠 JSON） */
function outPath() {
  const i = process.argv.indexOf('--out')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

function writeReport(steps) {
  const p = outPath()
  if (!p) return
  try {
    writeFileSync(p, JSON.stringify(steps, null, 1), 'utf8')
    console.log(`[interactive-probe] 读数已写入 ${p}`)
  } catch (e) {
    console.error(`[interactive-probe] 写入读数失败：${String(e)}`)
  }
}

/** 环境不支持有头窗口：打印说明并以 0 退出（保持"不可测 ≠ 不达标"，但绝不冒充 PASS） */
function unsupported(reason) {
  console.log(`[interactive-probe] 本环境无法完成交互式验收：${reason}`)
  console.log('[interactive-probe] 说明：全屏需要真实用户手势、帧率需要真实合成器（有头窗口）；')
  console.log('[interactive-probe]       请在带图形界面的机器上重跑，或接受本项记为 [SKIP]。')
  process.exit(0)
}

async function main() {
  const requireAll = process.argv.includes('--require')
  if (!existsSync(join(BUILD, 'interactive.html'))) {
    console.error('[interactive-probe] 缺少 build/probe/interactive.html：先运行 npm run build:probe')
    process.exit(1)
  }
  if (!existsSync(join(MEDIA, 'sample-1.mp4'))) {
    console.error('[interactive-probe] 缺少示例素材：先运行 node scripts/gen-placeholder-assets.mjs')
    process.exit(1)
  }
  const chrome = findChrome()
  if (!chrome) unsupported('未找到 Chrome/Edge')

  const server = await serveStatic(PORT, [
    { prefix: '/media/', dir: MEDIA },
    { prefix: '/', dir: BUILD },
  ])
  console.log(`[interactive-probe] 本地静态服务 http://127.0.0.1:${PORT}/（仅 127.0.0.1，支持 Range）`)

  let launched = null
  let cdp = null
  try {
    launched = await launchChrome(chrome, { headed: true, windowSize: '1000,760', extraArgs: ['--window-position=0,0'] })
  } catch (e) {
    server.close()
    unsupported(`无法启动有头浏览器（${String(e)}）`)
  }

  try {
    cdp = await connectCdp(launched.port)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    // 显式授予全屏权限（与真实用户手势双保险；手势仍是主要路径）
    await cdp.grantPermissions(['fullscreen'], `http://127.0.0.1:${PORT}`).catch(() => {})
    await cdp.navigate(`http://127.0.0.1:${PORT}/interactive.html`)
    if (!(await cdp.waitForSelector('[data-media-tile="v1"]', 20000))) {
      unsupported('页面未挂载出媒体面板（可能是有头窗口不可用）')
    }
    if (!(await cdp.waitFor('window.__IK_READY__ === true && typeof window.__IK_RUN__ === "function"', 20000))) {
      throw new Error('探针未就绪（__IK_READY__ / __IK_RUN__ 缺失）')
    }

    // ① 真实用户手势：CDP 鼠标点击页面上的触发器 → 打开 transient activation 窗口
    const rect = await cdp.evaluate(
      '(() => { const r = document.getElementById("ik-activate").getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 } })()',
    )
    await cdp.clickAt(rect.x, rect.y)
    console.log(`[interactive-probe] 已注入真实鼠标手势 @(${Math.round(rect.x)},${Math.round(rect.y)})`)

    // ② 触发探针（在 activation 有效期内先调 requestFullscreen；随后才是长耗时的帧率采样）
    await cdp.evaluate('window.__IK_RUN__()')
    // 先看全屏阶段是否收敛（这是本探针最关键的一步，也最快出结果）
    const fsStage = await cdp.waitFor(
      '(() => { const e = document.getElementById("ik-out"); return e && /fullscreenSettled/.test(e.textContent || "") })()',
      60000,
    )
    if (!fsStage) {
      const partial = await cdp
        .evaluate('document.getElementById("ik-out").textContent.slice(0, 400)')
        .catch(() => '(读取失败)')
      throw new Error(`全屏阶段未收敛，页面中间态：${partial}`)
    }
    if (!(await cdp.waitFor('!!window.__IK_RESULT__', 120000))) {
      const partial = await cdp
        .evaluate('document.getElementById("ik-out").textContent.slice(0, 400)')
        .catch(() => '(读取失败)')
      throw new Error(`帧率阶段未收敛，页面中间态：${partial}`)
    }
    const result = await cdp.evaluate('window.__IK_RESULT__')
    if (!result) throw new Error('未取到探针结果')
    if (result.error) throw new Error(`页面报错：${result.error}`)
    const s = result.steps
    // **先落盘再判定**：即使随后因为"帧率不可测"以退出码 2 结束，
    // 全屏 / 拖动定位 / 对齐这些已经测到的读数也必须可被验收脚本取到
    writeReport(s)

    console.log('[interactive-probe] 页面读数：')
    console.log(
      '  ' +
        JSON.stringify({
          playing: s.playingCount,
          playingDuringFps: s.playingDuringFps,
          fps: s.fpsSamples,
          fpsMedian: s.fpsMedian,
          fullscreen: s.fullscreenResult,
          settled: s.fullscreenSettled,
          align: [s.alignBeforeFullscreenWorst, s.alignInFullscreenWorst, s.alignAfterFullscreenWorst],
          fsGeom: s.alignInFullscreen,
          fsContainerWorst: s.fullscreenContainerWorst,
          viewport: s.viewport,
        }),
    )

    const finite = (v) => typeof v === 'number' && Number.isFinite(v)
    const results = [
      /* MDP-PLY-05 全屏 */
      check('六路同屏起播（≥5 路在播）', s.playingCount >= 5, `playing=${s.playingCount}`),
      check('真实手势下进入全屏成功（MDP-PLY-05）', s.fullscreenResult?.ok === true && s.fullscreenSettled === true, `${JSON.stringify(s.fullscreenResult)} settled=${s.fullscreenSettled}`),
      check('全屏元素为本通道 tile（含叠加层与控制条）', s.fullscreenElementIsTile === true),
      check('控制器全屏状态与本通道一致', s.fullscreenControllerId === 'v1', `id=${JSON.stringify(s.fullscreenControllerId)}`),
      check('全屏态叠加层与画面不错位（≤1px，MDP-OVL-04）', finite(s.alignInFullscreenWorst) && s.alignInFullscreenWorst <= ALIGN_TOL, `worst=${s.alignInFullscreenWorst}px stable=${s.fullscreenStable}`),
      check('全屏基准切到视口（画面按视口重算）', finite(s.alignInFullscreen?.boxW) && s.alignInFullscreen.boxW > 0 && Math.abs(s.alignInFullscreen.boxW - s.viewport.w) < 2, `box=${s.alignInFullscreen?.boxW}x${s.alignInFullscreen?.boxH} viewport=${s.viewport?.w}x${s.viewport?.h}`),
      check('全屏期间媒体元素复用（MUST NOT 重建）', s.elementReusedInFullscreen === true),
      check('退出全屏后进度连续', finite(s.progressAfterFullscreen) && s.progressAfterFullscreen >= s.progressBeforeFullscreen, `${s.progressBeforeFullscreen} → ${s.progressAfterFullscreen}`),
      check('退出后全屏状态收敛', s.fullscreenIdAfterExit === null && s.fullscreenFlagAfterExit === false),
      check('退出后布局/基准恢复（≤1px）', finite(s.alignAfterFullscreenWorst) && s.alignAfterFullscreenWorst <= ALIGN_TOL, `worst=${s.alignAfterFullscreenWorst}px`),
      check('退出后媒体元素复用', s.elementReusedAfterExit === true),

      /* MDP-PLY-02 / NFR-01 拖动定位（真实时钟；服务端支持 Range） */
      check('支持 Range → 未误判为降级', s.seekDegradedRange === false),
      check('拖动定位全部成功', Array.isArray(s.seekTimes) && s.seekTimes.every((x) => x.ms >= 0), JSON.stringify(s.seekTimes)),
      check(`拖动定位 ≤ 500 ms（MDP-PLY-02 / NFR-01）`, finite(s.seekWorstMs) && s.seekWorstMs >= 0 && s.seekWorstMs <= 500, `worst=${s.seekWorstMs}ms ${JSON.stringify(s.seekTimes)}`),

      /* MDP-NFR-01 帧率（窗口被遮挡/不可见时浏览器会降频，此时按"不可测"处理） */
      check(`六路同屏帧率中位数 ≥ ${MIN_FPS} fps（MDP-NFR-01）`, s.fpsMeasurable === true && s.fpsMedian >= MIN_FPS, `samples=${JSON.stringify(s.fpsSamples)} median=${s.fpsMedian} measurable=${s.fpsMeasurable} visibility=${s.visibilityState}`),
      check(`六路同屏帧率最小值 ≥ ${MIN_FPS} fps（含最差采样）`, s.fpsMeasurable === true && s.fpsMin >= MIN_FPS, `min=${s.fpsMin} samples=${JSON.stringify(s.fpsSamples)}`),
      check('帧率采样期间维持六路同屏播放', s.playingDuringFps >= 5, `playing=${s.playingDuringFps}`),
    ]

    const failed = results.filter((x) => !x).length
    if (failed > 0) {
      console.error(`[interactive-probe] 失败 ${failed} 项`)
      if (s.fpsMeasurable === false) {
        console.error('[interactive-probe] 说明：帧率不可测（窗口被遮挡/不可见时 rAF 会被降频）——')
        console.error('[interactive-probe]       请让浏览器窗口保持可见后重跑，或接受本项记为 [SKIP]。')
        process.exit(2)
      }
      process.exit(1)
    }
    console.log(`[interactive-probe] 通过：${results.length} 项交互式运行态检查（全屏 / 帧率 / 叠加层对齐）`)
    process.exit(0)
  } finally {
    cdp?.close()
    launched?.close()
    server.close()
    await sleep(200)
  }
}

main().catch((e) => {
  console.error('[interactive-probe] 异常：', e && e.stack ? e.stack : e)
  process.exit(1)
})
