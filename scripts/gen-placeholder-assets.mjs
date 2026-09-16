// media-player · 生成本地占位素材（零外网、零外部二进制）
//
// 产出目录：demo/public/media/**
//   sample-1..6.mp4    6 路视频 —— 由**浏览器自带 VideoEncoder** 产出真实 H.264 样本，
//                      再由本脚本用 scripts/mp4.mjs 封装为 mp4（不需要 ffmpeg）
//   seq/frame-000..011.png  图像流序列帧（url 模板 {i:3} 展开）
//   anim.gif           动图（图像序列的另一种形态）
//   frame-single.png   单帧 image-seq（无占位符的 url）
//   poster-1.png       加载中占位图
//
// 用法：node scripts/gen-placeholder-assets.mjs
//   --no-video   只生成 png/gif（无浏览器时可用；示例页的视频通道会显示可读错误态）
//
// ⚠️ 素材内容为**通用虚构图形**（渐变色块 / 网格 / 运动方块 / 进度条），不含任何业务文字。

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeGIF, encodePNG } from './codecs.mjs'
import { listTopLevelBoxes, muxMP4 } from './mp4.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'demo', 'public', 'media')
const ENCODER_PAGE = join(ROOT, 'scripts', 'assets-encoder.html')

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const findChrome = () => CHROME_CANDIDATES.find((p) => existsSync(p))

/* ------------------------------------------------------------------ *
 * 通用图形（PNG / GIF 用；色板与 assets-encoder.html 保持一致）
 * ------------------------------------------------------------------ */

const PALETTES = [
  [[12, 74, 110], [56, 189, 248]],
  [[17, 94, 89], [45, 212, 191]],
  [[76, 29, 149], [167, 139, 250]],
  [[124, 45, 18], [251, 146, 60]],
  [[30, 41, 59], [148, 163, 184]],
  [[113, 63, 18], [253, 224, 71]],
]

const lerp = (a, b, t) => a + (b - a) * t

function fillRect(img, w, h, x0, y0, rw, rh, color) {
  const xa = Math.max(0, Math.floor(x0))
  const ya = Math.max(0, Math.floor(y0))
  const xb = Math.min(w, Math.ceil(x0 + rw))
  const yb = Math.min(h, Math.ceil(y0 + rh))
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = (y * w + x) * 3
      img[i] = color[0]
      img[i + 1] = color[1]
      img[i + 2] = color[2]
    }
  }
}

/** 5×3 点阵数字（只画通用序号，无业务文字） */
const DIGITS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
}

function drawNumber(img, w, h, value, x0, y0, scale, color) {
  let cursor = x0
  for (const ch of String(Math.max(0, Math.floor(value)))) {
    const glyph = DIGITS[ch]
    if (!glyph) continue
    for (let gy = 0; gy < glyph.length; gy++) {
      for (let gx = 0; gx < glyph[gy].length; gx++) {
        if (glyph[gy][gx] !== '1') continue
        fillRect(img, w, h, cursor + gx * scale, y0 + gy * scale, scale, scale, color)
      }
    }
    cursor += 4 * scale
  }
}

/** 渲染一帧通用图形：对角渐变 + 网格 + 运动方块 + 进度条 + 序号 */
function renderFrame(size, opts) {
  const { w, h } = size
  const { t, palette, label } = opts
  const [c0, c1] = palette
  const img = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (x / w + y / h) / 2
      const i = (y * w + x) * 3
      img[i] = Math.round(lerp(c0[0], c1[0], k))
      img[i + 1] = Math.round(lerp(c0[1], c1[1], k))
      img[i + 2] = Math.round(lerp(c0[2], c1[2], k))
    }
  }
  for (let x = 0; x < w; x += Math.max(8, Math.round(w / 8))) fillRect(img, w, h, x, 0, 1, h, [226, 232, 240])
  for (let y = 0; y < h; y += Math.max(8, Math.round(h / 8))) fillRect(img, w, h, 0, y, w, 1, [226, 232, 240])
  const phase = t < 0.5 ? t * 2 : (1 - t) * 2
  const boxW = Math.max(8, Math.round(w / 8))
  const boxH = Math.max(8, Math.round(h / 8))
  const bx = Math.round(lerp(2, w - boxW - 2, phase))
  const by = Math.round(h / 2 - boxH / 2)
  fillRect(img, w, h, bx, by, boxW, boxH, [255, 255, 255])
  fillRect(img, w, h, bx + 2, by + 2, Math.max(1, boxW - 4), Math.max(1, boxH - 4), [17, 24, 39])
  const barY = h - Math.max(4, Math.round(h / 16))
  const barH = Math.max(2, Math.round(h / 32))
  fillRect(img, w, h, 0, barY, w, barH, [15, 23, 42])
  fillRect(img, w, h, 0, barY, Math.round(w * t), barH, [56, 189, 248])
  drawNumber(img, w, h, label, Math.round(w / 16), Math.round(h / 16), Math.max(2, Math.round(w / 64)), [250, 250, 250])
  return img
}

function writeOut(rel, buf) {
  const abs = join(OUT, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, buf)
  return buf.length
}

/* ------------------------------------------------------------------ *
 * 浏览器编码：H.264 样本 → mp4
 * ------------------------------------------------------------------ */

const MIME = { '.html': 'text/html; charset=utf-8' }

function startServer(port, onPayload) {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/__assets') {
      let body = ''
      req.on('data', (d) => (body += d.toString()))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('ok')
        try {
          onPayload(JSON.parse(body))
        } catch (e) {
          onPayload({ error: String(e) })
        }
      })
      return
    }
    if (req.method === 'POST' && req.url === '/__progress') {
      req.resume()
      res.writeHead(204)
      res.end()
      return
    }
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'assets-encoder.html'
    const file = join(ROOT, 'scripts', rel.split('?')[0])
    if (!file.startsWith(join(ROOT, 'scripts')) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/** 启动 headless 浏览器；返回可控句柄（拿到回传后立即关掉，不必等超时） */
function launchChrome(chrome, url, timeoutMs) {
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--user-data-dir=' + join(ROOT, '.chrome-assets-profile'),
      url,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let stderr = ''
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stderr })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stderr })
    })
  })
  const kill = () => {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }
  return { done, kill }
}

async function encodeVideosWithBrowser() {
  const chrome = findChrome()
  if (!chrome) return { ok: false, reason: '未找到 Chrome/Edge（可用 --no-video 跳过视频素材）' }
  const port = 5274
  let payload = null
  const server = await startServer(port, (p) => (payload = p))
  try {
    const browser = launchChrome(
      chrome,
      `http://127.0.0.1:${port}/assets-encoder.html?channels=6&frames=10&fps=8`,
      60000,
    )
    // 编码完成即回传；回传一到就关掉浏览器，不再空等超时
    const deadline = Date.now() + 60000
    while (payload === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }
    browser.kill()
    const { code } = await browser.done
    if (!payload) return { ok: false, reason: `浏览器未回传数据（exit=${code}）` }
    if (payload.error) return { ok: false, reason: `浏览器编码失败：${payload.error}` }
    const sizes = []
    for (let i = 0; i < payload.channels.length; i++) {
      const c = payload.channels[i]
      const mp4 = muxMP4({
        width: c.width,
        height: c.height,
        fps: c.fps,
        avcC: Buffer.from(c.avcC, 'base64'),
        samples: c.samples.map((s) => Buffer.from(s, 'base64')),
        keyFlags: c.keyFlags,
      })
      const boxes = listTopLevelBoxes(mp4).map((b) => b.type)
      if (!boxes.includes('ftyp') || !boxes.includes('moov') || !boxes.includes('mdat')) {
        return { ok: false, reason: `通道 ${i + 1} 封装结果缺少必要盒（${boxes.join(',')}）` }
      }
      sizes.push(writeOut(`sample-${i + 1}.mp4`, mp4))
    }
    return { ok: true, count: payload.channels.length, sizes }
  } finally {
    server.close()
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  const skipVideo = process.argv.includes('--no-video')
  const generated = []
  const started = Date.now()

  mkdirSync(OUT, { recursive: true })

  // ── 视频（浏览器编码 + Node 封装）
  if (!skipVideo) {
    const r = await encodeVideosWithBrowser()
    if (r.ok) {
      for (let i = 0; i < r.count; i++) generated.push({ rel: `sample-${i + 1}.mp4`, size: r.sizes[i] })
    } else {
      console.warn(`[assets] 视频素材跳过：${r.reason}`)
    }
  } else {
    console.log('[assets] --no-video：跳过 mp4 生成')
  }

  // ── 序列帧（12 帧 PNG，演示 {i:3} 模板）
  for (let f = 0; f < 12; f++) {
    const buf = encodePNG({
      w: 160,
      h: 90,
      rgb: renderFrame({ w: 160, h: 90 }, { t: f / 12, palette: PALETTES[1], label: 700 + f }),
    })
    generated.push({ rel: `seq/frame-${String(f).padStart(3, '0')}.png`, size: writeOut(`seq/frame-${String(f).padStart(3, '0')}.png`, buf) })
  }

  // ── 动图
  const gifFrames = []
  for (let f = 0; f < 16; f++) {
    gifFrames.push(renderFrame({ w: 160, h: 90 }, { t: f / 16, palette: PALETTES[5], label: 800 + f }))
  }
  generated.push({
    rel: 'anim.gif',
    size: writeOut('anim.gif', encodeGIF({ w: 160, h: 90, frames: gifFrames, delayMs: 80 })),
  })

  // ── 单帧与海报
  generated.push({
    rel: 'frame-single.png',
    size: writeOut('frame-single.png', encodePNG({ w: 160, h: 90, rgb: renderFrame({ w: 160, h: 90 }, { t: 0.25, palette: PALETTES[4], label: 55 }) })),
  })
  generated.push({
    rel: 'poster-1.png',
    size: writeOut('poster-1.png', encodePNG({ w: 160, h: 90, rgb: renderFrame({ w: 160, h: 90 }, { t: 0, palette: PALETTES[0], label: 0 }) })),
  })

  const totalKb = (generated.reduce((s, g) => s + g.size, 0) / 1024).toFixed(1)
  console.log(`[assets] 生成 ${generated.length} 个本地占位素材 → ${OUT}`)
  for (const g of generated) console.log(`  · ${g.rel.padEnd(26)} ${(g.size / 1024).toFixed(1)} KiB`)
  console.log(`[assets] 合计 ${totalKb} KiB，用时 ${Date.now() - started} ms`)
}

export { renderFrame, PALETTES, OUT as ASSET_DIR, findChrome }

main().catch((e) => {
  console.error('[assets] 生成失败：', e)
  process.exitCode = 1
})
