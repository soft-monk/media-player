# media-player · 载荷媒体与图像流播放

> **多路图像流是至少四处界面的主体内容，却与业务面板同层，无法独立压测与交付。**
> 本模块把它抽成**独立可构建、可运行、可自测、可整包交付**的前端模块。

| 项 | 内容 |
|---|---|
| 栈 | TypeScript + React 18 + Vite（对齐 `map-2d`） |
| 运行时依赖 | **零**（`dependencies: {}`；`react` / `react-dom` 走 `peerDependencies`） |
| 唯一入口 | `src/index.ts` |
| 交付形态 | 可构建 npm 包（`dist/`）+ 独立示例页（`build/demo/**`）+ 零依赖自测（`tests/unit-test.mjs`）+ 独立验收脚本（`scripts/acceptance.ps1`，退出码 0/1） |
| 红线 | **MUST NOT import `map-2d` / `ws-client` / 其它任何模块**；源码零业务词；零外网请求 |
| 文档 | 需求：[`docs/需求/media-player需求专篇.md`](docs/需求/media-player需求专篇.md)　契约：[`docs/契约/media-player契约.md`](docs/契约/media-player契约.md)　实现说明：[`docs/实现/实现说明.md`](docs/实现/实现说明.md) |

---

## 它解决什么问题

给我一路或几路画面，我怎么**稳定地放出来、叠上必要的标记、并在没有画面时不添乱**。

它不回答"这路画面属于哪个单位、该和地图怎么联动"——那是宿主与业务装配的事。
`map-2d` 画地图，本模块画画面；两者**互不 import**，同屏由宿主负责。

## 做 / 不做

| 做 | 不做 |
|---|---|
| 通道与源（本地 mp4 / jpg·png 序列帧） | 不做地图（禁止 import 地图模块） |
| 播放控制（播放/暂停/停止/进度/音量/静音/倍速/单帧/循环/全屏） | 不做业务语义（通道名/来源/倍率/时间戳文本全部注入） |
| 多路同屏（≥6 路）与节流、主路与出声仲裁 | 不做远程流接入（RTSP/GB28181，仅留扩展点） |
| 叠加层（实时标识/倍率/时间戳/通道名/来源徽标/归一化锁定框） | 不做转码与推流、不做录制归档 |
| 无素材降级（隐藏入口）与状态可观测、失败隔离 | 不做画面坐标 ↔ 地图坐标换算（两家都不做） |

## 快速开始

```bash
npm install
npm run gen:assets     # 生成示例素材（本地、零外网、不需要 ffmpeg）
npm run build          # 类型检查 + 库构建 + 示例页构建
npm test               # 零依赖自测（node 直接跑，不引测试框架）
npm run accept         # 独立验收（退出码 0/1）
npm run dev            # 独立示例页：http://127.0.0.1:5181/
```

## 最小用法（3 行）

```tsx
import { MediaPlayer } from '@mapapp/media-player'

<MediaPlayer
  channels={[{ name: '通道 1', url: '/media/a.mp4' }]}   // 既有接口 [{name,url}] 原样可用
  mainChannelId="通道 1"
  options={{ audioPolicy: 'single', maxChannels: 6 }}     // 6 路同屏、至多一路出声
  overlays={{ byChannel: { '通道 1': { live: true, magnification: '×4' } } }}
/>
```

清单为空时组件**返回 `null`**（不渲染空面板/黑框），原因经 `onEmpty` 交给宿主在模块之外提示。

## 目录

```
src/
  index.ts              唯一公开入口（组件 4 / Hook 1 / 工厂 1 / 纯函数 7 / 常量 8 / 类型 42+）
  core/                 机制层：MUST NOT import react，可在 node 直接跑
    types.ts            公开类型面（契约 §2.5）
    controller.ts       控制器（契约 §2.3 的 37 项成员）
    normalize.ts        清单归一化（三种兼容输入、部分成功、schema 版本）
    frames.ts           帧模板展开（{i} / {i:N}）
    geometry.ts         内容框与归一化坐标（叠加层对齐的唯一来源）
    audio.ts            出声仲裁（'single'/'all'/'none'）
    status.ts           状态与诊断汇总
    emitter.ts          事件信封 + 限频 + 环形缓冲
    errors.ts           错误码与结果信封（失败不抛异常）
    constants.ts        常量与 DEFAULT_OPTIONS（逐字实现契约默认表）
    adapters.ts         IClock / IChannelSource / IMediaProbe 的缺省实现
    viewport.ts         控制器 ↔ 视图的最小接口
  react/                视图层：唯一允许依赖 react 的地方
    MediaPlayer.tsx     面板入口（空清单隐藏、网格/主路聚焦）
    MediaTile.tsx       单通道卡（媒体元素复用、可读错误态、失败隔离）
    MediaOverlay.tsx    叠加层（内容框基准、归一化锁定框、穿透）
    MediaControls.tsx   控制条（所有动作走控制器）
    useMediaPlayer.ts   Hook（卸载即 dispose、事件驱动汇总）
demo/                   独立示例宿主（素材全本地）
examples/               运行态自检：素材解码抽样 + 示例页验收
scripts/                工具链：本地素材生成（PNG/GIF/MP4 极简编码器）+ 验收脚本
tests/unit-test.mjs     零依赖自测（51 用例 / 390 断言）
```

## 示例素材怎么来（零外网 / 零外部二进制）

`scripts/gen-placeholder-assets.mjs` 在本机生成全部占位素材：

| 素材 | 生成方式 |
|---|---|
| `sample-1..6.mp4` | 用**浏览器自带的 `VideoEncoder`** 产出真实 H.264 样本，再由 `scripts/mp4.mjs` 封装为 mp4（不需要 ffmpeg） |
| `seq/frame-000..011.png` | `scripts/codecs.mjs` 手写 PNG 编码器（zlib + CRC32） |
| `anim.gif` | 手写 GIF 编码器（中位切分调色板 + LZW） |
| `frame-single.png` / `poster-1.png` | 同上 |

素材内容为**通用虚构图形**（渐变色块 / 网格 / 运动方块 / 进度条 / 序号），不含任何业务信息。
无浏览器时可用 `node scripts/gen-placeholder-assets.mjs --no-video` 只生成图片素材。

## 状态

- 需求：已冻结（28 条）
- 契约：v1.0（拟定，待冻结）
- 实现：**第一版已完成并自测全绿**，逐条状态见 [`docs/实现/实现说明.md`](docs/实现/实现说明.md)
- 验收：`npm run accept` 退出码 0

## 许可

Apache License 2.0，见 [`LICENSE`](LICENSE)。
