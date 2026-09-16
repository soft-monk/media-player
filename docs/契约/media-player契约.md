# media-player 契约（v1.0）

| 项 | 内容 |
|---|---|
| 文档编号 | CTR-MDP-001 |
| 版本 | **v1.0（拟定，待冻结）** |
| 模块标识 | `@mapapp/media-player`（源码模块别名建议 `@media-player`，对齐 `map-2d` 的 `@map2d` 做法） |
| 定位 | **三件套第二件**：`需求专篇` → **`契约（接口长什么样）`** → `设计（怎么拆）` |
| 唯一权威需求 | [`../需求/media-player需求专篇.md`](../需求/media-player需求专篇.md)（28 条：MDP-CHN/PLY/MUL/OVL/DGR/NFR） |
| 上位契约 | [`../../phase-engine/docs/契约/protocol.md`](../../phase-engine/docs/契约/protocol.md)（P1–P10、§3 错误码、§4 事件名、§5 policies、§6 反向接口） |
| 冲突裁决 | [`../../phase-engine/docs/契约/冲突裁决.md`](../../phase-engine/docs/契约/冲突裁决.md)（C15/C16 幂等与冲突口径） |
| 本文覆盖面 | 公开入口与全部公开类型/签名、反向接口、错误码、事件、配置 JSON、降级矩阵、最小示例、protocol.md 一致性自检、需求覆盖矩阵 |
| 不覆盖面 | 目录结构、构建脚本、示例素材清单、验收脚本内部实现（归**设计**与实现文档） |
| 分级用词 | **MUST（验收必查）/ SHOULD（偏离需在决策记录说明）/ MAY（可选）** |
| 口径 | 只写**接口长什么样**；本文任何签名 MUST NOT 被实现方改形，只可增可选字段 |

---

## 0. 范围与从属关系

### 0.1 覆盖与不覆盖

| 维度 | 本契约覆盖 | 不覆盖（归属） |
|---|---|---|
| 通道与源 | 通道模型、清单归一化、运行时换源与释放 | 清单的权威存储（宿主；既有契约 §3.9） |
| 播放控制 | 播放/暂停/停止/进度/音量/静音/倍速/单帧/循环/全屏 | 转码、推流、录制、归档（专篇 §1.3 明确不做） |
| 多路同屏 | ≥6 路、每类上限、按需加载、主路、节流 | 页面版式与面板编排（宿主） |
| 叠加层 | 叠加项开关、内容注入、归一化坐标框、穿透 | 叠加**内容**的业务来源（宿主 / `situation-layer`） |
| 降级 | 状态机、失败隔离、无素材隐藏、诊断 | 服务端降级策略（宿主 / 后端） |
| 媒体托管 | 只**消费** `/media/**`（须支持 Range） | 静态托管实现（宿主） |
| 坐标换算 | 画面**内**归一化坐标 | 画面坐标 ↔ 地图坐标换算（**两家都不做**，宿主 / `situation-layer`） |

### 0.2 与 protocol.md 的从属关系

1. 本契约**从属**于 `protocol.md`：冲突时以 `protocol.md` 为准（protocol.md §0 定义方条款）。
2. 本契约**不修改** `protocol.md`；本文中一切"新增"均为**拟定 + 登记请求**（见 §11.3），登记前 MUST NOT 进入生产。
3. 本模块在 `protocol.md` §6 的反向接口表中登记为 **`media-player` = 无 sink（前端）**。本契约据此 **MUST NOT 定义任何 `I*Sink`**；模块出口一律为宿主注入的回调（§3.3）。
4. 本模块在 `protocol.md` 适用范围中列名，故 P1–P10 对本模块有效（逐条自检见 §11.1）。

### 0.3 三条红线（MUST）

| # | 红线 | 机检方式 |
|---|---|---|
| R-1 | **MUST NOT import `map-2d`**（含相对路径、别名、深路径） | 全仓 import 检索零命中 |
| R-2 | **MUST NOT import `ws-client` / `realtime-hub`**（本模块不依赖 WS） | 同上 |
| R-3 | 源码与公开接口 **MUST NOT 出现业务词**（任务/方案/目标/场景/阶段/编组/评估/威胁/毁伤/集群） | 全仓检索零命中（P6） |

> **边界一句话**（专篇 §4）：适配器同时 import 两个包是**对的**，模块内部互相 import 是**破线**。

### 0.4 兼容承诺

| 承诺 | 内容 |
|---|---|
| 字段只增不改 | 公开类型新增字段 MUST 为可选；已有字段名与语义 MUST NOT 变更 |
| 清单向后兼容 | 既有 `[{name, url}]`（契约 §3.9）MUST 可原样消费（MDP-CHN-03） |
| 事件名不改 | 已发布事件名 MUST NOT 改名；新增 MUST 先登记（CTR-EV-03/07） |
| 破坏性变更 | MUST 递增本文 `MAJOR` 并给出兼容性分析（protocol.md §9） |

---

## 1. 统一约定

### 1.1 包、入口与交付形态

| 项 | 取值 | 强制性 |
|---|---|---|
| 语言/栈 | TypeScript + React 18 + Vite | MUST（对齐 `map-2d`） |
| 运行时依赖 | `dependencies` **MUST 为空**；`react` / `react-dom` 走 `peerDependencies`（`>=18`） | MUST（零运行时依赖） |
| 唯一入口 | `src/index.ts`（包 `exports` 只暴露根入口与其类型） | MUST |
| 深层导入 | 宿主 MUST NOT 从 `src/**` 深层路径导入 | MUST |
| 独立交付 | 独立构建 + 独立示例页 + 独立验收脚本（退出码 0/1） | MUST（MDP-NFR-03） |
| 示例素材 | 全部本地占位素材；**模块与示例 MUST NOT 产生外网请求** | MUST（MDP-NFR-02） |
| 核心可测 | 控制器与纯函数 MUST NOT import `react`，MUST 可在 node 直接跑（零测试框架） | MUST（见 §11.1 P2） |

### 1.2 命名、单位与时基

| 项 | 规定 | 依据 |
|---|---|---|
| 字段命名 | camelCase | P4 |
| 时间戳 | epoch **毫秒**，字段以 `ts` / `…Ms` / `At` 结尾 | P5 |
| 时基来源 | 一律取注入的 `IClock.nowMs()`；未注入时默认 `Date.now` | P9 |
| 人类可读时间 | **不由本模块格式化**（叠加层时间戳文本可由宿主用 `timestampText` 注入） | P5 |
| 坐标 | 叠加层用**归一化坐标** 0–1（`NormRect`），原点在**画面内容框**左上 | MDP-OVL-03/04 |
| 长度 | 叠加层边框粗细用 **CSS 像素**（`thickness`）；位置一律归一化，**MUST NOT 用像素定位** | MDP-OVL-04 |
| 枚举取值 | 小写；多段用短横线（`image-seq`，与需求专篇逐字一致）；输入别名见 §6.2 | — |
| 缺失字段 | **省略**（不用 `null` / `""` / `-1` 表示缺失），归一化后模型内统一用 `null` 显式表达"已知为空" | 对齐 `realtime-hub/protocol.md` §3 |

### 1.3 结果信封（P10：失败 MUST NOT 抛异常跨边界）

所有公开方法（组件与纯函数除外）返回结构化结果：

```ts
interface MediaResult<T = unknown> {
  ok: boolean              // 恒等于 (code === 0)
  code: MediaErrorCode     // 见 §4
  message: string          // 人类可读中文；MUST NOT 作为机检依据（机检用 code）
  data?: T                 // 成功时的附加数据；失败时 MAY 带上下文
  idempotent?: boolean     // 幂等命中：code 恒 0（CTR-EC-01/02）
  clamped?: boolean        // 入参被夹紧到合法范围（如 volume 越界）
}
```

| 约束 | 内容 |
|---|---|
| CTR-MDP-EC-01 | 公开方法（含 `normalizeChannels`、`play`、`seek`…）**MUST NOT** 抛异常；一切失败以 `{ok:false, code, message}` 返回 |
| CTR-MDP-EC-02 | 幂等命中（重复 `play` 已播放、重复 `mute(true)`）MUST 返回 `code=0` + `idempotent:true`，**MUST NOT** 发明非零成功码（C15） |
| CTR-MDP-EC-03 | 互斥拒绝（另一通道正在进出全屏、通道正在被释放）MUST 用 `1002`（C16） |
| CTR-MDP-EC-04 | 行内可见失败（单路 404/解码失败）MUST 只落到该通道的 `ChannelStatus`，**MUST NOT** 使整组操作失败（MDP-DGR-03） |
| CTR-MDP-EC-05 | 宿主回调（`onEvent` / `onChannelState` / `onEmpty`）抛出的异常 MUST 被模块捕获并计入诊断，**MUST NOT** 中断播放或状态机 |

### 1.4 零外网与来源约束

| 项 | 规定 |
|---|---|
| 素材来源 | 一律宿主提供的相对/同源 URL；本模块 MUST NOT 拼接外域地址、MUST NOT 内置任何 URL |
| 探测请求 | Range 能力探测 MUST 只对**同源或相对** URL 发起；跨域 URL MUST NOT 探测（`degraded.range` 为"未知"） |
| 预取 | 帧预取 MUST 只取同一通道声明过的帧（`frames` / 模板展开 / `IFrameUrlResolver` 返回值） |

### 1.5 公开入口总表（63 条）

| 分组 | 条数 | 明细 |
|---|---|---|
| 组件 | 4 | `MediaPlayer`、`MediaTile`、`MediaOverlay`、`MediaControls` |
| Hook | 1 | `useMediaPlayer` |
| 工厂 | 1 | `createMediaController` |
| 纯函数 | 7 | `normalizeChannels`、`expandFrames`、`resolveFrameUrl`、`mediaContentBox`、`normToPx`、`pxToNorm`、`pickAudible` |
| 常量 | 8 | `DEFAULT_OPTIONS`、`MEDIA_SCHEMA_VERSION`、`SUPPORTED_SCHEMA_MAJOR`、`CHANNEL_STATES`、`OVERLAY_KEYS`、`EMPTY_REASONS`、`MEDIA_EVENTS`、`MEDIA_ERROR` |
| 类型 | 42 | 见 §2.5 |
| **合计** | **63** | — |

> 控制器的方法**不单独计数**：`MediaController` 类型整体计 1 条（其 37 个成员见 §2.3）。

---

## 2. 公开入口与全部公开类型 / 函数签名

### 2.1 组件（4 个）

#### 2.1.1 `<MediaPlayer>` —— 面板唯一入口组件

```ts
interface MediaPlayerProps {
  channels?: unknown                  // 直投清单纯数据（形状见 §6）；与 source 二选一
  source?: IChannelSource             // 清单来源（MDP-CHN-02/03）；仅用于首次与 refreshChannels
  controller?: MediaController        // 注入既有控制器（受控模式）；不传则组件内部自建
  options?: Partial<MediaPlayerOptions>
  adapters?: MediaPlayerAdapters
  overlays?: OverlaysConfig
  mainChannelId?: string | null       // 主路（MDP-MUL-04）；缺省 null
  layout?: LayoutMode                 // 缺省 options.layout（默认 'grid'）
  columns?: number | 'auto'           // 缺省 'auto'（规则见 §2.6 表）
  onEvent?: MediaEventListener
  onChannelState?: (status: ChannelStatus) => void
  onEmpty?: (reason: EmptyReason, detail: { total: number; usable: number; message: string }) => void
  renderTile?: (ctx: { channel: MediaChannel; status: ChannelStatus }) => React.ReactNode
  className?: string
  style?: React.CSSProperties
}
declare const MediaPlayer: React.ForwardRefExoticComponent<
  MediaPlayerProps & React.RefAttributes<MediaPlayerHandle>
>
```

| 行为 | 规定 | 依据 |
|---|---|---|
| 空清单 | 可用通道数 = 0 时 **MUST 返回 `null`**（不渲染任何容器/占位/黑框），并回调 `onEmpty(reason)` | MDP-DGR-02 |
| 空面板口 | 组件 **MUST NOT** 提供 `renderEmpty` 之类接口（防止被用来渲染空面板） | MDP-DGR-02 |
| 上限 | 超过 `maxChannels` / `maxChannelsByKind` 的通道 MUST 不渲染，并给可读原因（`3004`），MUST NOT 静默丢 | MDP-MUL-02 |
| 单路失败 | 某路 `error` MUST NOT 影响其余路渲染与播放 | MDP-DGR-03 |
| 主路 | `mainChannelId` 变化 MUST 立即生效（布局 + 声音跟随）；置 `null` 回到网格 | MDP-MUL-04 |
| 受控 | `controller` 传入时，组件 MUST 以该控制器为唯一状态源（MUST NOT 另建状态副本） | MDP-PLY-01 |
| 尺寸 | 父容器 MUST 提供确定尺寸；组件 MUST 用容器实测尺寸驱动叠加层（见 §8） | MDP-OVL-04 |
| `ref` | 暴露 `MediaPlayerHandle`（= `MediaController`），供宿主以接口驱动播放（"三个动作均可由接口与界面触发"） | MDP-PLY-01 |

#### 2.1.2 `<MediaTile>` —— 单通道卡（可单独使用）

```ts
interface MediaTileProps {
  channel: MediaChannel
  controller?: MediaController          // 提供则卡内控制条可驱动播放
  status?: ChannelStatus                // 受控状态（不传则由 controller 订阅取得）
  options?: Partial<MediaPlayerOptions>
  overlay?: OverlayContent              // 该路叠加内容（宿主注入，MDP-OVL-02）
  showControls?: boolean                // 缺省 true
  onEvent?: MediaEventListener
  className?: string
  style?: React.CSSProperties
}
```

| 行为 | 规定 |
|---|---|
| 通道已知不可用（`available === false`） | MUST 渲染**可读原因态**，MUST NOT 渲染空白黑框 |
| 加载中 | MAY 渲染 poster / 骨架；`state === 'error'` 时 MUST 显示可读原因与（MAY）重试入口 |
| 媒体元素 | 全屏、切主路、隐藏再显示 **MUST 复用同一媒体元素实例**（MUST NOT 重建），否则进度会丢（MDP-PLY-05） |

#### 2.1.3 `<MediaOverlay>` —— 叠加层（可由宿主单独使用）

```ts
interface MediaOverlayProps {
  content: OverlayContent
  keys?: OverlayKey[]                   // 缺省取 options.overlay.keys（默认全部 6 项）
  pointerEvents?: 'none' | 'auto'       // 缺省 'none'（穿透，MDP-OVL-05）
  fit?: FitMode                         // 缺省 'contain'，MUST 与媒体元素 object-fit 一致
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode            // 附加 DOM 叠加（同样受 pointerEvents 约束）
}
```

| 行为 | 规定 | 依据 |
|---|---|---|
| 未注入 | 任何叠加项缺内容 MUST 不渲染该项，且 MUST NOT 报错、MUST NOT 留占位 | MDP-OVL-02 |
| 关闭项 | 关闭后 MUST 不残留占位（DOM 节点 MUST 移除） | MDP-OVL-01 |
| 对齐 | 位置基准 MUST 为画面**内容框**（§8），MUST NOT 用容器百分比或 `vw/vh` | MDP-OVL-04 |
| 穿透 | `pointerEvents:'none'` 时叠加层 MUST NOT 吞掉播放控件点击 | MDP-OVL-05 |

#### 2.1.4 `<MediaControls>` —— 控制条

```ts
type MediaControlsKey =
  | 'play' | 'stop' | 'seek' | 'volume' | 'mute'
  | 'rate' | 'step' | 'loop' | 'frame' | 'fullscreen' | 'main' | 'state'

interface MediaControlsProps {
  channelId: string
  controller: MediaController
  keys?: MediaControlsKey[]             // 缺省：除 'step' 外全部（'step' 仅 video 通道默认开启）
  compact?: boolean                     // 缺省 false
  className?: string
}
```

| 行为 | 规定 | 依据 |
|---|---|---|
| 触发 | 每个控件动作 MUST 走 `controller` 对应方法（界面与接口同一路径） | MDP-PLY-01 |
| 进度 | 拖动定位 MUST 依赖服务端 Range；无 Range 时 MUST 显示可读降级提示（`degraded.hint`），MUST NOT 静默失败 | MDP-PLY-02 |
| 静音 | 被策略静音的通道，控件 MUST 反映**有效静音**并给出原因（`mutedByPolicy`） | MDP-PLY-03 |
| 单帧 | 仅 `kind === 'video'` 时默认提供；图像流的"帧"由 `frame` 控件表达 | MDP-PLY-04 |
| 全屏 | 全屏按钮 MUST 走 `enterFullscreen/exitFullscreen`（不得自行调 DOM API），以保证退出后进度与布局一致 | MDP-PLY-05 |

### 2.2 Hook（1 个）

```ts
declare function useMediaPlayer(init?: MediaControllerInit): {
  controller: MediaController
  summary: MediaSummary
}

interface MediaControllerInit {
  channels?: unknown
  options?: Partial<MediaPlayerOptions>
  adapters?: MediaPlayerAdapters
  onEvent?: MediaEventListener
}
```

| 行为 | 规定 |
|---|---|
| 生命周期 | Hook MUST 在卸载时调用 `controller.dispose()`（停止解码、释放缓冲、解绑监听） |
| 订阅 | 返回的 `summary` MUST 随 `media.*` 事件更新（同一渲染帧内批量合并，MUST NOT 每帧 setState） |
| 稳定引用 | `controller` 引用 MUST 稳定（不因 props 变化而重建；`options` 变化走 `setOptions`） |

### 2.3 工厂与控制器（1 个工厂 + 1 个控制器类型，37 项成员）

```ts
declare function createMediaController(init?: MediaControllerInit): MediaController

interface MediaController {                                        // 全部成员签名逐条见下表
  // 清单
  setChannels(raw: unknown): MediaResult<MediaSetResultData>
  refreshChannels(signal?: AbortSignal): Promise<MediaResult<MediaSetResultData>>
  getChannels(): MediaChannel[]
  getChannel(id: string): MediaChannel | null
  // 状态与诊断
  getStatus(id: string): ChannelStatus | null
  getAllStatus(): ChannelStatus[]
  getSummary(): MediaSummary
  getDiagnostics(): MediaDiagnostics
  subscribe(listener: MediaEventListener): () => void
  // 播放控制
  play(id: string): MediaResult
  pause(id: string): MediaResult
  stop(id: string): MediaResult
  toggle(id: string): MediaResult
  seek(id: string, positionMs: number): MediaResult
  setVolume(id: string, volume: number): MediaResult
  mute(id: string, muted?: boolean): MediaResult
  setRate(id: string, rate: number): MediaResult
  stepFrame(id: string, delta?: number): MediaResult
  setLoop(id: string, loop: boolean): MediaResult
  setFrameInterval(id: string, ms: number): MediaResult
  pushFrame(id: string, frame: string | number): MediaResult
  // 布局、主路与全屏
  setMain(id: string | null): MediaResult
  getMain(): string | null
  getAudible(): string | null
  setVisible(id: string, visible: boolean): MediaResult
  setLayout(mode: LayoutMode): MediaResult
  getLayout(): LayoutMode
  enterFullscreen(id: string): Promise<MediaResult>
  exitFullscreen(): Promise<MediaResult>
  getFullscreen(): string | null
  // 叠加层
  setOverlay(id: string, patch: Partial<OverlayContent>): MediaResult
  toggleOverlay(id: string, key: OverlayKey, on?: boolean): MediaResult
  getOverlay(id: string): OverlayContent
  // 元素、配置与生命周期
  getElement(id: string): HTMLElement | null
  getOptions(): MediaPlayerOptions
  setOptions(patch: Partial<MediaPlayerOptions>): MediaResult
  dispose(): void
}
```

> 控制器**不承担回调容器**角色：出口只有 `subscribe()`（§2.3-9）与组件 props 上的 `MediaPlayerCallbacks`（§3.3）两条，二者负载同源（同一份 `MediaEvent`）。

`createMediaController` MUST 是**纯逻辑**（不触碰 DOM）：未挂载视图时清单归一化、状态机、上限、出声仲裁、节流、叠加模型全部可用——这是"零依赖单测脚本（node 直接跑）"的前提。

| # | 方法 | 签名 | 缺省 | 语义与 MUST |
|---|---|---|---|---|
| 1 | `setChannels` | `setChannels(raw: unknown): MediaResult<MediaSetResultData>` | — | **整组替换**。被移除的通道 MUST 在返回前释放（停止解码、清缓冲、置静音）；同 `id` 且 `url`/`kind` 未变 MUST 复用现有媒体元素与播放位置（MUST NOT 重建）；`url`/`kind` 变 MUST 按新源重建并回 `idle`。非法条目 MUST 逐条进 `rejected`，有效条目照常生效（部分成功） |
| 2 | `refreshChannels` | `refreshChannels(signal?: AbortSignal): Promise<MediaResult<MediaSetResultData>>` | — | 从 `adapters.source` 重新拉清单（等价 `setChannels(await source.list(signal))`）；失败 MUST 保留现有清单不变并回可读原因 |
| 3 | `getChannels` | `getChannels(): MediaChannel[]` | — | 返回副本（宿主改动 MUST NOT 影响模块内部状态） |
| 4 | `getChannel` | `getChannel(id: string): MediaChannel \| null` | — | 不存在回 `null`（不抛，MDP-CHN-01） |
| 5 | `getStatus` | `getStatus(id: string): ChannelStatus \| null` | — | 状态可实时查询（MDP-DGR-01） |
| 6 | `getAllStatus` | `getAllStatus(): ChannelStatus[]` | — | 顺序同清单顺序 |
| 7 | `getSummary` | `getSummary(): MediaSummary` | — | 汇总（含 `empty`/`emptyReason`/`audibleId`） |
| 8 | `getDiagnostics` | `getDiagnostics(): MediaDiagnostics` | — | 诊断（MDP-DGR-04） |
| 9 | `subscribe` | `subscribe(listener: MediaEventListener): () => void` | — | 订阅 `media.*`；返回退订函数；同一次状态迁移 MUST 只发一次 |
| 10 | `play` | `play(id: string): MediaResult` | — | 触发加载与播放；已在播放 → `code 0`+`idempotent`；不可用 → `1003`/`3004`（MDP-PLY-01） |
| 11 | `pause` | `pause(id: string): MediaResult` | — | 已暂停 → 幂等成功 |
| 12 | `stop` | `stop(id: string): MediaResult` | — | 位置归零、状态回 `idle`、释放解码与缓冲；图像流停轮播并回第 0 帧（MDP-PLY-01/06） |
| 13 | `toggle` | `toggle(id: string): MediaResult` | — | `playing ⇄ paused`；其余状态等价 `play` |
| 14 | `seek` | `seek(id: string, positionMs: number): MediaResult` | — | 仅 `video`；`idle/loading` → `1003`；越界 MUST 夹紧并置 `clamped`；无 Range 时 MUST 给 `degraded.hint`，MUST NOT 静默失败（MDP-PLY-02） |
| 15 | `setVolume` | `setVolume(id: string, volume: number): MediaResult` | — | `[0,1]`；越界夹紧 + `clamped:true`（MDP-PLY-03） |
| 16 | `mute` | `mute(id: string, muted?: boolean): MediaResult` | `muted = true` | 设置**用户静音意图**（`userMuted`）；有效静音另由策略仲裁（§7.5）；被策略覆盖时回 `code 0` 且 `data.policyOverride = true`（MDP-PLY-03） |
| 17 | `setRate` | `setRate(id: string, rate: number): MediaResult` | — | 取值 MUST ∈ `options.rateOptions`（默认 `[0.5,1,2]`），否则 `1000`；图像流语义 = 轮播间隔 `frameIntervalMs / rate`（MDP-PLY-04） |
| 18 | `stepFrame` | `stepFrame(id: string, delta?: number): MediaResult` | `delta = +1` | **MUST 先暂停**再推进一帧，终态为 `paused`；`video` 按 `1/fps` 步进（fps 未知时用 `stepFallbackMs`，默认 40 ms）；图像流按下标推进并可跨帧序回绕（MDP-PLY-04） |
| 19 | `setLoop` | `setLoop(id: string, loop: boolean): MediaResult` | — | 循环开启后 MUST 无间断（`video` 归零续播；图像流到末帧回 0）（MDP-PLY-06） |
| 20 | `setFrameInterval` | `setFrameInterval(id: string, ms: number): MediaResult` | — | 仅 `image-seq`；小于 `minFrameIntervalMs` MUST 夹紧并置 `clamped`（MDP-MUL-05） |
| 21 | `pushFrame` | `pushFrame(id: string, frame: string \| number): MediaResult` | — | 实时推帧：`string` = 帧 URL（进有界缓存），`number` = 帧下标；仅 `image-seq`，其它类型 `1000`（MDP-PLY-06） |
| 22 | `setMain` | `setMain(id: string \| null): MediaResult` | — | 主路：布局放大 + 出声跟随；`null` 取消主路回网格；不存在 `1004`（MDP-MUL-04） |
| 23 | `getMain` | `getMain(): string \| null` | — | — |
| 24 | `getAudible` | `getAudible(): string \| null` | — | 当前出声通道（策略仲裁结果，MDP-PLY-03） |
| 25 | `setVisible` | `setVisible(id: string, visible: boolean): MediaResult` | — | 按需加载：不可见且 `lazyVisibility` → MUST 暂停解码/停轮播并置 `pausedByPolicy`；重新可见 MUST 自动恢复（MDP-MUL-03） |
| 26 | `setLayout` | `setLayout(mode: LayoutMode): MediaResult` | — | `'grid' \| 'focus'` |
| 27 | `getLayout` | `getLayout(): LayoutMode` | — | — |
| 28 | `enterFullscreen` | `enterFullscreen(id: string): Promise<MediaResult>` | — | 单通道全屏；另一通道正在进出全屏 → `1002`；环境不支持 → `3005`；退出后 MUST 回到原布局且**播放进度连续**（MDP-PLY-05） |
| 29 | `exitFullscreen` | `exitFullscreen(): Promise<MediaResult>` | — | 未处于全屏 → `code 0` + `idempotent:true` |
| 30 | `getFullscreen` | `getFullscreen(): string \| null` | — | — |
| 31 | `setOverlay` | `setOverlay(id: string, patch: Partial<OverlayContent>): MediaResult` | — | 合并写入该路叠加内容（MDP-OVL-02） |
| 32 | `toggleOverlay` | `toggleOverlay(id: string, key: OverlayKey, on?: boolean): MediaResult` | `on = 切换` | 逐项开关；关闭 MUST 清理 DOM（MDP-OVL-01） |
| 33 | `getOverlay` | `getOverlay(id: string): OverlayContent` | — | 返回副本 |
| 34 | `getElement` | `getElement(id: string): HTMLElement \| null` | — | 媒体容器元素（宿主兜底/排障用；MAY 为 `null` 于无 DOM 环境） |
| 35 | `getOptions` | `getOptions(): MediaPlayerOptions` | — | 返回生效配置（含默认值，便于审计） |
| 36 | `setOptions` | `setOptions(patch: Partial<MediaPlayerOptions>): MediaResult` | — | 运行中改配置；`clock`/`source`/`probe`/`frameResolver` MUST 经 `adapters` 提供，不在此列 |
| 37 | `dispose` | `dispose(): void` | — | 释放全部：停解码、清缓冲、断开 `ResizeObserver`/`fullscreenchange`、退订、置 `disposed` 后一切方法回 `1005`（MDP-CHN-04） |

> 表内 **37 项成员**全部属于 `MediaController` 类型；它们在 §1.5 中**整体计 1 条**（不按方法数重复计数）。所有方法 MUST NOT 抛异常（§1.3 CTR-MDP-EC-01）。

### 2.4 纯函数（7 个）

| 函数 | 签名 | 返回 | 语义与 MUST |
|---|---|---|---|
| `normalizeChannels` | `normalizeChannels(raw: unknown, options?: Partial<MediaPlayerOptions>): MediaResult<MediaSetResultData> & { channels: MediaChannel[] }` | 归一结果 + 通道数组 | 接受 §6.5 的三种形状；**MUST NOT 抛错**；缺字段按 §7.2 缺省；非法条目逐条 `rejected`（部分成功） |
| `expandFrames` | `expandFrames(channel: MediaChannel, resolver?: IFrameUrlResolver): string[]` | 帧 URL 数组 | 优先级：`frames` > `resolver` > `url` 模板展开；无法展开 MUST 回 `[]`（不抛） |
| `resolveFrameUrl` | `resolveFrameUrl(channel: MediaChannel, index: number, resolver?: IFrameUrlResolver): string \| null` | 单帧 URL | 下标越界或不可展开 MUST 回 `null`；占位符规则见 §6.2 |
| `mediaContentBox` | `mediaContentBox(container: Size, media: Size \| null, fit?: FitMode): Rect` | 画面内容框（CSS 像素，相对容器左上） | `fit` 缺省 `'contain'`；`media` 为 `null`（尺寸未知）时 MUST 回整容器；`'cover'` 返回**未裁剪**的内容框（裁剪由渲染侧负责） |
| `normToPx` | `normToPx(r: NormRect, box: Rect): Rect` | 像素矩形 | 纯比例映射；`box` 为零尺寸时 MUST 回零矩形（不抛） |
| `pxToNorm` | `pxToNorm(r: Rect, box: Rect): NormRect` | 归一矩形 | `normToPx` 的逆；`box` 为零尺寸时 MUST 回零矩形 |
| `pickAudible` | `pickAudible(channels: MediaChannel[], statuses: ChannelStatus[], mainId: string \| null, policy: AudioPolicy): string \| null` | 出声通道 id | §7.5 仲裁矩阵的纯函数化；`policy==='none'` MUST 回 `null`；无候选回 `null` |

> 以上 7 个函数 MUST 无副作用、无 DOM 依赖、无 React 依赖——单测脚本靠它们覆盖归一化、帧展开、坐标对齐与出声仲裁。

### 2.5 类型清单（42 个）

**枚举与基础**

```ts
type ChannelKind   = 'video' | 'image-seq'          // 输入别名见 §6.2
type ChannelState  = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error'   // MDP-DGR-01 冻结集
type LayoutMode    = 'grid' | 'focus'
type FitMode       = 'contain' | 'cover' | 'fill'
type OverlayKey    = 'live' | 'magnification' | 'timestamp' | 'channelName' | 'source' | 'boxes'
type OverlayBoxStyle = 'rect' | 'crosshair' | 'lock'
type AudioPolicy   = 'single' | 'all' | 'none'
type EmptyReason   = 'no-source' | 'no-channels' | 'all-unavailable' | 'source-error' | 'schema-mismatch'
type MediaEventType = 'media.state' | 'media.error' | 'media.empty' | 'media.degraded' | 'media.frame'
type MediaErrorCode = 0 | 1000 | 1002 | 1003 | 1004 | 1005 | 1006 | 3001 | 3002 | 3003 | 3004 | 3005
type MediaEventListener = (ev: MediaEvent) => void

interface Size { w: number; h: number }
interface Rect { x: number; y: number; w: number; h: number }       // CSS 像素，相对容器左上
interface NormRect { x: number; y: number; w: number; h: number }   // 0–1，相对画面内容框
```

**通道模型（MDP-CHN-01）**

```ts
interface RawChannelEntry {                 // 宿主可直投的宽松输入（全部字段可选）
  id?: string; name?: string; kind?: string; url?: string
  frames?: string[]; frameCount?: number; frameIntervalMs?: number
  sourceLabel?: string; available?: boolean; unavailableReason?: string
  loop?: boolean; poster?: string
  overlays?: OverlayContent; overlayKeys?: OverlayKey[]
  meta?: Record<string, unknown>
}

interface MediaChannel {                    // 归一化后模型（只读；模块外 MUST NOT 改）
  id: string
  name: string
  kind: ChannelKind
  url: string | null                        // video: 媒体地址；image-seq: 帧模板或单帧地址
  frames: string[] | null                   // image-seq 显式帧；video 恒 null
  frameCount: number                        // image-seq 帧数；video 恒 0
  frameIntervalMs: number                   // 已夹紧到 >= minFrameIntervalMs
  sourceLabel: string | null                // 来源徽标文本（宿主给，模块不内置枚举，MDP-CHN-05）
  available: boolean
  unavailableReason: string | null
  loop: boolean
  poster: string | null
  overlayKeys: OverlayKey[]
  meta: Record<string, unknown>             // 原样透传；模块 MUST NOT 解释其内容（P6）
}
```

**状态与诊断（MDP-DGR-01/04）**

```ts
interface ChannelDiagnostics {
  loadMs: number | null            // 发起加载 → 首帧可绘（video: loadeddata；image-seq: 首帧 onload）
  seekMs: number | null            // 最近一次 seek 实际耗时
  bufferingCount: number
  droppedFrames: number            // video: getVideoPlaybackQuality().droppedVideoFrames（不可用时为 0）
                                   // image-seq: 因节流/不可见被跳过的帧数
  loadFailures: number
  lastErrorAt: number | null
  pausedByPolicy: boolean
  throttleMs: number               // 该通道当前生效的最小刷新间隔
  updatedAt: number
}

interface ChannelStatus {
  id: string
  kind: ChannelKind
  state: ChannelState
  since: number                    // 进入当前状态的时刻（epoch ms，来自 IClock）
  reason: string | null            // 可读原因；state==='error' 时 MUST 非空
  errorCode: MediaErrorCode | null
  positionMs: number               // video: 当前进度；image-seq: frameIndex * frameIntervalMs（约定值）
  durationMs: number | null        // video 未知为 null；image-seq 为 null
  bufferedMs: number               // video 已缓冲位置；image-seq 恒 0
  volume: number                   // 用户设定音量 0–1
  muted: boolean                   // **有效静音**（含策略静音）
  userMuted: boolean               // 用户静音意图
  mutedByPolicy: boolean           // 被 §7.5 仲裁强制静音
  audible: boolean                 // 当前是否出声
  rate: number
  loop: boolean
  frameIndex: number               // image-seq 当前帧下标（0 基）；video 恒 0
  frameCount: number
  videoSize: Size | null           // 实际分辨率（MDP-DGR-04）
  visible: boolean
  fullscreen: boolean
  degraded: { range: boolean; hint: string | null }   // MDP-PLY-02：无 Range 时的可读提示
  diagnostics: ChannelDiagnostics
}

interface MediaDiagnostics {
  ts: number
  mainId: string | null
  audibleId: string | null
  fullscreenId: string | null
  layout: LayoutMode
  totals: { channels: number; usable: number; visible: number; playing: number; loading: number; error: number; audible: number }
  channels: Record<string, ChannelDiagnostics>
  degraded: { range: boolean; throttled: boolean; visibility: boolean }
  policyRejections: number         // 被上限/策略拒绝的次数（MDP-MUL-02）
  fps: number | null               // 仅当 options.measureFps 为 true 且有 DOM 时给出；否则 null
  disposed: boolean
}

interface MediaSummary {
  total: number; usable: number; visible: number
  states: Record<ChannelState, number>
  mainId: string | null
  audibleId: string | null
  fullscreenId: string | null
  layout: LayoutMode
  empty: boolean
  emptyReason: EmptyReason | null
  degradedChannels: string[]
  policyRejections: number
}
```

**叠加层（MDP-OVL-01/02/03）**

```ts
interface OverlayBox {
  id: string
  rect: NormRect                    // 归一化坐标，0–1（MDP-OVL-03）
  style?: OverlayBoxStyle           // 缺省 'rect'
  color?: string                    // 缺省 '#ef4444'
  label?: string
  thickness?: number                // CSS px，缺省 2
  dashed?: boolean                  // 缺省 false
}

interface OverlayContent {
  live?: boolean                    // true → 【实时】；false → 【回放】；缺省（不传）不显示
  magnification?: string            // 倍率**文本**（宿主给，模块 MUST NOT 换算）
  timestampMs?: number              // epoch ms；与 timestampText 同时给时以文本优先
  timestampText?: string            // 宿主已格式化的时间串（P5：格式化归宿主）
  channelName?: string              // 缺省取 channel.name
  sourceLabel?: string              // 缺省取 channel.sourceLabel
  boxes?: OverlayBox[]
  extra?: Array<{ key: string; text: string; corner?: 'tl' | 'tr' | 'bl' | 'br' }>   // MAY：自定义角标文本
}

interface OverlaysConfig {
  keys?: OverlayKey[]                           // 缺省 OVERLAY_KEYS（全部 6 项）
  pointerEvents?: 'none' | 'auto'                // 缺省 'none'（穿透，MDP-OVL-05）
  fit?: FitMode                                  // 缺省 'contain'
  byChannel?: Record<string, OverlayContent>
}
```

**配置与适配器**

```ts
interface MediaPlayerOptions {
  defaultKind: ChannelKind
  maxChannels: number
  maxChannelsByKind: Record<ChannelKind, number>
  columns: number | 'auto'
  layout: LayoutMode
  defaultVolume: number
  audioPolicy: AudioPolicy
  autoPlay: boolean
  defaultLoop: boolean
  defaultFrameIntervalMs: number
  minFrameIntervalMs: number
  throttleMs: number
  preloadFrames: number
  stepFallbackMs: number
  rateOptions: number[]
  seekTimeoutMs: number
  lazyVisibility: boolean
  hiddenPauseDelayMs: number
  bufferLimitFrames: number
  frameEvents: boolean
  measureFps: boolean
  overlay: { keys: OverlayKey[]; pointerEvents: 'none' | 'auto'; fit: FitMode }
}

interface MediaPlayerAdapters {
  clock?: IClock
  source?: IChannelSource
  frameResolver?: IFrameUrlResolver
  probe?: IMediaProbe
}

interface MediaControllerInit {
  channels?: unknown
  options?: Partial<MediaPlayerOptions>
  adapters?: MediaPlayerAdapters
  onEvent?: MediaEventListener
}

interface MediaResult<T = unknown> { ok: boolean; code: MediaErrorCode; message: string; data?: T; idempotent?: boolean; clamped?: boolean }

interface MediaSetResultData {
  total: number
  applied: string[]                                   // 被接受的通道 id（顺序同输入）
  rejected: Array<{ index: number; code: MediaErrorCode; reason: string }>
  usable: number
  schemaVersion: string | null
}
```

**事件与控制器**

```ts
interface MediaEvent {
  type: MediaEventType
  data: MediaEventData            // 各 type 的负载见 §5.2；type 为判别字段
  ts: number                      // 事件产生时刻（epoch ms，来自 IClock）；同一次产生只取一次时钟
}

type MediaEventData =
  | { channelId: string; kind: ChannelKind; state: ChannelState; prevState: ChannelState; reason?: string; errorCode?: MediaErrorCode; at: number }   // media.state
  | { channelId: string; errorCode: MediaErrorCode; reason: string; recoverable: boolean; at: number }                                              // media.error
  | { reason: EmptyReason; total: number; usable: number; message: string; at: number }                                                             // media.empty
  | { channelId?: string; capability: 'range' | 'fullscreen' | 'autoplay' | 'visibility'; hint: string; at: number }                                // media.degraded
  | { channelId: string; frameIndex: number; frameCount: number; url?: string; at: number }                                                         // media.frame

type MediaPlayerHandle = MediaController
```

> 实现 SHOULD 用判别联合（`{type:'media.state', data:{…}} | {type:'media.error', data:{…}} | …`）表达 `MediaEvent`，以便按 `type` 收窄；本契约的类型计数以 `MediaEvent` + `MediaEventData` 两者为准。
> `MediaController`（接口）与 `MediaPlayerCallbacks` 分别声明在 §2.3 与 §3.3；`IChannelSource` / `IClock` / `IFrameUrlResolver` / `IMediaProbe` 声明在 §3.1–§3.4；4 个组件 Props 与 `MediaControlsKey` 声明在 §2.1。

**公开类型索引**（42 个，机检用）

| # | 类型 | # | 类型 | # | 类型 |
|---|---|---|---|---|---|
| 1 | `ChannelKind` | 15 | `RawChannelEntry` | 29 | `MediaEvent` |
| 2 | `ChannelState` | 16 | `MediaChannel` | 30 | `MediaEventData` |
| 3 | `LayoutMode` | 17 | `ChannelDiagnostics` | 31 | `MediaController`（§2.3） |
| 4 | `FitMode` | 18 | `ChannelStatus` | 32 | `MediaPlayerHandle` |
| 5 | `OverlayKey` | 19 | `MediaDiagnostics` | 33 | `MediaPlayerProps`（§2.1.1） |
| 6 | `OverlayBoxStyle` | 20 | `MediaSummary` | 34 | `MediaTileProps`（§2.1.2） |
| 7 | `AudioPolicy` | 21 | `OverlayBox` | 35 | `MediaOverlayProps`（§2.1.3） |
| 8 | `EmptyReason` | 22 | `OverlayContent` | 36 | `MediaControlsProps`（§2.1.4） |
| 9 | `MediaEventType` | 23 | `OverlaysConfig` | 37 | `MediaControlsKey`（§2.1.4） |
| 10 | `MediaErrorCode` | 24 | `MediaPlayerOptions` | 38 | `IChannelSource`（§3.1） |
| 11 | `MediaEventListener` | 25 | `MediaPlayerAdapters` | 39 | `IClock`（§3.2） |
| 12 | `Size` | 26 | `MediaControllerInit` | 40 | `IFrameUrlResolver`（§3.4） |
| 13 | `Rect` | 27 | `MediaResult` | 41 | `IMediaProbe`（§3.4） |
| 14 | `NormRect` | 28 | `MediaSetResultData` | 42 | `MediaPlayerCallbacks`（§3.3） |


### 2.6 常量与缺省值

| 常量 | 类型 | 值 / 语义 |
|---|---|---|
| `MEDIA_SCHEMA_VERSION` | `string` | `'1.0.0'`（模块**支持**的清单 schema 版本） |
| `SUPPORTED_SCHEMA_MAJOR` | `number` | `1`（不匹配 → 拒绝装载 + `1006`） |
| `CHANNEL_STATES` | `readonly ChannelState[]` | `['idle','loading','ready','playing','paused','error']`（顺序冻结） |
| `OVERLAY_KEYS` | `readonly OverlayKey[]` | `['live','magnification','timestamp','channelName','source','boxes']`（顺序即渲染叠放顺序） |
| `EMPTY_REASONS` | `readonly EmptyReason[]` | §2.5 的 5 个取值 |
| `MEDIA_EVENTS` | `Record<'state'\|'error'\|'empty'\|'degraded'\|'frame', MediaEventType>` | 事件名常量表（禁止字面量散落，对齐 `realtime-hub` §2.4） |
| `MEDIA_ERROR` | `Record<string, MediaErrorCode>` | 错误码名称 → 码（§4.1/§4.2） |
| `DEFAULT_OPTIONS` | `MediaPlayerOptions` | 下表 |

**`DEFAULT_OPTIONS`（MUST 逐字实现；缺省值变更属破坏性变更）**

| 选项 | 默认值 | 语义 | 依据 |
|---|---|---|---|
| `defaultKind` | `'video'` | 缺 `kind` 时的类型 | MDP-CHN-03 |
| `maxChannels` | `6` | 同屏上限（需求门槛）；宿主 MAY 上调并自担 R1 风险 | MDP-MUL-01/02 |
| `maxChannelsByKind` | `{ video: 6, 'image-seq': 6 }` | 每类上限；超限 → `3004` 拒绝并可读 | MDP-MUL-02 |
| `columns` | `'auto'` | 网格列数（规则见下） | MDP-MUL-01/04 |
| `layout` | `'grid'` | `'focus'` = 主路放大 | MDP-MUL-04 |
| `defaultVolume` | `0.8` | 初始音量 | MDP-PLY-03 |
| `audioPolicy` | `'single'` | **至多一路出声** | MDP-PLY-03 |
| `autoPlay` | `false` | 是否自动起播（浏览器策略可能拒绝 → `1003`） | MDP-PLY-01 |
| `defaultLoop` | `false` | 通道未给 `loop` 时的缺省 | MDP-PLY-06 |
| `defaultFrameIntervalMs` | `200` | 图像流轮播间隔 | MDP-PLY-06 |
| `minFrameIntervalMs` | `100` | 最小刷新间隔（节流下限，小于它夹紧） | MDP-MUL-05 |
| `throttleMs` | `100` | 状态/帧事件与重排的合并窗口 | MDP-MUL-05 |
| `preloadFrames` | `1` | 预加载下一帧数（有界，`0..2`） | MDP-MUL-03 / R3 |
| `stepFallbackMs` | `40` | 单帧步进在 fps 未知时的步长 | MDP-PLY-04 |
| `rateOptions` | `[0.5, 1, 2]` | 允许倍速集合 | MDP-PLY-04 |
| `seekTimeoutMs` | `3000` | 定位未在此时限内完成 → 判 Range 降级 | MDP-PLY-02 |
| `lazyVisibility` | `true` | 非可见路按需暂停/降频 | MDP-MUL-03 |
| `hiddenPauseDelayMs` | `500` | 不可见后延迟暂停（防抖动） | MDP-MUL-03 |
| `bufferLimitFrames` | `24` | 图像流帧缓存上限（有界） | MDP-MUL-03 |
| `frameEvents` | `false` | 是否发 `media.frame`（默认关，防高频） | MDP-MUL-05 |
| `measureFps` | `true` | 是否用 rAF 统计 `diagnostics.fps` | MDP-NFR-01 / DGR-04 |
| `overlay.keys` | `OVERLAY_KEYS` | 默认叠加项（未注入内容则不显示） | MDP-OVL-01/02 |
| `overlay.pointerEvents` | `'none'` | 默认穿透 | MDP-OVL-05 |
| `overlay.fit` | `'contain'` | 与媒体 `object-fit` 一致 | MDP-OVL-04 |

**`columns: 'auto'` 列数规则**（可见路数 → 列数）

| 可见路数 | 1 | 2 | 3–4 | 5–6 | 7–9 | ≥10 |
|---|---|---|---|---|---|---|
| 列数 | 1 | 2 | 2 | 3 | 3 | 4 |

---

## 3. 反向接口（宿主必须实现 / 可注入）

> `protocol.md` §6 登记本模块为"**无 sink（前端）**"。因此本节的反向接口是**前端形态**：注入的适配器（`I*`）+ 组件回调。**命名遵循 §6 的 `I<Domain><Role>` 与 `IClock` 冻结签名**；本模块 MUST NOT 新增 `I*Sink`。

### 3.1 `IChannelSource` —— 通道清单来源（**宿主 MUST 提供其一**）

```ts
interface IChannelSource {
  list(signal?: AbortSignal): Promise<unknown>    // 返回 §6.5 任一形状
}
```

| 项 | 规定 |
|---|---|
| 语义 | 唯一清单来源；MDP-CHN-02 要求模块 **MUST NOT 硬编码任何通道名与 URL** |
| 返回值 | `unknown`——三种形状都接受（§6.5）；MUST 由 `normalizeChannels` 归一，非法条目逐条拒绝 |
| 失败 | `list()` reject / 超时 MUST 被模块捕获 → 空清单降级（`emptyReason:'source-error'`）+ `media.error`；**MUST NOT 抛给宿主 UI**（P10） |
| 取消 | 宿主 MUST 尊重 `signal`；组件卸载与 `setChannels` 重入 MUST 中止在途请求 |
| 关系 | `channels` prop 与 `source` 二选一；两者都给时以 `channels` 为准，`source` 仅供 `refreshChannels()` |

### 3.2 `IClock` —— 时间注入（**冻结签名，P9**）

```ts
interface IClock { nowMs(): number }   // epoch 毫秒；与 protocol.md §6 逐字一致
```

| 项 | 规定 |
|---|---|
| 未注入 | 默认 `{ nowMs: () => Date.now() }` |
| 用途 | 状态迁移 `since`、诊断耗时、事件 `ts`、叠加层 `timestampMs` 缺省取值 |
| MUST | 同一被测序列在注入固定时钟下 MUST 完全可复现（时序与节流测试的前提） |
| MUST NOT | 模块内 MUST NOT 直接调用 `Date.now()` / `performance.now()` 作为**语义时间**（性能计时 MAY 用 `performance.now()`，但对外暴露时 MUST 换算为 ms 数值） |

### 3.3 回调（宿主必须实现，出口的**唯一**形态）

```ts
interface MediaPlayerCallbacks {
  onEvent?: MediaEventListener                                            // 全部 media.* 事件（§5）
  onChannelState?: (status: ChannelStatus) => void                        // 状态迁移（MDP-DGR-01）
  onEmpty?: (reason: EmptyReason, detail: { total: number; usable: number; message: string }) => void
}
```

| 项 | 规定 |
|---|---|
| 立即返回 | 回调 MUST 立即返回，MUST NOT 在调用路径上阻塞（对齐 §6 `I*Sink` 语义） |
| 异常 | 回调抛错 MUST 被模块捕获并计数（CTR-MDP-EC-05），MUST NOT 影响播放 |
| 幂等/去重 | 同一次状态迁移 MUST 只回调一次（`since` 变化即一次） |
| 未实现 | 三个回调全部可选；不注入时模块 MUST 正常工作（降级为内部记录） |
| 与 props 的关系 | §2.1.1 的 `MediaPlayerProps` 即在此三项上展开（等价 `…MediaPlayerCallbacks`）；签名以本节为准，两处 MUST NOT 出现差异 |
| 用途 | 宿主据此渲染业务提示、上报诊断、或转发到自己的 WS 出口（转发与登记由宿主负责，§11.3-③） |

### 3.4 可选注入（MAY，缺省有内置行为）

| 适配器 | 签名 | 缺省行为 | 触发场景 |
|---|---|---|---|
| `IFrameUrlResolver` | `resolve(channelId: string, index: number): string \| null` | 用 `url` 模板占位符展开（§6.2） | 滚动窗口帧、非枚举帧源 |
| `IMediaProbe` | `probe(url: string): Promise<{ reachable: boolean; acceptRanges: boolean }>` | 同源 `HEAD` + `Range: bytes=0-0`，看 `206`/`Accept-Ranges` | 进度能力预判（MDP-PLY-02） |

> **内置探测的边界**：仅对同源/相对 URL 发起（§1.4）；跨域 URL MUST NOT 探测，`degraded.range` 置 `false` 且 `hint` 为"未知"。

### 3.5 宿主部署义务（不属于函数签名，但**必需**）

| # | 义务 | 依据 |
|---|---|---|
| H-1 | 静态托管 `/media/**`，且 **MUST 支持 Range**（拖动进度依赖它） | 既有契约 §1；MDP-PLY-02 |
| H-2 | 为媒体容器提供确定尺寸的父容器（宽高为 0 时画面与叠加层不可用） | MDP-OVL-04 |
| H-3 | 全屏：宿主 MUST 授予 `fullscreen` 权限（iframe 场景需 `allow="fullscreen"`） | MDP-PLY-05 |
| H-4 | 素材 MUST 为本地 H.264 mp4 与 jpg/png 序列帧；本模块不做转码 | 决策 MD1/MD2 |
| H-5 | 宿主 MUST NOT 从 `src/**` 深层路径导入，也 MUST NOT 直接操作模块内部媒体元素 | §1.1 |
| H-6 | 多端部署下宿主 SHOULD 只让一个终端出声（模块内仲裁，跨终端不仲裁） | MDP-PLY-03 |

### 3.6 本模块**只消费**的既有接口（不由本模块提供）

| 接口 | 形状 | 归一层 |
|---|---|---|
| `GET /api/v1/media/videos` | `data: [{ name, url }]` | 缺 `id`/`kind` → `id=name`、`kind='video'`（MDP-CHN-03） |
| `GET /api/v1/map/config` 的 `video?: []` | 同上（保留字段） | 同上；宿主 MAY 直投 `channels={config.video}` |
| 任意宿主配置 | `{ schemaVersion, channels: [...] }` | §6.5 |

---

## 4. 错误码

### 4.1 复用 `protocol.md` §3（**MUST 复用，语义不扩大**）

| code | protocol.md 原义 | 本模块用法 | 出现位置 |
|---|---|---|---|
| `0` | 成功（唯一成功码） | 一切成功；幂等命中同样 `0` + `idempotent:true` | 全部方法 |
| `1000` | 请求参数错误 | 入参非法：`rate` 不在集合、`image-seq` 上 `seek`、非法 `kind` 枚举、`transitionMs` 非数 | `MediaResult` |
| `1002` | 冲突拒绝（HTTP 409） | 互斥动作：另一通道正在进出全屏；目标通道正在被释放/替换 | `MediaResult` |
| `1003` | 前置条件未满足 | 未就绪即操作：`idle` 时 `seek`/`stepFrame`；`available:false` 时 `play`；自动播放被浏览器拒绝 | `MediaResult` / `ChannelStatus.errorCode` |
| `1004` | 资源不存在 | `channelId` 不存在；帧下标越界；帧列表为空 | `MediaResult` |
| `1005` | 执行失败（内部错误） | 模块内部异常兜底（含 `dispose()` 后调用、渲染期异常被边界捕获） | `MediaResult` |
| `1006` | 版本不匹配 | 清单 `schemaVersion` 的 `MAJOR` 与 `SUPPORTED_SCHEMA_MAJOR` 不符 → **拒绝装载**，MUST NOT 静默降级 | `MediaSetResultData.rejected` |

> **1005 措辞说明**：`protocol.md` §3.2 写作"服务端执行失败"。本模块无 HTTP 面，复用其"内部错误、可重试、非幂等"的内核语义，**不改变其码值与分工**（§11.3-④）。

### 4.2 模块私有扩展（`3001–3005`，**给出理由**）

**理由**：`protocol.md` §3.2 的码表覆盖"请求/前置/冲突/存在性/内部错误"五类，而前端媒体播放有两类失败它**没有对应码**：①**外部素材不可达/不可解码**（不是请求参数问题，也不是服务端 500）；②**宿主环境能力缺失**（全屏 API、自动播放策略）。若强行塞进 `1005`，宿主无法区分"我传错了参数""素材坏了""浏览器不支持"，DGR-04 的诊断与 DGR-03 的失败隔离也就无法给出可读原因。

| code | 名称 | 含义 | 典型场景 | 可重试 |
|---|---|---|---|---|
| `3001` | `MEDIA_SOURCE_UNREACHABLE` | 媒体源不可达 | 404 以外的网络失败/超时；Range 请求失败；`available:false` 的 url 失效 | 是 |
| `3002` | `MEDIA_DECODE_UNSUPPORTED` | 格式/解码不支持 | mp4 编码不受支持、`video.error.code` 为 `MEDIA_ERR_DECODE/SRC_NOT_SUPPORTED` | 否（换素材） |
| `3003` | `MEDIA_FRAMES_UNAVAILABLE` | 帧序列不可用 | `frames` 为空且模板不可展开；单帧 `onerror` 连续失败；帧清单长度与 `frameCount` 不符 | 是 |
| `3004` | `MEDIA_LIMIT_REJECTED` | 上限/策略拒绝 | 超 `maxChannels` 或 `maxChannelsByKind`；不可见且策略拒绝起播 | 否（改配置） |
| `3005` | `MEDIA_CAPABILITY_MISSING` | 宿主环境能力缺失 | 无 Fullscreen API；无 `requestVideoFrameCallback` 且 fps 未知（降级而非失败，仅在必须能力缺失时报） | 否 |

| 约束 | 内容 |
|---|---|
| CTR-MDP-ERR-01 | 私有码区间 **MUST 只出现在 `MediaResult` / `ChannelStatus.errorCode` / 事件负载**，**MUST NOT** 出现在任何 HTTP 响应信封（本模块无 HTTP 面） |
| CTR-MDP-ERR-02 | 私有码 **MUST NOT** 与 `protocol.md` §3.2 已冻结码重叠（本模块不产生 `1001`、`2001`、`2002`） |
| CTR-MDP-ERR-03 | `code` 是机检依据；`message` / `reason` 为可读中文，MUST NOT 被宿主用于分支判断 |
| CTR-MDP-ERR-04 | 私有码如需全局登记，MUST 走 `protocol.md` §9 修订流程（已登记为开放问题 §14-②） |

### 4.3 明确**不使用**的码

| code | 原因 |
|---|---|
| `1001` | `冲突裁决.md` C15 裁决"保留不用"；幂等成功一律 `code=0` + `idempotent:true` |
| `2001` / `2002` | `protocol.md` §3.2 专指"外部 AI 桥"，与媒体无关（P6：不蹭用语义） |

---

## 5. 事件

### 5.1 命名、信封与频率

| 项 | 规定 | 依据 |
|---|---|---|
| 命名规范 | `media.<subject>`，全小写点分层，匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` | CTR-EV-01 |
| 保留命名空间 | MUST NOT 占用 `sys.*` / `up.*` | CTR-EV-02 |
| 信封 | `{ type, data, ts }` **恰好三字段**，与 `realtime-hub/protocol.md` §1 语法一致（便于宿主原样转发） | 对齐 realtime-hub §1 |
| `data` | MUST 为 JSON 对象、camelCase | CTR-EV-05 / P4 |
| `ts` | 事件**产生**时刻，epoch 毫秒，取自 `IClock`（同一次产生只取一次） | CTR-EV-06 / P5/P9 |
| 频率 | 每通道每 `throttleMs` 至多发一条 `media.state` / `media.frame`；`media.frame` 默认**关闭**（`options.frameEvents=false`） | MDP-MUL-05 |
| 落点 | 未订阅的事件 MUST 被丢弃但计数（MUST NOT 静默 `switch` 掉，对齐 realtime-hub §9.1） | — |
| 广播 | 本模块 **MUST NOT** 广播到 WS（不 import `ws-client`）；**是否转发由宿主决定** | §0.2 / R-2 |

### 5.2 新增事件登记（**拟定，需登记后方可进生产**，CTR-EV-07）

| 事件名 | 负载 `data` | 产生时机 | 依据 |
|---|---|---|---|
| `media.state` | `{ channelId, kind, state, prevState, reason?, errorCode?, at }` | 任一通道状态迁移（去重：同一迁移只发一次） | MDP-DGR-01 |
| `media.error` | `{ channelId, errorCode, reason, recoverable, at }` | 单路失败（含 3001/3002/3003）；`recoverable=false` 表示需换素材 | MDP-DGR-03 |
| `media.empty` | `{ reason, total, usable, message, at }` | 可用通道数为 0（清单为空/全部不可用/来源失败/schema 不符） | MDP-DGR-02 |
| `media.degraded` | `{ channelId?, capability, hint, at }` | 能力降级：`'range'`（无 Range）、`'fullscreen'`、`'autoplay'`、`'visibility'` | MDP-PLY-02 |
| `media.frame` | `{ channelId, frameIndex, frameCount, url?, at }` | 图像流帧推进（**受 `throttleMs` 与 `frameEvents` 双重约束**） | MDP-PLY-06 / MUL-05 |

**`capability` 取值冻结**：`'range' | 'fullscreen' | 'autoplay' | 'visibility'`（新增取值 MUST 先登记）。

### 5.3 与既有事件的关系

| 项 | 结论 |
|---|---|
| 复用 `protocol.md` §4.2/§4.4 事件 | **无**——既有事件全部承载任务/遥测语义，与本模块（画面层）无交集（P6） |
| 是否影响既有前端 | **否**：不改名、不删除、不复用既有名（CTR-EV-03） |
| 登记状态 | 上表 5 个为**拟定**；`protocol.md` §4.4 未登记前，宿主 MAY 仅在本进程内消费（回调），**MUST NOT** 以这些名字对外广播 |

---

## 6. 配置结构（JSON 形状）

### 6.1 宿主配置文件骨架（jsonc）

```jsonc
{
  "media": {
    "schemaVersion": "1.0.0",          // 可选；缺省视为 "1.0.0"；MAJOR 不符 → 1006 拒绝装载
    "channels": [ /* §6.2 */ ],
    "options":  { /* §6.3，全部可选，缺省见 DEFAULT_OPTIONS */ },
    "overlays": { /* §6.4，全部可选 */ }
  }
}
```

| 约束 | 内容 |
|---|---|
| 顶层字段 | `media` 为宿主容器键（宿主可换名，模块不关心）；模块只看 `channels` / `options` / `overlays` |
| 未知字段 | MUST 被忽略（前向兼容，对齐 CTR-PL-03），并计入诊断计数 |
| 是否 rules 包 | **否**。`protocol.md` §5.3 未登记媒体类 `kind`，故本清单**不套用** §5 的 `policiesNamespace/kind/items` 骨架（见 §11.3-②） |
| 缺 `schemaVersion` | 视为 `'1.0.0'`（当前 `SUPPORTED_SCHEMA_MAJOR = 1`） |

### 6.2 通道条目

```jsonc
{
  "id": "cam-1",                       // 可选；缺省由 name 派生；重复时追加 "#2"
  "name": "通道 1",                     // 可选；缺省取 id
  "kind": "video",                     // 可选；缺省 options.defaultKind（'video'）
  "url": "/media/sample-1.mp4",        // video：媒体地址；image-seq：帧模板（含 {i}）或缺省单帧
  "frames": ["/media/s1/a.jpg"],       // 可选；image-seq 显式帧列表，优先于 url 模板
  "frameCount": 60,                    // 可选；url 为模板时的帧数（缺省 1）
  "frameIntervalMs": 200,              // 可选；轮播间隔（夹紧到 >= minFrameIntervalMs）
  "sourceLabel": "光电",                // 可选；来源徽标文本（模块不内置枚举，MDP-CHN-05）
  "available": true,                   // 可选；缺省 true；false = 宿主已知不可用
  "unavailableReason": "设备维护中",     // 可选；available=false 时的可读原因
  "loop": false,                       // 可选；缺省 options.defaultLoop
  "poster": "/media/poster-1.jpg",     // 可选；加载中占位图
  "overlays": { "live": true },        // 可选；该路叠加内容（优先级见 §6.4）
  "overlayKeys": ["live", "boxes"],    // 可选；该路开启的叠加项（缺省取 options.overlay.keys）
  "meta": { "any": "value" }           // 可选；原样透传，模块 MUST NOT 解释（P6）
}
```

**`kind` 归一化别名表**

| 输入 | 归一为 | 说明 |
|---|---|---|
| `"video"`、`"mp4"` | `'video'` | 需求专篇写 `video`（mp4） |
| `"image-seq"`、`"imageSeq"` | `'image-seq'` | 需求专篇逐字为 `image-seq`；camelCase 写法因 P4 一并接受 |
| 其它任意值 | — | 该条目判**不可用**（`reason:'unknown-kind'`），MUST NOT 报错、MUST NOT 猜测（前向兼容） |

**`url` 模板占位符（image-seq）**

| 占位符 | 含义 | 示例 |
|---|---|---|
| `{i}` | 帧下标，**0 基**、无补零 | `/media/s/{i}.jpg` → `/media/s/0.jpg` |
| `{i:4}` | 帧下标，左补零到 4 位 | `/media/s/{i:4}.jpg` → `/media/s/0007.jpg` |
| 无占位符 | 视为**单帧**（`frameCount = 1`） | `/media/frame.jpg` |

> 模板 MUST NOT 含查询串注入；展开结果 MUST 只由 `url` + 下标构成（§1.4 零外网）。

### 6.3 `options`（JSON 形状与 §2.6 默认表一一对应）

```jsonc
{
  "options": {
    "defaultKind": "video",
    "maxChannels": 6,
    "maxChannelsByKind": { "video": 6, "image-seq": 6 },
    "columns": "auto",
    "layout": "grid",
    "defaultVolume": 0.8,
    "audioPolicy": "single",
    "autoPlay": false,
    "defaultLoop": false,
    "defaultFrameIntervalMs": 200,
    "minFrameIntervalMs": 100,
    "throttleMs": 100,
    "preloadFrames": 1,
    "stepFallbackMs": 40,
    "rateOptions": [0.5, 1, 2],
    "seekTimeoutMs": 3000,
    "lazyVisibility": true,
    "hiddenPauseDelayMs": 500,
    "bufferLimitFrames": 24,
    "frameEvents": false,
    "measureFps": true,
    "overlay": { "keys": ["live","magnification","timestamp","channelName","source","boxes"],
                 "pointerEvents": "none", "fit": "contain" }
  }
}
```

| 约束 | 内容 |
|---|---|
| 部分覆盖 | 未给字段 MUST 取 `DEFAULT_OPTIONS`（CTR-PL-04 同款口径）；缺失 MUST NOT 导致失败 |
| 非法取值 | 枚举非法 → `1000` 拒绝该字段并保留原值（**MUST NOT** 使整包失败）；数值越界 → 夹紧 + `clamped` |
| 时钟/适配器 | **MUST NOT** 出现在 JSON 里（不可序列化）——一律走 `adapters`（§3） |

### 6.4 `overlays`

```jsonc
{
  "overlays": {
    "keys": ["live", "magnification", "timestamp", "channelName", "source", "boxes"],
    "pointerEvents": "none",
    "fit": "contain",
    "byChannel": {
      "cam-1": {
        "live": true,
        "magnification": "×4",
        "timestampText": "2026-09-12 10:00:00",
        "sourceLabel": "光电",
        "boxes": [
          { "id": "b1", "rect": { "x": 0.42, "y": 0.35, "w": 0.18, "h": 0.24 },
            "style": "lock", "color": "#ef4444", "label": "03", "thickness": 2 }
        ],
        "extra": [ { "key": "flag", "text": "跟踪中", "corner": "tr" } ]
      }
    }
  }
}
```

**叠加内容优先级（MUST）**：`overlays.byChannel[id]` > 通道条目 `overlays` > 空。
`boxes` 与 `extra` **不合并**：取最高优先级的那一份（避免半新半旧的框）。

### 6.5 兼容输入形状（三种，MUST 全部接受）

```jsonc
// ① 既有接口原样：GET /api/v1/media/videos → data
[ { "name": "通道 1", "url": "/media/a.mp4" }, { "name": "通道 2", "url": "/media/b.mp4" } ]

// ② 完整条目数组
[ { "id": "cam-1", "name": "通道 1", "kind": "video", "url": "/media/a.mp4" } ]

// ③ 带版本的信封
{ "schemaVersion": "1.0.0", "channels": [ /* ① 或 ② 的元素 */ ] }
```

| 输入 | 归一结果 |
|---|---|
| ① 的元素 | `id = name`（重名追加 `#2`）、`kind = 'video'`、`available = true`、其余取缺省 |
| ② | 按 §6.2 逐字段归一 |
| ③ | 校验 `schemaVersion` 后处理 `channels` |
| 非数组且非对象 / `channels` 非数组 | 整体拒绝：`MediaSetResultData.rejected` 含 `{index:-1, code:1000}`，`media.empty(reason:'no-channels')` |
| 元素非对象 | 该条 `rejected`（`code:1000`），其余照常（部分成功） |

### 6.6 版本与 `1006`

| 情况 | 行为 |
|---|---|
| `MAJOR` 相同、`MINOR`/`PATCH` 更高 | 正常装载；未知字段忽略并计数（CTR-PL-03） |
| `MAJOR` 不同 | **拒绝装载**（`rejected` 含 `code:1006`），可用通道数 0 → 隐藏入口 + `media.empty(reason:'schema-mismatch')`；MUST NOT 静默降级（对齐 §5.2） |
| `schemaVersion` 非语义化版本串 | 视为 `1000` 参数错误（该条整体拒绝），不影响其它来源 |

---

## 7. 降级与缺省行为矩阵

### 7.1 清单级（决定"入口是否显示"，MDP-DGR-02）

| 场景 | 界面 | 状态 | 事件 / 回调 | 原因可读性 MUST |
|---|---|---|---|---|
| 未传 `channels` 且未注入 `source` | **隐藏入口**（渲染 `null`） | 空清单 | `media.empty` + `onEmpty('no-source')` | "未提供通道清单来源" |
| `channels: []` / `{channels: []}` | **隐藏入口** | 空清单 | `onEmpty('no-channels')` | "通道清单为空" |
| 清单全部 `available:false` | **隐藏入口** | 空清单，逐条 `idle`+原因 | `onEmpty('all-unavailable')` | 附被标记不可用的条数 |
| `source.list()` 失败/超时/abort 以外的错误 | **隐藏入口** | 空清单 | `media.error` + `onEmpty('source-error')` | 附错误摘要 |
| `schemaVersion` MAJOR 不符 | **隐藏入口** | 拒绝装载 | `onEmpty('schema-mismatch')` | 附期望/实际 MAJOR |
| 全部条目非法（无 id 可派生 / 无 url） | **隐藏入口** | 逐条 `rejected` | `onEmpty('all-unavailable')` | 逐条原因（MUST NOT 只报"失败"） |
| 有 ≥1 可用通道 | 正常渲染 | — | — | — |

> **MUST NOT** 在任何一行渲染空面板、黑框、空网格或"暂无数据"占位（MDP-DGR-02）。宿主若需自己的提示，用 `onEmpty` 在模块**之外**渲染。

### 7.2 条目级（单条缺字段的缺省，MDP-CHN-01/03）

| 缺什么 | 归一行为 | 该条可用性 |
|---|---|---|
| `kind` | 取 `options.defaultKind`（`'video'`） | 可用 |
| `kind` 未知值 | 保留原值于诊断，内部判不可用（`reason:'unknown-kind'`） | 不可用 |
| `id` | 由 `name` 派生；无 `name` 则由 `url` 派生；重名追加 `#2`、`#3` | 可用 |
| `id` 与 `name` 与 `url` 全缺 | 该条 `rejected`（`1000`），MUST NOT 影响其它条 | 丢弃 |
| `name` | 取 `id` | 可用 |
| `url`（video） | 无源 | 不可用（`reason:'missing-src'`） |
| `url` + `frames`（image-seq）都缺 | 无源 | 不可用（`reason:'missing-src'`） |
| `frames: []` 且 `url` 无占位符且 `frameCount>1` | 矛盾输入 | 不可用（`reason:'no-frames'`，`3003`） |
| `frameCount` | `1`（无模板时）/ `frames.length`（有 `frames` 时） | 可用 |
| `frameIntervalMs` | `options.defaultFrameIntervalMs`；小于 `minFrameIntervalMs` 夹紧 | 可用 |
| `sourceLabel` | 不显示徽标，MUST NOT 报错 | 可用（MDP-CHN-05） |
| `available` | `true` | 可用 |
| `available:false` | 不渲染画面（占用上限名额但不出声、不加载） | 不可用（`reason` 取 `unavailableReason`） |
| `loop` | `options.defaultLoop` | 可用 |
| `overlayKeys` | `options.overlay.keys` | 可用 |
| `overlays` 内容缺项 | 该项不渲染、不留占位（MDP-OVL-02） | 可用 |
| `meta` | `{}`；MUST NOT 解释 | 可用 |

### 7.3 运行级

| 场景 | 模块行为 | 依据 |
|---|---|---|
| 单路 404 / 网络失败 | 该路 `state:'error'`、`errorCode:3001`、`reason` 可读；其余路 MUST 继续（**MUST NOT** 连带暂停/清空） | MDP-DGR-03 |
| 单路解码失败 | 该路 `error` + `3002`；`media.error(recoverable:false)`；不重试轰炸（重试上限 2 次，退避 1s/2s） | MDP-DGR-03 |
| 帧 `onerror` | 跳过该帧并把 `frameIndex` 前移；连续 3 帧失败 → 该路 `error` + `3003` | MDP-DGR-03 |
| 超上限 | 该条不渲染、不加载；`3004` + `media.error`；`policyRejections++`；已在播的路 MUST 不受影响 | MDP-MUL-02 |
| 不可见（`setVisible(false)` 或宿主判定离屏） | `lazyVisibility:true`：`hiddenPauseDelayMs` 后暂停解码 / 停轮播，`pausedByPolicy:true`；重新可见 MUST 自动恢复原状态 | MDP-MUL-03 |
| 无 Range | `degraded.range:true` + `hint`（可读提示）；`seek` 仍执行但 MUST 给提示，MUST NOT 静默失败；`media.degraded(capability:'range')` | MDP-PLY-02 |
| 定位超 `seekTimeoutMs` | 判为 Range 降级（同上），并把 `seekMs` 记入诊断 | MDP-PLY-02 / DGR-04 |
| 自动播放被拒 | `state:'ready'`（画面首帧可绘）+ `media.degraded(capability:'autoplay')`；**MUST NOT** 循环重试 | MDP-PLY-01 |
| 全屏 API 不存在 | `enterFullscreen` 回 `3005` + 可读提示；界面按钮 SHOULD 禁用 | MDP-PLY-05 |
| 全屏 ↔ 退出 | MUST 复用同一媒体元素；退出后布局回到进入前、**进度连续**；同步重算叠加层基准（同一帧内完成） | MDP-PLY-05 / OVL-04 |
| `IClock` 未注入 | 用 `Date.now`；诊断与事件时间仍为 epoch ms | P9 |
| `IFrameUrlResolver` 未注入 | 用 `url` 模板展开（§6.2） | MDP-PLY-06 |
| `IMediaProbe` 未注入 | 内建同源探测（§3.4） | MDP-PLY-02 |
| 全部回调未注入 | 正常工作，事件进内部环形缓冲（容量 `256`，供 `getDiagnostics()` 与排障） | — |
| `dispose()` 后调用任一方法 | `{ok:false, code:1005, message:'已释放'}`；**MUST NOT** 抛错 | P10 |
| 宿主回调抛异常 | 捕获 + 计数（CTR-MDP-EC-05），播放不受影响 | — |

### 7.4 状态机（MDP-DGR-01，迁移表冻结）

| 当前 | 触发 | 迁移到 | 附加要求 |
|---|---|---|---|
| `idle` | `play` / `autoPlay` | `loading` | 开始加载；`since` 更新 |
| `loading` | 首帧可绘 | `ready` → 随即 `playing` | `diagnostics.loadMs` 落值（NFR-01 口径） |
| `loading` | 加载失败 | `error` | `reason` MUST 非空，`errorCode` 必填 |
| `ready` | `play` | `playing` | — |
| `playing` | `pause` | `paused` | — |
| `paused` | `play` | `playing` | — |
| `playing` | `play`（重复） | `playing` | 幂等：`code 0` + `idempotent:true`，**MUST NOT** 触发重载 |
| `playing` | 播到末尾 | `paused`（`positionMs = durationMs`）+ 保持最后一帧 | 循环开启时 MUST 回到 0 继续 `playing` |
| 任意 | `stop` | `idle` | 位置归零、释放解码与缓冲 |
| `playing` | 不可见 + `lazyVisibility` | `paused` | `pausedByPolicy:true`；重新可见恢复 `playing` |
| `error` | `setChannels` 换源 / `pushFrame` / `play`（重试） | `loading` | **MUST 可恢复**（不得进入死态） |
| 任意 | `dispose` / 被移除 | （移除） | 停止解码、清缓冲、置静音 |

> **可机检**：`CHANNEL_STATES` 为闭集；任何未列出的迁移 MUST NOT 发生；`error` 态的 `reason` 与 `errorCode` MUST 同时非空。

### 7.5 出声仲裁矩阵（MDP-PLY-03 / MUL-04）

| `audioPolicy` | 主路 | 最近一次 `play` | 结果（`audibleId`） | 其余通道 |
|---|---|---|---|---|
| `'single'`（默认） | 有、可用、未用户静音 | — | 主路 | MUST 强制静音（`mutedByPolicy:true`） |
| `'single'` | 有、但用户静音 | 有 | `null`（**MUST NOT** 自动改让别的路出声） | MUST 保持静音 |
| `'single'` | `null` | 有 | 最近 `play` 且未静音的那一路 | MUST 强制静音 |
| `'single'` | `null` | 无 | `null` | MUST 静音（`audible:false`） |
| `'all'` | — | — | 最近 `play` 且未静音的通道（仅供展示） | 用户静音意图各自生效 |
| `'none'` | — | — | 恒 `null` | MUST 全部静音 |

| 约束 | 内容 |
|---|---|
| CTR-MDP-AU-01 | `'single'` 下任一时刻**至多一路** `audible:true`（六路同屏验收点） |
| CTR-MDP-AU-02 | 主路设置/取消 MUST 立即重新仲裁（"切换主路声音跟随"） |
| CTR-MDP-AU-03 | `mute(id,false)` 在策略覆盖时 MUST 返回 `code 0` 且 `data.policyOverride = true`；`muted` 仍为 `true`（有效静音），MUST NOT 悄悄出声 |
| CTR-MDP-AU-04 | 通道被移除/失败/不可见暂停时 MUST 立即重新仲裁，MUST NOT 残留声音（MDP-CHN-04） |
| CTR-MDP-AU-05 | 仲裁 MUST 由 `pickAudible()` 实现，界面与控制器 MUST 共用同一函数（避免两套口径） |

---

## 8. 叠加层与画面帧对齐（MUST 级）

### 8.1 坐标系基准（MDP-OVL-03/04）

| 项 | 规定 |
|---|---|
| 基准 | **画面内容框**（content box）——媒体画面在容器内的实际绘制矩形，**不是**容器矩形 |
| 原点 | 内容框左上角 |
| 取值范围 | 0–1（`NormRect`）；`x/w` 沿水平，`y/h` 沿垂直 |
| 不变式 | `normToPx(pxToNorm(r, box), box) ≈ r`（误差 ≤ 1 px）；该不变式 MUST 进单测 |
| 禁止 | 叠加层 MUST NOT 使用容器百分比、`vw/vh`、`window.innerWidth`、视口坐标定位 |

### 8.2 内容框计算（`mediaContentBox`）

| `fit` | 计算 | 说明 |
|---|---|---|
| `'contain'`（默认） | `s = min(cw/mw, ch/mh)`；`w = mw*s`、`h = mh*s`、`x = (cw-w)/2`、`y = (ch-h)/2` | 画面完整可见，两侧留黑边；**黑边内的归一化坐标仍指向画面**（不是黑边） |
| `'cover'` | `s = max(cw/mw, ch/mh)` | 返回**未裁剪**内容框（可能超出容器）；渲染侧 MUST 裁剪到容器 |
| `'fill'` | `box = 容器` | 画面被拉伸，归一化坐标与容器一致 |
| `media === null`（尺寸未知） | `box = 容器` | MUST 在 `loadedmetadata` / 首帧到达后立即重算 |

### 8.3 重算触发点（缺一不可）

| 触发 | 要求 |
|---|---|
| 容器尺寸变化（`ResizeObserver`） | MUST 重算并在**同一动画帧内**重绘叠加层 |
| `fullscreenchange` | MUST 重算；MUST 复用同一媒体元素（进度不丢） |
| 媒体实际尺寸到达（`loadedmetadata` / 首帧 `onload`） | MUST 重算（此前按容器基准，属可接受的短暂过渡） |
| 源切换（`url`/`kind` 变化） | MUST 重置为容器基准后再重算 |
| 窗口 `resize` / 设备方向变化 | SHOULD 依赖 `ResizeObserver` 而非 `window.onresize`（面板尺寸与窗口尺寸常不等） |

| 约束 | 内容 |
|---|---|
| CTR-MDP-OVL-01 | 叠加层与画面 MUST 使用**同一份** `box` 值驱动（画面定位与叠加层定位共享计算，MUST NOT 各算一遍） |
| CTR-MDP-OVL-02 | 连续 resize 与全屏切换过程中 MUST NOT 出现可见错位（验收：以 1px 容差比对同帧 `box` 与叠加层实测矩形） |
| CTR-MDP-OVL-03 | 叠加层的 DOM MUST 与媒体元素同处一个 `position: relative` 容器内，MUST NOT 用 `position: fixed` 除非全屏态 |

### 8.4 越界与裁剪规则

| 情况 | 行为 |
|---|---|
| `rect` 分量非有限数（`NaN`/`Infinity`） | 该框不渲染并计入诊断（MUST NOT 让整层失败） |
| `x`/`y` 或 `w`/`h` 部分越界 | **裁剪**到 [0,1] 内渲染；`w`/`h` 裁剪后 ≤ 0 则不渲染 |
| 完全在 [0,1] 之外 | 不渲染该框（MUST NOT 夹紧成边缘假框），计入 `droppedFrames`? 否——计入叠加层诊断计数 |
| `style:'lock'` | 矩形 + 四角标记 + 十字准星（对应初稿"红色锁定十字框"） |
| `style:'crosshair'` | 仅十字准星，中心 = 框中心 |
| `thickness` | CSS px；不随画面缩放变化（MUST NOT 用归一化表达粗细） |

### 8.5 穿透（MDP-OVL-05）

| `pointerEvents` | 要求 |
|---|---|
| `'none'`（默认） | 叠加层容器 MUST `pointer-events: none`；子元素 MUST NOT 反向开启；播放控件 MUST 可点击（验收：点击落到底层控件） |
| `'auto'` | 叠加元素可命中；但播放控件区域 MUST NOT 被遮挡（控件区域 MUST 保持在叠加层之上或留出安全区） |

---

## 9. 性能与可观测口径（MDP-NFR-01 / DGR-04）

| 指标 | 口径（MUST 一致） | 暴露位置 | 门槛 |
|---|---|---|---|
| 首帧耗时 `loadMs` | 从 `play`/`setChannels` 发起加载 → 首帧可绘（video `loadeddata`；image-seq 首帧 `onload`） | `ChannelStatus.diagnostics.loadMs` | ≤ **1 s**（局域网，video） |
| 定位耗时 `seekMs` | `seek` 调用 → `seeked` 事件 | 同上 | ≤ **500 ms** |
| 界面帧率 `fps` | `requestAnimationFrame` 计数，窗口 1000 ms；仅 `measureFps:true` 且有 DOM 时非空 | `MediaDiagnostics.fps` | 6 路同屏 ≥ **25 fps** |
| 节流 | 每通道每 `throttleMs` 至多一次重排/事件；图像流间隔下限 `minFrameIntervalMs` | `diagnostics.throttleMs` | 见 MDP-MUL-05 |
| 有界缓存 | 帧缓存 ≤ `bufferLimitFrames`；`setChannels`/`dispose` MUST 释放 | 实现内 + 诊断 | 长时间运行内存有界 |
| 失败计数 | `loadFailures`、`lastErrorAt`、`bufferingCount`、`droppedFrames` | `ChannelDiagnostics` | 可读、可导出 |

| 约束 | 内容 |
|---|---|
| CTR-MDP-PERF-01 | 模块侧 MUST 提供上述可观测项；**帧率门槛的判定归示例页与验收脚本**（模块不阻塞渲染） |
| CTR-MDP-PERF-02 | R1 风险应对：宿主 MAY 用 `maxChannels` 下调到 4 路，或调大 `throttleMs`；此类调整 MUST 只改配置，MUST NOT 改代码 |
| CTR-MDP-PERF-03 | 诊断 MUST NOT 因开启而显著改变性能：`measureFps:false` 时 MUST 完全不启动 rAF 计数 |

---

## 10. 最小用法示例（25 行，可编译）

```tsx
// demo/main.tsx —— 独立示例页（素材全部本地，零外网请求）
import { createRoot } from 'react-dom/client'
import { MediaPlayer, type MediaPlayerHandle, type MediaEvent, type RawChannelEntry } from '@mapapp/media-player'

const channels: RawChannelEntry[] = [
  { id: 'a', name: '通道 1', kind: 'video', url: '/media/sample-1.mp4', sourceLabel: '光电', loop: true },
  { id: 'b', name: '通道 2', kind: 'video', url: '/media/sample-2.mp4', sourceLabel: '雷达' },
  { id: 'c', name: '序列 1', kind: 'image-seq', url: '/media/seq/{i:3}.jpg', frameCount: 60, frameIntervalMs: 200 },
]

const onEvent = (ev: MediaEvent) => console.log('[media]', ev.type, ev.data)

createRoot(document.getElementById('root')!).render(
  <MediaPlayer
    channels={channels}
    mainChannelId="a"
    layout="grid"
    options={{ audioPolicy: 'single', autoPlay: true, maxChannels: 6 }}
    overlays={{ byChannel: { a: { live: true, magnification: '×4', timestampMs: 1700000000000,
      boxes: [{ id: 'k1', rect: { x: 0.42, y: 0.35, w: 0.18, h: 0.24 }, style: 'lock' }] } } }}
    onEvent={onEvent}
    onEmpty={(reason) => console.warn('无可用通道：', reason)}
    ref={(h: MediaPlayerHandle | null) => h && console.log(h.getSummary())}
  />
)
```

要点：清单来自宿主（模块零硬编码）；`image-seq` 用模板占位符；锁定框用归一化坐标；`onEmpty` 只在模块之外提示（模块已隐藏自身）。

---

## 11. 与 `protocol.md` 的一致性自检

### 11.1 P1–P10 逐条

| # | protocol.md 原则 | 本模块落实 | 判定 |
|---|---|---|---|
| P1 | 引擎间 MUST NOT 互相 import | 只走 `src/index.ts`；MUST NOT import `map-2d` / `ws-client` / 其它引擎（红线 R-1/R-2） | ✅ |
| P2 | 引擎 MUST NOT 依赖 Web 框架 | **分层落实**：控制器 `createMediaController` 与 7 个纯函数 MUST NOT import `react`（node 可直接跑）；仅视图层（4 组件 + 1 Hook）依赖 `react`/`react-dom` | ⚠️ **需分层解读**（§11.3-①） |
| P3 | 引擎 MUST NOT 依赖 SQL | 无持久化；不留存、不落库（专篇 §1.3） | ✅ |
| P4 | 对外字段 camelCase | 全部公开字段 camelCase（唯一例外是**枚举值** `'image-seq'`，与需求专篇逐字一致） | ✅ |
| P5 | 时间戳 epoch 毫秒（`ts`） | 全部时间字段 `…Ms`/`At`/`ts` 为 epoch ms；人类可读串只由宿主以 `timestampText` 注入 | ✅ |
| P6 | 引擎 MUST NOT 内建业务名词 | 通道名/来源/倍率/锁定框/时间戳文本全部注入；`meta` 原样透传不解释（红线 R-3 可机检） | ✅ |
| P7 | 业务内容一律来自规则包 | 通道清单与叠加内容**全部注入**；模块不含任何具体通道名/URL（MDP-CHN-02） | ✅（形态差异见 §11.3-②） |
| P8 | 出口 MUST 为反向接口 | 出口 = 宿主注入的回调（§3.3）；`IClock` 按 §6 冻结签名注入 | ✅（§6 登记本模块"无 sink"，故不新增 `I*Sink`） |
| P9 | 时间 MUST 可注入（`IClock`） | `IClock.nowMs()` 可注入；缺省 `Date.now`；时序与节流测试可复现 | ✅ |
| P10 | 失败 MUST NOT 抛异常跨边界 | 一切方法回 `{ok, code, message}`（§1.3）；`normalizeChannels` 与 7 个纯函数同样不抛 | ✅ |

### 11.2 可机检断言（供验收脚本逐条落地）

| # | 断言 | 方式 |
|---|---|---|
| 1 | 全仓 import 检索 `map-2d` / `ws-client` → **零命中** | 文本检索 |
| 2 | 全仓检索业务词（任务/方案/目标/场景/阶段/编组/评估/威胁/集群）→ **零命中** | 文本检索 |
| 3 | 源码内检索具体通道名/URL（`/media/` 之外的 http(s) 地址）→ **零命中** | 文本检索 |
| 4 | `package.json`：`dependencies` 为空；`peerDependencies` 仅 `react`/`react-dom` | 解析 JSON |
| 5 | 控制器与纯函数文件内检索 `from 'react'` → **零命中** | 文本检索 |
| 6 | `normalizeChannels` 对 6 类非法输入（非对象/元素非对象/缺 url/未知 kind/空 frames/schema MAJOR 不符）**不抛异常**且逐条给原因 | 单测 |
| 7 | `[{name,url}]` 原样输入 → 全部归一为 `kind:'video'` 且可用 | 单测 |
| 8 | 空清单 / 未注入来源 / 全部不可用 → 组件渲染 `null` 且 `onEmpty` 收到对应 `reason` | 单测 |
| 9 | `CHANNEL_STATES` 闭集外的迁移不发生；`error` 态 `reason` 与 `errorCode` 同时非空 | 单测 |
| 10 | `'single'` 策略下 6 路 `audible:true` 的数量 ≤ 1；切主路后唯一出声路跟随 | 单测 |
| 11 | 幂等命中 = `code 0` + `idempotent:true`；冲突（双通道争全屏）= `1002` | 单测 |
| 12 | `normToPx(pxToNorm(r, box), box) ≈ r`（≤1px）；`contain/cover/fill` 三档内容框取值符合 §8.2 | 单测 |
| 13 | 越界框：部分越界被裁剪、完全越界不渲染、`NaN` 不致命 | 单测 |
| 14 | 超上限 → `3004` 拒绝且 `policyRejections++`；已在播的路不受影响 | 单测 |
| 15 | 一路非法 url → 该路 `error`，其余路状态不受影响（**故障隔离**） | 单测 |
| 16 | 新增事件名匹配 `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$` 且不占 `sys.`/`up.` | 正则 |
| 17 | `setChannels` 移除通道后：无残留 `audible:true`、无在途加载、`getChannels()` 不含旧 id | 单测 |
| 18 | 示例页在断网条件下可完整运行（素材全本地） | 手工/脚本 |
| 19 | `npm run build` 成功、`node scripts/verify.mjs` 退出码 0 | CI |

### 11.3 与 `protocol.md` 的差异与登记请求（**不构成实现冲突**）

| # | 项 | 事实 | 处置 |
|---|---|---|---|
| ① | **P2"引擎 MUST NOT 依赖 Web 框架"** | 本模块是前端渲染模块，视图层必须用 React（硬性要求，对齐 `map-2d` 先例） | 按**分层**落实：核心零框架依赖（可 node 单测），框架只在视图层。建议 `protocol.md` 在 P2 补一句"前端渲染模块：机制层零框架，视图层可用宿主同款框架" |
| ② | **§5 policies schema 不适用** | §5.3 的 13 个 `kind` 无媒体类；本模块清单不套用 `policiesNamespace/kind/items` 骨架 | 本波**不新增 kind**（新增即修订 §5.3）。登记为开放问题 §14-① |
| ③ | **§4 事件名待登记** | 拟定 `media.state/error/empty/degraded/frame` 五个本地事件名 | CTR-EV-07 要求登记后方可发布：**登记前只走回调，MUST NOT 对外广播**；登记请求见开放问题 §14-③ |
| ④ | **错误码扩展 `3001–3005`** | §3.2 无"素材不可达/解码不支持/帧序失败/上限拒绝/环境能力缺失"对应码 | 已给理由（§4.2）；仅用于本地结果，不进 HTTP 信封；登记请求见 §14-② |
| ⑤ | **§6 反向接口** | §6 冻结表登记 `media-player` = 无 sink | 本契约严格遵守：**零 `I*Sink`**，出口为回调；`IClock` 签名逐字一致；`IChannelSource` / `IFrameUrlResolver` / `IMediaProbe` 为"来源/能力"型注入，不属 sink |
| ⑥ | **C15/C16 口径** | 幂等与冲突 | 已严格对齐：幂等 = `code 0` + `idempotent:true`；冲突 = `1002`（且 `protocol.md` 的 HTTP 409 列对前端无意义，故只保留码） |

> **结论**：与 `protocol.md` **无 MUST 级实现冲突**；上表 6 项中 ①②③④ 为**待登记/待措辞补充**，⑤⑥ 为**已一致**。

---

## 12. 需求覆盖矩阵（28 条 → 契约条款）

| 编号 | 契约落点 |
|---|---|
| MDP-CHN-01 | §2.5 `MediaChannel`/`RawChannelEntry`、§6.2、§7.2 |
| MDP-CHN-02 | §0.3 R-3、§3.1 `IChannelSource`、§11.2-3 |
| MDP-CHN-03 | §6.5、§7.2、§11.2-7 |
| MDP-CHN-04 | §2.3-1 `setChannels`（释放语义）、§2.3-37 `dispose`、§7.5 CTR-MDP-AU-04、§11.2-17 |
| MDP-CHN-05 | §2.5 `sourceLabel`、§7.2（缺省不显示徽标）、§2.1.3（`source` 叠加项） |
| MDP-PLY-01 | §2.1.1 `ref` → `MediaPlayerHandle`、§2.3-10~13、§2.1.4 |
| MDP-PLY-02 | §2.3-14 `seek`、§3.4 `IMediaProbe`、§7.3 无 Range 行、§2.5 `degraded` |
| MDP-PLY-03 | §2.3-15/16、§7.5 仲裁矩阵、§2.6 `audioPolicy` |
| MDP-PLY-04 | §2.3-17/18、§2.6 `rateOptions`/`stepFallbackMs` |
| MDP-PLY-05 | §2.3-28/29/30、§7.3 全屏行、§8.3（全屏重算）、§2.1.2（复用媒体元素） |
| MDP-PLY-06 | §2.3-19/20/21、§6.2 占位符、§7.4 播到末尾行 |
| MDP-MUL-01 | §2.6 `maxChannels=6`、§2.6 `columns` 规则 |
| MDP-MUL-02 | §2.6 `maxChannelsByKind`、§4.2 `3004`、§7.3 超上限行 |
| MDP-MUL-03 | §2.3-25 `setVisible`、§2.6 `lazyVisibility`/`bufferLimitFrames`、§9 有界缓存 |
| MDP-MUL-04 | §2.3-22/23/26/27、§2.1.1 主路行、§7.5 CTR-MDP-AU-02 |
| MDP-MUL-05 | §2.6 `throttleMs`/`minFrameIntervalMs`、§5.1 频率行、§9 节流行 |
| MDP-OVL-01 | §2.5 `OverlayKey`、§2.3-32 `toggleOverlay`、§2.1.3 关闭项行 |
| MDP-OVL-02 | §2.5 `OverlayContent`、§2.1.3 未注入行、§6.4 优先级 |
| MDP-OVL-03 | §2.5 `OverlayBox`/`NormRect`、§8.1/§8.2 |
| MDP-OVL-04 | §8.1 CTR-MDP-OVL-01/02、§8.3 触发点表 |
| MDP-OVL-05 | §2.6 `overlay.pointerEvents`、§8.5 |
| MDP-DGR-01 | §2.5 `ChannelState`/`ChannelStatus`、§2.3-5~9、§7.4 状态机 |
| MDP-DGR-02 | §7.1 清单级矩阵、§2.1.1 空清单行、§5.2 `media.empty` |
| MDP-DGR-03 | §7.3 前三行、CTR-MDP-EC-04、§11.2-15 |
| MDP-DGR-04 | §2.5 `ChannelDiagnostics`/`MediaDiagnostics`、§9 口径表 |
| MDP-NFR-01 | §9 指标门槛、§11.2-19（构建与验收）、CTR-MDP-PERF-01 |
| MDP-NFR-02 | §0.3 红线、§1.4 零外网、§11.2-1/2/3/18 |
| MDP-NFR-03 | §1.1 交付形态、§11.2-19（单测零框架 + 验收脚本退出码） |

---

## 13. 接口速查表

| 我想…… | 用 |
|---|---|
| 挂一个媒体面板 | `<MediaPlayer channels={list} />`（清单为空时自动隐藏） |
| 从宿主接口取清单 | `<MediaPlayer source={{ list: () => fetch(...).then(r=>r.json()) }} />` |
| 用接口驱动播放/查询状态 | `ref` → `MediaPlayerHandle`（`play/pause/stop/seek/getStatus/getSummary`） |
| 纯逻辑/单测（无 DOM） | `createMediaController({ channels, options, adapters })` |
| 归一化任意清单形状 | `normalizeChannels(raw)` |
| 6 路同屏且只一路出声 | `options.audioPolicy:'single'` + `mainChannelId` |
| 指定主路 / 取消主路 | `controller.setMain(id)` / `setMain(null)` |
| 图像流轮播与推帧 | 通道 `kind:'image-seq'` + `frameIntervalMs`；实时用 `pushFrame(id, url)` |
| 叠倍率/时间戳/通道名/来源/实时标识 | `overlays.byChannel[id] = { live, magnification, timestampText, sourceLabel }` |
| 画锁定框（归一化坐标） | `boxes: [{ id, rect:{x,y,w,h}, style:'lock' }]` |
| 关闭某个叠加项 | `controller.toggleOverlay(id, 'timestamp', false)` |
| 叠加层穿透/可交互 | `overlays.pointerEvents: 'none' \| 'auto'` |
| 单通道全屏 | `controller.enterFullscreen(id)` / `exitFullscreen()` |
| 隐藏某路以省资源 | `controller.setVisible(id, false)`（按需暂停/降频） |
| 看诊断（首帧/定位/丢帧/缓冲） | `controller.getDiagnostics()`、`status.diagnostics` |
| 无素材时不显示空面板 | 无需配置：空清单 MUST 隐藏；宿主用 `onEmpty` 自己提示 |
| 收到状态/失败/降级事件 | `onEvent` / `controller.subscribe`（`media.*`，§5.2） |

---

## 14. 开放问题（不阻塞本契约发布）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| ① | 通道清单是否需要成为 `protocol.md` §5.3 的一个 `kind`（如 `mediaChannels`）？ | 是否需要"换一套系统 = 换一组规则文件"的同构待遇 | 本波**不做**；若要做，须先修订 `protocol.md` §5.3（登记为修订请求） |
| ② | 私有错误码 `3001–3005` 是否需并入 `protocol.md` §3.2 全局码表？ | 跨模块码表一致性 | 建议在 §3.2 增设"前端媒体"小节并登记；登记前保持本地使用 |
| ③ | `media.*` 五个事件名是否登记进 `protocol.md` §4.4？ | CTR-EV-07 要求登记后方可发布 | 建议登记；登记前宿主 MUST NOT 对外广播这五个名字 |
| ④ | P2 的措辞是否补充"前端渲染模块：机制层零框架、视图层同宿主框架"？ | 后续前端模块（`view-composer` 等）同样会遇到 | 建议在 `protocol.md` §9 走一次非破坏性措辞补充 |
| ⑤ | 需求专篇 §10 的 5 项待确认（素材来源、序列帧是否必须动态、平板帧率门槛、坐标换算归属、远程流立项） | MDP-CHN-01、PLY-06、NFR-01、§4、MD6 | 与本契约不冲突：契约已把这些点做成**可配置/可注入**（`maxChannels`、`rateOptions`、`frameIntervalMs`、`IFrameUrlResolver`），口径定了只改配置 |
| ⑥ | `video: {name,url}[]` 在 `map/config` 中的保留字段是否随本模块一起收敛为统一形状 | 宿主接入成本 | 建议保留双形状（模块已兼容）；收敛属宿主侧决定 |

---

## 15. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | — | 首版：公开入口 63 条（4 组件 + 1 Hook + 1 工厂 + 7 纯函数 + 8 常量 + 42 类型）、控制器 37 项成员、反向接口 5 条（含冻结 `IClock`）、错误码（复用 7 + 私有 5 并给理由）、事件（新增 5 个，待登记）、配置 JSON（通道/选项/叠加三块 + 三种兼容输入）、降级矩阵（清单级/条目级/运行级 + 状态机 + 出声仲裁）、叠加层归一化对齐（内容框 + 重算触发 + 越界规则）、性能可观测口径、25 行最小示例、P1–P10 自检与 19 条机检断言、28 条需求覆盖矩阵、6 项开放问题 |
