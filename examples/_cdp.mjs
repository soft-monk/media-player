// media-player · 最小 CDP 会话（零依赖：Node 内置 WebSocket + fetch）
//
// 为什么需要它：有两条验收点**只能在真实交互下测**——
//   · MDP-PLY-05 全屏：Chrome 自 71 起要求 **transient user activation**，
//     脚本里的 `requestFullscreen()` 会被拒（"Permissions check failed"）；
//     必须由 CDP `Input.dispatchMouseEvent` 造出真实用户手势，或显式授予权限。
//   · MDP-NFR-01 帧率：headless 不驱动 `requestAnimationFrame`，
//     必须开**有头**窗口（真实合成器）才能测出 fps。
//
// 只连 127.0.0.1，只做本地页面操作，不发起任何外网请求（NFR-02）。

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 启动带调试端口的 Chrome，返回 `{ child, port, userDataDir, close() }` */
export async function launchChrome(chromePath, opts = {}) {
  const { headed = false, windowSize = '1280,720', extraArgs = [], timeoutMs = 120000 } = opts
  const userDataDir = mkdtempSync(join(tmpdir(), 'media-player-cdp-'))
  const args = [
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=Translate,MediaRouter',
    // 关闭"窗口遮挡检测"：否则窗口被遮挡时 Chrome 会把 rAF 降到近乎停摆，
    // 帧率与定位耗时都变成不可测（MDP-NFR-01 的采样前提）
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--window-size=${windowSize}`,
    ...(headed ? ['--window-position=-2400,-2400'] : ['--headless=new', '--disable-gpu']),
    `--user-data-dir=${userDataDir}`,
    ...extraArgs,
    'about:blank',
  ]
  const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => (stderr += d.toString()))

  const portFile = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  let port = null
  while (Date.now() < deadline) {
    try {
      const { readFileSync } = await import('node:fs')
      const txt = readFileSync(portFile, 'utf8').split('\n')
      if (txt[0] && Number(txt[0]) > 0) {
        port = Number(txt[0])
        break
      }
    } catch {
      /* 还没写出来 */
    }
    await sleep(60)
  }
  if (!port) {
    child.kill()
    throw new Error(`无法取得 DevTools 端口（stderr: ${stderr.trim().slice(-400)}）`)
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    setTimeout(() => {
      try {
        rmSync(userDataDir, { recursive: true, force: true })
      } catch {
        /* 忽略（Windows 上 profile 可能仍被占用） */
      }
    }, 500)
  }
  child.on('close', () => {
    closed = true
  })
  return { child, port, userDataDir, close }
}

/** 连上调试端口，开一个页面并包成 CDP 会话 */
export async function connectCdp(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  if (!res.ok) throw new Error(`无法新建调试目标：HTTP ${res.status}`)
  const target = await res.json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true })
  })

  let seq = 0
  const pending = new Map()
  const listeners = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`))
      else resolve(msg.result)
      return
    }
    const ls = listeners.get(msg.method)
    if (ls) for (const l of ls) l(msg.params)
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  return {
    ws,
    send,
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(fn)
    },
    /** 求值（返回 JSON 化结果） */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      })
      if (r.exceptionDetails) {
        throw new Error(`页面求值异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
      }
      return r.result.value
    },
    async navigate(url) {
      await send('Page.navigate', { url })
    },
    /** 授予权限（全屏 / 自动播放等不需要用户手势的路径） */
    async grantPermissions(permissions, origin) {
      await send('Browser.grantPermissions', { permissions, origin })
    },
    /** 造一次真实用户手势（真实鼠标按下/抬起），返回点击坐标 */
    async clickAt(x, y) {
      const base = { x, y, button: 'left', buttons: 1, clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await sleep(30)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
    },
    /** 等页面出现某个选择器 */
    async waitForSelector(selector, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const hit = await this.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)
        if (hit) return true
        await sleep(100)
      }
      return false
    },
    /** 等页面里某个表达式为真 */
    async waitFor(expression, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (await this.evaluate(`!!(${expression})`)) return true
        await sleep(100)
      }
      return false
    },
    close() {
      try {
        ws.close()
      } catch {
        /* 忽略 */
      }
    },
  }
}

export { sleep }
