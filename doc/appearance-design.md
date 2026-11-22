# 外观设计：主题贯穿与环境标识

[agent-design.md](agent-design.md) 的双通道原则在外观层的落地：**环境色是氛围，风险色是事件**。
本文管氛围这一侧——配色方案如何贯穿整个外壳、明暗如何判定、环境标识落在哪里。

| 代码 | 职责 |
| --- | --- |
| `src/shared/terminalThemes.ts` | 配色方案定义、`minimumContrastFor`、终端字体回退栈 |
| `src/shared/shellPalette.ts` | OKLCH 色彩数学与外壳派生 `deriveShell`（主进程建窗与渲染层共用） |
| `src/renderer/src/lib/appTheme.ts` | `applyAppTheme`：把派生结果写成 CSS 变量、切 `<html>` 的 `dark` class |
| `src/renderer/src/assets/main.css` | 不派生的固定色令牌（语义色、环境色、阴影），明暗各一套 |
| `src/renderer/src/lib/env.ts` | 主机环境等级的视觉 token |
| `src/renderer/src/lib/localFonts.ts` | 终端字体枚举 |

## 1. 主题贯穿：外壳从终端底色派生

不维护独立的 UI 主题（那会变成两套各自维护的色板）。**终端底色是唯一的锚**，外壳的表面阶梯
沿 OKLCH 的 L 轴走，H 保留，C 保留但不超过 `SHELL_CHROMA_CAP = 0.05`（防止外壳比终端还艳；
内置方案底色彩度最高约 0.030，这道闸对它们不触发，留作新增方案的护栏）。

### 1.1 暗色阶梯

暗底往**亮**抬而不是往暗压：终端是内容区，应是整屏最深的那口井，外壳每加一层亮一档，
"控件比它所在的卡片亮"自然成立。`RUNGS`（相对锚点 L₀ 的增量）：

| 阶 | ΔL | CSS 变量 | 用途 |
| --- | --- | --- | --- |
| background | +0.025 | `--background` | 左右栏底 |
| card | +0.050 | `--card` / `--popover` | 弹窗、卡片 |
| subtle | +0.065 | `--bg-subtle` | 弹窗页脚、tab 条、设置导航、标题栏 |
| muted | +0.080 | `--muted` / `--accent` / `--secondary` | 选中项、静音区；暗色下也是控件面 |
| active | +0.105 | `--bg-active` | 悬停、按下、分段控件选中块 |
| border | +0.130 | `--border` / `--input` / `--bd` | 分隔线 |
| borderStrong | +0.190 | `--bd-strong` | 弹窗与浮层外框 |

**锚点明度下限 `SHELL_ANCHOR_FLOOR_L = 0.13`**（仅暗色）：L₀ = `max(底色 L, 0.13)`。
sRGB 传输函数在低端极陡，同样 +0.025 在 L₀=0.21 上是 6 个 8bit 级，在 L₀=0 上不足 0.1 级——
纯黑底直接跑阶梯会全档塌掉（左右栏与终端区逐字节相同、分隔线 1.04:1）。0.13 由两条边界夹出：
低于 0.06 时最窄一档（subtle→muted）在 8bit 上剩不到 3 级；高于 0.21（默认方案的 L₀）
外壳就和普通深色方案一样亮，"纯黑"失去意义。0.13 下外壳底约 `#0c0c0c`、分隔线对底 1.26:1，
比常规方案弱一档但立得住。只兜底、不设上限，常规暗色方案 L₀ 都高于它，派生不受影响；
**终端网格仍用方案原值**。

### 1.2 文字与强调

| 派生值 | 变量 | 规则 |
| --- | --- | --- |
| 正文 `foreground` | `--foreground` / `--fg` | 方案前景只压彩度到 `SHELL_FG_CHROMA_CAP = 0.02`，L、H 不动 |
| 次级 `foreground2` | `--fg-2` | 正文与三级的明度中点（三级达标则中点必达标） |
| 三级 `mutedForeground` | `--muted-foreground` / `--fg-3` | 暗色：从 L=0.66 起对 muted 底逐级提亮到 4.5:1，上限正文 L−0.02 |
| 四级 `quietForeground` | `--fg-4` | 从三级实际明度往底色方向走，取最后一个仍 ≥3:1 的位置 |
| `ring` | `--ring` / `--primary` | 方案光标色，过对比闸 `gateRing` |
| `primaryForeground` | `--primary-foreground` | 暗色取 background、亮色取 card（离正文最远的那级底） |

- **前景彩度闸 0.02**：前景若原样透传，Tokyo Night、Gruvbox、Catppuccin 这类前景 C≥0.04 的方案
  会把色偏染到整个外壳（"套了滤镜"）。0.02 是实测分界：前景 C≤0.0164 的方案逐字节不变，
  只压高彩度的；只压彩度保住方案调性。**终端网格不受影响**——色偏属于内容，这里治的是容器。
- **三级不能比正文亮**：上限正文 L−0.02。正文自己太暗的方案会停在不达标处，那是正文的账，
  不能让次要文字倒挂来补。验对比取 muted 这一级：它是放文字的底里离正文明度最近的一级，
  且确实有 `text-muted-foreground` 落在上面。
- **四级按 3:1**：占位符、计数、禁用态是装饰性文本，按 WCAG UI 组件线收；起点用三级的实际明度，
  固定起点在偏亮底上会一步跌破 3:1、退化成与三级同色。
- **强调色对比闸**：光标色天生是每套方案的强调色，直接征用为 ring/primary。判据两处都按 4.5:1：
  `primaryForeground` 压在 ring 上（主按钮文字），ring 当文字色压在 muted 底上（链接、`text-primary`）。
  不够就保持色相彩度、沿明度往正文方向挪到刚达标；已达标原样返回。终端光标不受影响。

### 1.3 落地形态

- `deriveShell` 在 `src/shared/`：主进程建窗时用同一套派生给原生窗口底色与标题栏按钮区上色
  （否则亮色用户启动先闪一下暗色）。
- `applyAppTheme` 把结果 `setProperty` 到 `documentElement.style`，优先级天然高于 `main.css`
  里 `.dark` 的类选择器定义，**不动任何组件**；`.dark` 里的同名值只是首帧兜底。
  同时按明暗切 `<html>` 的 `dark` class，`color-scheme`（原生滚动条、`select::picker`）与第 3 节
  的固定色都挂在它上面。`App.vue` 随 `settings.terminalTheme` 重算。
- 控件层变量名（`--bg-subtle` / `--bd` / `--fg-2` / `--bg-ctl` 等）沿用姊妹项目 TsubasaRedisManager
  的令牌表，两边 CSS 可逐行对读。少一个 `--accent`：我们这里它被 shadcn 灰阶占用，
  交互强调色直接写 `--ring`。
- 色彩数学（sRGB ↔ 线性 ↔ OKLab ↔ OKLCH）手写不引依赖。CSS 的 `oklch()` 能写但读不回分量，
  转换必须在 JS 里做；也不能用 `color-mix()` 代替——明度阶梯要在感知均匀空间里走，
  sRGB 混合在深色端会塌陷。
- e2e 断言色值读 `documentElement.style` 上的变量文本，不读 `getComputedStyle`（会被归一化成 `rgb()`）。

## 2. 明暗判定与亮色派生

**没有单独的明暗开关**：`schemeOf` 以终端底色 OKLCH 明度 > 0.6 判为浅色，明暗跟着方案走，
不存在"亮外壳配暗终端"。内置方案两极分明（暗色 L₀ ≤ 0.324、亮色 ≥ 0.958），单测守着不让新方案落进中间带。

### 2.1 亮色阶梯 `LIGHT_RUNGS`

亮色不是把暗色方向翻过来：暗色下"浮起"（弹窗、下拉、控件面）和"强调"（悬停、选中、分隔线）
都往亮走，一条轴就够；亮色下两者分家——浮层更白、靠阴影浮起，强调与侧栏更暗。只翻正负号会让弹窗比侧栏还灰。

| 阶 | ΔL | 锚点为纯白时对标的姊妹项目令牌 |
| --- | --- | --- |
| background | −0.020 | `--bg-sidebar #f8f8fa` |
| card | +0.020（在 L=1 截平） | `--bg-app` / 控件底 `#fff` |
| subtle | −0.026 | `--bg-chrome #f6f6f8` |
| muted | −0.038 | `--bg-inset #f2f2f5` |
| active | −0.056 | 我们自己的一档，落在它 hover −0.044 与 active −0.074 之间 |
| border | −0.074 | `--bd #e6e6ea` |
| borderStrong | −0.116 | `--bd-strong #d8d8de` |

即：以纯白为锚时，派生阶梯的明度落在 TsubasaRedisManager 浅色令牌上，"同门"在亮色下可测
（`tests/unit/appTheme.test.ts` 守着）。幅度只有暗色的约六成：亮端人眼对明度差更敏感。
以 Catppuccin Latte 底 `#eff1f5` 为锚，background −0.02 恰好落在它自己的 mantle 附近——
侧栏比编辑区暗一档本就是该方案的结构。亮色不需要锚点上限：sRGB 高端不陡。

亮色下控件面、分段控件选中块、开关圆钮（`--bg-ctl` / `--bg-ctl-on` / `--knob`）都取 card（白），
靠边框与阴影立起来；暗色下分别是 muted / active / 正文色。

### 2.2 亮色文字

- **正文明度上限 `LIGHT_SHELL_FG_MAX_L = 0.25`**：外壳正文不沿用终端前景的明度。终端前景是给成段
  等宽字调的（Latte 有意偏柔，L≈0.435），外壳是 11–13px 的 UI 小字，中灰笔画整根发虚；
  取姊妹项目 `--fg #17171b`（L≈0.206）的量级。0.25 下 Latte、One Half Light 正文对侧栏约 13–14:1，
  保留方案色相、不拍成纯黑；比 0.25 暗的前景原样保留。暗色不设此上限。
- **三级按 6:1**（`LIGHT_MUTED_FG_CONTRAST`），从 muted 底明度往暗走取第一个达标值，下限正文 L+0.02。
  三级承载主机 IP、标签元数据这类仍要读的小字，"最淡的 AA 达标值"在亮底上读作发虚。
- 四级仍按 3:1，方向往亮走；ring 过同一道对比闸（Latte 的 rosewater 光标对底仅 2.34:1）。

### 2.3 终端网格的最低对比度

`minimumContrastFor`：浅色方案开 xterm `minimumContrastRatio = 3`，暗色为 1（关闭）。

- 只给浅色开：远端程序大多默认背景是暗的，白字（`\e[37m` / `\e[97m`）压在浅底上近乎隐形。
  xterm 在渲染时压暗前景，方案原值不动。
- 取 3 不取 4.5：xterm 按 RGB 三通道每轮乘 0.9 直到达标且会冲过目标，4.5 会把整套浅色板压浑
  （Latte 的黄变土棕）。3 足够救回白字，彩色只暗一两档、仍是原色调。
- 暗色方案的 16 色已逐色标定，开了会改掉既有观感。

## 3. 固定色令牌：明暗各一套

表面与文字派生；**语义色、环境色、阴影、遮罩不派生**，在 `main.css` 以 `:root`（暗色）与
`:root:not(.dark)`（亮色）各给一套固定值。语义色若取方案的 ANSI green/yellow，Gruvbox 的橄榄绿就成了
"成功"色，且每套方案 × 每个语义都要重验对比度——"这条信息是好是坏"不该随配色漂移。

| 令牌 | 暗色 | 亮色 | 用途 |
| --- | --- | --- | --- |
| `--ok` / `--ok-fg` | `#5fbf80` / `#9ee0b4` | `#166534`（同值） | 成功 |
| `--warn` / `--warn-fg` | `#d9a441` / `#ecc98a` | `#92400e`（同值） | 警告 |
| `--danger` / `--danger-fg` | `#ef6a72` / `#ffa8ae` | `#991b1b`（同值） | 危险 |
| `--info` | `#0ea5e9` | `#075985` | 进行中、提示 |
| `--env-prod` / `--env-prod-fg` | `#f97316`（同值） | `#c2410c` / `#9a3412` | 生产环境：色点与光条 / 文字 |
| `--env-exp` / `--env-exp-fg` | `#0ea5e9`（同值） | `#0369a1` / `#075985` | 实验环境 |
| `--sh-1/2/3`、`--sh-pop` | 纯黑 0.2–0.55 透明度 | `rgb(20 20 30)` 0.04–0.14 | 阴影 |

- **暗色语义色两级**：`--x` 中间调给开关、徽标边框、图标、进度条（UI 组件，3:1）；`--x-fg` 亮调给
  banner 与 tag 上的长文字（4.5:1，最差方案 Nord 的 card 阶上仍 ≥4.9:1）。行内状态字直接用 `--x`。
- **亮色语义色合一级**：同姊妹项目"深色文字压浅色底"，行内字、徽标、banner 都要 4.5:1，
  没有中间调的余地。判据是三套亮色锚点（Latte / One Half Light / 纯白）最差处：muted 底 ≥5.0:1、
  15% 色底上 ≥4.7:1；Tailwind -700 档在 Latte 底只有 3.9:1，故取 -800 档。
- **亮色环境色分两级**：光条与色点只需非文字 3:1 且要"还是橙/蓝"（取 -700 档），文字取 -800 档。
- **遮罩**：`useDialogScrim` 的黑色透明度暗色 0.58、亮色 0.34（姊妹项目浅色遮罩的量级；保持纯黑以便
  原生按钮预合成）。阴影亮色值同样取姊妹项目浅色量级。
- **组件里不写 Tailwind 调色板色号**（`emerald-500`、`orange-500` 之类只为暗底调过，压在亮底上做文字
  只有 2–3:1），一律写令牌类名 `text-ok` / `bg-warn/15` / `bg-env-prod`。`tests/unit/designTokens.test.ts`
  扫描渲染层源码守着这条，以及字号角色类、图标尺寸类（规则见 [tsubasa-alignment.md](tsubasa-alignment.md)）。
- 界面字号三档（`data-ui-font-size` → `--fs-step` 0/1/2px）与密度三档只动尺寸，与配色无关。

## 4. 配色方案

- **每套方案必须给满 ANSI 16 色**。缺省时 xterm.js 回落到内置 Tango 板，那是给浅底调的：压在深底上
  blue（`ls` 的目录名）只有 3.28:1，16 色里 5 色低于 AA。
- 色值**照社区原值，不改**——改了就不再是那套方案。取不到可读性的方案宁可移除（Solarized Dark 因此
  被移除：前景明度过低是本体问题，不改原值救不回来）。老配置里存的已移除 id（`RETIRED_TERMINAL_THEMES`）
  由主进程 `settings.ts` 读盘时改写为默认方案，避免设置页下拉框拿着无对应选项的值。
- **默认方案 `tsubasaterminal`**（显示名"Tsubasa Terminal（默认）"）：底 `#16181f`、前景 `#b9bec9`（9.5:1）。
  底色不用纯黑——近黑底配亮白字会到 13:1 以上，白字边缘晕开（halation），暗色舒适带取 8–11:1；
  16 色统一在 5.9–9.1:1。brightBlack 有意留在 3.2:1：它的语义就是次要信息，拉到 4.5 破坏 dim 的表意。
- **纯黑 OLED（`pitch-black`）**：舒适带不适用。底固定 `#000000`、正文纯白，halation 是明确接受的代价——
  纯黑底上对比度等于绝对亮度，守舒适带只能压暗前景，那正是要避免的。彩色统一明度（普通六色 L=0.80、
  bright 六色 L=0.85）以求并排均衡，灰阶全部无彩。外壳由 1.1 节的锚点下限兜底。
- **浅色方案**（Catppuccin Latte、One Half Light）：选中即切亮色界面。Catppuccin 两套的 16 色取官方
  `catppuccin/palette` 的 `ansiColors` 映射；Latte 的 magenta 一对例外，用同色板的 mauve `#8839ef`
  （官方映射的 pink 压浅底仅 2.34:1）。

## 5. 标题栏与弹窗遮罩

- 窗口用 hidden title bar + native overlay，高度 38 逻辑像素，布局按原生控制安全区避让，macOS 保留系统交通灯。
- 标题栏背景取派生的 `subtle`，Windows / Linux 原生按钮符号取 `foreground2`，由 `TitleBar.vue` 调
  `deriveShell` 后经类型化 IPC 下发。同步失败时标题栏显示重试入口，不静默成功。
- 弹窗遮罩盖不住原生按钮：`Dlg` 以真实遮罩 DOM 的挂载/卸载维护遮罩层数，`useDialogScrim` 单一定义透明度，
  同时供 DOM 样式与原生背景/符号色预合成。多层弹窗按透明度叠加（`1 − (1 − α)^n`），最后一层卸载才恢复；
  弹窗内切换主题也要带上遮罩合成。只同步配色，原生按钮的操作语义不变。

## 6. 环境标识

环境标识不复用风险的绿黄红（生产机满屏常红会稀释高危 ring 的信号量），生产用橙、实验用天蓝；
**不做背景染色或水印**，只做点、线、徽章级的存在。常驻落点只有两个：

| 落点 | 说明 |
| --- | --- |
| tab 色点 + "生产"/"实验"字样 | 身份标记，色形双编码，切 tab 时认机器 |
| 终端区顶缘 2px 光条（仅生产） | 氛围 |

审批卡上的环境徽章是**事件**现场的标注，不算常驻氛围，保留。

顶缘光条 `absolute inset-x-0 top-0 h-0.5` + `pointer-events-none`，不进布局，**不碰 `term.open` 的目标元素**
（padding / FitAddon 约束见 [focus-design 的实现接缝](focus-design.md#实现接缝)）。约束：

- **满不透明，不叠 alpha**：半透明橙压在深底上合成为去饱和的棕（`orange-500/45` → `#773b13`，对底 2.24:1），
  既不够警示又是脏色；满不透明 `#f97316` 对默认底 6.33:1。
- **单边、替代既有线**：它落在 tab 条 `border-b` 的位置上，不与既有分隔线并排重影；四边封闭框会和
  tab 条、左右栏的 1px 分隔线叠成双线，且封闭矩形与扁平三栏的语言冲突。
- **TUI 态仍在**：光条在终端区上，composer 让位时不消失，因此不需要底栏常驻徽章兜底。
- **不加落点**：多个弱信号叠起来是噪声，常驻标识还会被习惯化。

给生产会话的终端底色注入阈下暖色相是被考虑过的更强一档，不做：与"不做背景染色"原则冲突，
且会破坏冷色系方案的性格、需要逐方案标定。

## 7. 终端字体枚举

设置页字体下拉由 `lib/localFonts.ts` 的 `detectMonospaceFonts` 提供，选中值原样放在 `buildFontFamily`
回退栈最前面，所以**下拉里的名字必须是系统字体的真实 family 名**，差一个词 xterm 就静默落到回退栈。

- **不能用 `document.fonts.check` 判断系统字体**：它只管 FontFaceSet 里的网页字体，对系统字体（乃至随手编的名字）
  一律返回 true。
- **正常路径**：`window.queryLocalFonts()`（Local Font Access）取全部系统字体 family 名，canvas 量四组字符宽度
  筛等宽，剔除 Marlett / Wingdings 这类 ASCII 位画图标的符号字体。Electron 默认放行，打包后的 `file://`
  与 dev 的 localhost 都是安全上下文；不需要用户手势，每次打开设置现探。
- **退路**：API 不可用或被拒时，对 `FONT_CANDIDATES` 做度量探测（带与不带该字体宽度是否变化；同时比 monospace
  与 serif 两个通用族，因为 Consolas 本身就是 Windows 的 monospace）。
- **已存字体探测不到**：仍列为选项并标注「（未安装）」，不能让设置页看起来像已生效。
- 回退栈 `FONT_FALLBACK_STACK` 西文等宽在前、CJK 等宽殿后，保证汉字严格 2:1 全宽、网格不错位，不要动它。
