// media-player · 素材解码抽样（零依赖，可选 Chrome）
//
// 目的：证明"本地生成的占位 mp4"真的能被解码，而不是只有文件头像 mp4。
// 手段：起一个只服务本目录的静态服务器（127.0.0.1，不出网），
//       用 headless Chrome 打开 examples/decode-probe.html 并 dump DOM 后解析结果。
//
// 用法：
//   node examples/decode-probe.mjs            # 无 Chrome 时自动跳过（退出码 0）
//   node examples/decode-probe.mjs --require  # 无 Chrome 视为失败（退出码 1）
//
// 为什么不用 file:// 直接打开：file:// 下的媒体解码受浏览器同源策略与安全提示影响，
// 结果不可复现；localhost HTTP 与宿主真实部署形态一致。

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

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

function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
}

/** 只服务 examples/ 与 demo/public/ 两个目录（不出网、不列目录） */
function serve(port) {
  const roots = [HERE, join(ROOT, 'demo', 'public')]
  const server = createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]
    const rel = decodeURIComponent(url).replace(/^\/+/, '')
    for (const root of roots) {
      const file = normalize(join(root, rel))
      if (!file.startsWith(normalize(root))) continue
      if (!existsSync(file) || !statSync(file).isFile()) continue
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': statSync(file).size,
        // 媒体必须可 Range：宿主部署义务 H-1 的最小实现（也验证 MDP-PLY-02 的前提）
        'Accept-Ranges': 'bytes',
      })
      res.end(readFileSync(file))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

function runChrome(chrome, url, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--virtual-time-budget=8000',
      '--dump-dom',
      '--user-data-dir=' + join(ROOT, '.chrome-profile'),
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
  const requireChrome = process.argv.includes('--require')
  const chrome = findChrome()
  const port = 5273
  if (!chrome) {
    console.log('[decode-probe] 未找到 Chrome/Edge：跳过解码抽样（素材由 scripts/gen-placeholder-assets.mjs 生成）')
    process.exit(requireChrome ? 1 : 0)
  }

  const videoPath = join(ROOT, 'demo', 'public', 'media', 'sample-1.mp4')
  if (!existsSync(videoPath)) {
    console.error('[decode-probe] 缺少素材：先运行 node scripts/gen-placeholder-assets.mjs')
    process.exit(1)
  }

  const server = await serve(port)
  console.log(`[decode-probe] 本地静态服务 http://127.0.0.1:${port}/decode-probe.html（仅 127.0.0.1，不出网）`)
  const { stdout, stderr, code } = await runChrome(chrome, `http://127.0.0.1:${port}/decode-probe.html`)
  server.close()

  const m = /RESULT:(\{.*?\})</.exec(stdout)
  if (!m) {
    console.error('[decode-probe] 未取到结果（chrome exit=' + code + '）')
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-5).join('\n'))
    process.exit(1)
  }
  const r = JSON.parse(m[1])
  console.log('[decode-probe] 结果：', JSON.stringify(r))
  const ok = r.videoReady && r.videoW > 0 && r.videoH > 0 && r.imgW > 0 && r.imgH > 0 && !r.error
  if (!ok) {
    console.error('[decode-probe] 失败：生成的占位素材未被浏览器成功解码')
    process.exit(1)
  }
  console.log(
    `[decode-probe] 通过：video ${r.videoW}×${r.videoH} / ${r.durationMs} ms / canPlayType=${r.canPlay}，img ${r.imgW}×${r.imgH}`,
  )
  process.exit(0)
}

main()
