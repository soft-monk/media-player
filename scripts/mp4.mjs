// media-player · 极简 MP4（ISO BMFF）封装器（工具链，非模块源码）
//
// 用途：把浏览器 `VideoEncoder` 产出的 H.264 样本（AVCC 长度前缀）封装成
// 浏览器可播放的 `.mp4`。这样示例素材**完全在本机生成**：
//   · 不需要 ffmpeg / 任何外部二进制；
//   · 不产生任何外网请求（专篇 NFR-02 / R2）。
//
// 只实现"单视频轨 + 全 IDR + 单 chunk"这一最小可用子集；
// 字段长度严格按 ISO/IEC 14496-12 与 14496-15 写，长度错一个字节播放器就解不出来。

function u32(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v >>> 0, 0)
  return b
}

function box(type, ...payload) {
  const body = Buffer.concat(payload)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, 'ascii')
  return Buffer.concat([head, body])
}

function fullBox(type, version, flags, ...payload) {
  const vf = Buffer.alloc(4)
  vf[0] = version
  vf[1] = (flags >> 16) & 0xff
  vf[2] = (flags >> 8) & 0xff
  vf[3] = flags & 0xff
  return box(type, vf, ...payload)
}

/** 单位矩阵（16.16 / 2.30 定点，MP4 标准写法） */
function matrixIdentity() {
  return [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32)
}

/**
 * 封装单轨 mp4。
 *
 * @param {object} input
 * @param {number} input.width  显示宽
 * @param {number} input.height 显示高
 * @param {number} input.fps    帧率
 * @param {Uint8Array} input.avcC  AVCDecoderConfigurationRecord（WebCodecs 的 decoderConfig.description）
 * @param {Uint8Array[]} input.samples AVCC 样本（4 字节长度前缀 + NAL）
 * @param {boolean[]} [input.keyFlags] 每个样本是否关键帧（缺省全 true）
 * @returns {Buffer}
 */
export function muxMP4(input) {
  const { width, height, fps, avcC, samples } = input
  if (!avcC || avcC.length < 8) throw new Error('缺少 avcC（AVCDecoderConfigurationRecord）')
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('没有样本可封装')
  const keyFlags = input.keyFlags ?? samples.map(() => true)

  const timescale = Math.max(1, Math.round(fps * 1000))
  const sampleDelta = Math.round(1000 * 1000 / fps) // 每帧时长（以 timescale 为单位）
  const duration = (samples.length * sampleDelta * 1000) / timescale

  const sampleBufs = samples.map((s) => Buffer.from(s.buffer ?? s, s.byteOffset ?? 0, s.byteLength ?? s.length))
  const mdat = box('mdat', ...sampleBufs)

  // ── stbl
  const avc1 = box(
    'avc1',
    // VisualSampleEntry 固定字段 78 字节（不含 8 字节盒头）—— 少写 1 字节就会让
    // 播放器把 avcC 的盒头读成 compressorname 的一部分，解码直接失败。
    Buffer.alloc(6), // reserved
    Buffer.from([0, 1]), // data_reference_index
    Buffer.alloc(16), // pre_defined + reserved
    Buffer.from([(width >> 8) & 0xff, width & 0xff, (height >> 8) & 0xff, height & 0xff]),
    Buffer.from([0, 0x48, 0, 0]), // horizresolution
    Buffer.from([0, 0x48, 0, 0]), // vertresolution
    Buffer.alloc(4), // reserved
    Buffer.from([0, 1]), // frame_count
    Buffer.alloc(32), // compressorname
    Buffer.from([0, 0x18]), // depth = 24
    Buffer.from([0xff, 0xff]), // pre_defined = -1
    box('avcC', Buffer.from(avcC)),
  )
  const stsd = fullBox('stsd', 0, 0, u32(1), avc1)
  const stts = fullBox('stts', 0, 0, u32(1), u32(samples.length), u32(sampleDelta))
  const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1))
  const stsz = fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...sampleBufs.map((s) => u32(s.length)))
  // chunk_offset 指向文件里第一个样本的**首个字节**
  const ftyp = box('ftyp', Buffer.from('isom', 'ascii'), u32(512), Buffer.from('isomiso2avc1mp41', 'ascii'))
  const chunkOffset = ftyp.length + 8
  const stco = fullBox('stco', 0, 0, u32(1), u32(chunkOffset))
  const keyIdx = keyFlags.map((k, i) => (k ? i + 1 : 0)).filter((i) => i > 0)
  const stbl = box(
    'stbl',
    stsd,
    stts,
    stsc,
    stsz,
    stco,
    ...(keyIdx.length && keyIdx.length < samples.length
      ? [fullBox('stss', 0, 0, u32(keyIdx.length), ...keyIdx.map(u32))]
      : []),
  )

  // ── minf / mdia / trak / moov
  const minf = box('minf', fullBox('vmhd', 0, 1, Buffer.alloc(8)), box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))), stbl)
  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(timescale),
    u32(Math.round(duration)),
    Buffer.from([0x55, 0xc4, 0, 0]), // language 'und'
    Buffer.from([0, 0]),
  )
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('vide', 'ascii'), Buffer.alloc(12), Buffer.from('VideoHandler\0', 'ascii'))
  const mdia = box('mdia', mdhd, hdlr, minf)
  const tkhd = fullBox(
    'tkhd',
    0,
    3,
    u32(0),
    u32(0),
    u32(1),
    u32(0),
    u32(Math.round(duration)),
    Buffer.alloc(8),
    Buffer.from([0, 0, 0, 0]), // layer
    Buffer.from([0, 0, 0, 0]), // alternate_group
    Buffer.from([0, 0, 0, 0]), // volume（视频轨恒 0）
    Buffer.from([0, 0]), // reserved
    ...matrixIdentity(),
    u32((width * 65536) >>> 0),
    u32((height * 65536) >>> 0),
  )
  const trak = box('trak', tkhd, mdia)
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(1000),
    u32(Math.round(duration)),
    u32(0x00010000),
    Buffer.from([0x01, 0x00]), // volume
    Buffer.from([0, 0]),
    Buffer.alloc(8),
    ...matrixIdentity(),
    Buffer.alloc(24),
    u32(2),
  )
  return Buffer.concat([ftyp, mdat, box('moov', mvhd, trak)])
}

/** 极简只读检查：返回顶层盒列表（自检/验收用） */
export function listTopLevelBoxes(buf) {
  const out = []
  let off = 0
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    out.push({ type, size, off })
    if (size < 8) break
    off += size
  }
  return out
}
