// media-player · 浏览器自检的公共设施（本地静态服务 + Chrome 定位）
//
// 只服务 127.0.0.1，只读本地文件；不做任何外网请求（专篇 NFR-02）。

import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

/** 找到本机 Chrome/Edge；找不到返回 null（调用方决定是跳过还是失败） */
export function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
}

/**
 * 启动本地静态服务。
 *
 * **支持 Range**（宿主部署义务 H-1）：`Range: bytes=a-b` → `206 Partial Content` +
 * `Content-Range`。没有它，`<video>` 无法定位（拖动进度失效），MDP-PLY-02 的
 * "拖动定位"类断言就只能在"服务端不支持 Range"的假前提下跑，等于没测。
 *
 * @param {number} port
 * @param {Array<{prefix:string, dir:string}>} mounts 前缀 → 目录（按顺序匹配）
 * @returns {Promise<import('node:http').Server>}
 */
export function serveStatic(port, mounts) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    for (const mount of mounts) {
      let rel = null
      if (mount.prefix === '/') {
        rel = url.replace(/^\/+/, '')
      } else if (url.startsWith(mount.prefix)) {
        rel = url.slice(mount.prefix.length)
      } else {
        continue
      }
      if (rel === '' || rel.endsWith('/')) rel += 'index.html'
      const file = normalize(join(mount.dir, rel))
      const root = normalize(mount.dir)
      if (!file.startsWith(root + sep) && file !== root) continue
      if (!existsSync(file) || !statSync(file).isFile()) continue

      const size = statSync(file).size
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
      const range = parseRange(req.headers.range, size)
      if (range === 'invalid') {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` })
        res.end()
        return
      }
      if (range) {
        const { start, end } = range
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Cache-Control': 'no-store',
        })
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        const buf = readFileSync(file).subarray(start, end + 1)
        res.end(buf)
        return
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': size,
        // 宿主部署义务 H-1 的最小实现：媒体静态托管 MUST 支持 Range
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found')
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/**
 * 解析单区间 Range 头。
 * @returns {{start:number,end:number}|null|'invalid'} null = 无 Range（走 200）
 */
function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return 'invalid'
  let start
  let end
  if (rawStart === '') {
    // 后缀区间：最后 N 字节
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start >= size) return 'invalid'
  end = Math.min(end, size - 1)
  if (end < start) return 'invalid'
  return { start, end }
}

/**
 * 用 headless 浏览器打开页面并 dump DOM。
 *
 * `virtualTimeBudgetMs`：headless 的虚拟时间预算。页面里 `setTimeout` 驱动的等待会被
 * 虚拟时间"快进"（因此长探针不需要真实等待同等时长）；`requestAnimationFrame` 仍按真实
 * 时间推进，故帧率类测量有效。
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runChrome(chrome, url, opts = {}) {
  const {
    timeoutMs = 60000,
    userDataDir = null,
    extraArgs = [],
    virtualTimeBudgetMs = 10000,
  } = opts
  return import('node:child_process').then(
    ({ spawn }) =>
      new Promise((resolve) => {
        const args = [
          '--headless=new',
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--mute-audio',
          '--autoplay-policy=no-user-gesture-required',
          `--virtual-time-budget=${virtualTimeBudgetMs}`,
          '--dump-dom',
          ...(userDataDir ? ['--user-data-dir=' + userDataDir] : []),
          ...extraArgs,
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
      }),
  )
}
