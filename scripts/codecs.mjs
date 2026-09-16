// media-player · PNG 与 GIF 极简编码器（工具链，非模块源码）
//
// 零依赖实现，供 `gen-placeholder-assets.mjs` 生成本地占位素材：
//   · PNG —— zlib(deflate) + CRC32，真彩色无滤波
//   · GIF —— 中位切分调色板 + LZW，多帧动画（图像流"实时感"占位）

import { deflateSync } from 'node:zlib'

/* ================================================================== *
 * PNG
 * ================================================================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * RGB 像素缓冲 → PNG。
 * @param {{w:number,h:number,rgb:Uint8Array}} img
 * @returns {Buffer}
 */
export function encodePNG(img) {
  const { w, h, rgb } = img
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < w * 3; x++) raw[y * stride + 1 + x] = rgb[y * w * 3 + x]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/* ================================================================== *
 * GIF
 * ================================================================== */

/** 把多帧 RGB 量化到 ≤256 色（5bit/通道归并 + 最近邻回退） */
function quantize(frames, wanted = 256) {
  const buckets = new Map()
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 3) {
      const key = ((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3)
      const b = buckets.get(key)
      if (b) {
        b[0] += f[i]
        b[1] += f[i + 1]
        b[2] += f[i + 2]
        b[3] += 1
      } else {
        buckets.set(key, [f[i], f[i + 1], f[i + 2], 1])
      }
    }
  }
  const entries = [...buckets.values()]
    .map((b) => [Math.round(b[0] / b[3]), Math.round(b[1] / b[3]), Math.round(b[2] / b[3]), b[3]])
    .sort((a, b) => b[3] - a[3])
    .slice(0, wanted)
  const palette = entries.map((e) => [e[0], e[1], e[2]])
  const lut = new Int16Array(32768).fill(-1)
  palette.forEach((c, idx) => {
    lut[((c[0] >> 3) << 10) | ((c[1] >> 3) << 5) | (c[2] >> 3)] = idx
  })
  const nearest = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const hit = lut[key]
    if (hit >= 0) return hit
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < palette.length; i++) {
      const dr = palette[i][0] - r
      const dg = palette[i][1] - g
      const db = palette[i][2] - b
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    lut[key] = best
    return best
  }
  const indexed = frames.map((f) => {
    const out = new Uint8Array(f.length / 3)
    for (let i = 0, j = 0; i < f.length; i += 3, j++) out[j] = nearest(f[i], f[i + 1], f[i + 2])
    return out
  })
  return { palette, indexed }
}

/** GIF LZW 压缩（含 clear / end code） */
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize
  const end = clear + 1
  let codeSize = minCodeSize + 1
  let dict = new Map()
  const resetDict = () => {
    dict = new Map()
    for (let i = 0; i < clear; i++) dict.set(String(i), i)
    codeSize = minCodeSize + 1
  }
  resetDict()
  const out = []
  let cur = 0
  let curBits = 0
  const emit = (code) => {
    cur |= code << curBits
    curBits += codeSize
    while (curBits >= 8) {
      out.push(cur & 0xff)
      cur >>= 8
      curBits -= 8
    }
  }
  emit(clear)
  let next = end + 1
  let prefix = ''
  for (let i = 0; i < indices.length; i++) {
    const ch = indices[i]
    const key = prefix === '' ? String(ch) : `${prefix},${ch}`
    if (dict.has(key)) {
      prefix = key
      continue
    }
    if (prefix !== '') emit(dict.get(prefix))
    dict.set(key, next++)
    if (next > 1 << codeSize) {
      if (codeSize < 12) codeSize++
      else {
        emit(clear)
        resetDict()
        next = end + 1
      }
    }
    prefix = String(ch)
  }
  if (prefix !== '') emit(dict.get(prefix))
  emit(end)
  if (curBits > 0) out.push(cur & 0xff)
  const body = Buffer.from(out)
  const blocks = []
  for (let i = 0; i < body.length; i += 255) {
    const chunk = body.subarray(i, i + 255)
    blocks.push(Buffer.from([chunk.length]), chunk)
  }
  blocks.push(Buffer.from([0]))
  return Buffer.concat([Buffer.from([minCodeSize]), ...blocks])
}

/**
 * 多帧 → GIF89a（循环播放）。
 * @param {{w:number,h:number,frames:Uint8Array[],delayMs:number,loop?:number}} anim
 * @returns {Buffer}
 */
export function encodeGIF(anim) {
  const { w, h, frames, delayMs, loop = 0 } = anim
  const { palette, indexed } = quantize(frames)
  const gctSize = 1 << Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))))
  const parts = []
  parts.push(Buffer.from('GIF89a', 'ascii'))
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(w, 0)
  lsd.writeUInt16LE(h, 2)
  lsd[4] = 0xf0 | (Math.log2(gctSize) - 1)
  parts.push(lsd)
  const gct = Buffer.alloc(gctSize * 3)
  palette.forEach((c, i) => {
    gct[i * 3] = c[0]
    gct[i * 3 + 1] = c[1]
    gct[i * 3 + 2] = c[2]
  })
  parts.push(gct)
  parts.push(
    Buffer.from([
      0x21, 0xff, 0x0b,
      ...Buffer.from('NETSCAPE2.0', 'ascii'),
      0x03, 0x01, loop & 0xff, (loop >> 8) & 0xff, 0x00,
    ]),
  )
  const delayCs = Math.max(2, Math.round(delayMs / 10))
  for (const frame of indexed) {
    const gce = Buffer.alloc(8)
    gce[0] = 0x21
    gce[1] = 0xf9
    gce[2] = 0x04
    gce[3] = 0x04 // disposal = 1，无透明
    gce.writeUInt16LE(delayCs, 4)
    parts.push(gce)
    const desc = Buffer.alloc(10)
    desc[0] = 0x2c
    desc.writeUInt16LE(w, 5)
    desc.writeUInt16LE(h, 7)
    parts.push(desc)
    parts.push(lzwEncode(frame, 8))
  }
  parts.push(Buffer.from([0x3b]))
  return Buffer.concat(parts)
}
