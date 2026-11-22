# Tsubasa 系列：共享设计语言与控件层

Tsubasa Terminal 属于 **Tsubasa 系列**，姊妹项目是 TsubasaRedisManager（Vue 3 + Tauri v2 的 Redis 桌面客户端）。
目标是两者**一眼认得出同门**。本文记录当前的共享约定：统一什么、不统一什么、控件层与令牌怎么写、
第三方许可如何登记。配色派生的细节见 [appearance-design.md](appearance-design.md)。

引用姊妹项目文件时用相对位置（同级目录 `../TsubasaRedisManager/…`）：它的设计文档在 `doc/fe_design/`，
令牌在 `src/styles/tokens.css`，那边的约定成文度更高，改动共享约定前先读。

## 1. 统一形制，不统一色温

**形制**指字体、字号档位、图标尺寸、控件高度与密度、标题栏与侧栏结构、品牌色；**色温**只指整体偏浅还是偏深。
标志感来自形制而不是色温——数据管理器用浅色（密集表格），终端默认深色（内容区是最深的那口井），各是本场景的正解。
本项目的明暗由所选终端配色方案决定（见 [appearance-design](appearance-design.md#2-明暗判定与亮色派生)），
亮色阶梯按姊妹项目的浅色令牌标定。

技术栈天然同门，差异只在样式层：

| | TsubasaRedisManager | Tsubasa Terminal |
| --- | --- | --- |
| 框架 | Vue 3 | Vue 3 |
| 无头组件 | `reka-ui` | `reka-ui` |
| 图标 | `lucide-vue-next` | `lucide-vue-next` |
| 样式 | 手写 CSS + 令牌变量 | Tailwind 4 + `@theme inline` 令牌，控件层手写 CSS |
| 外壳 | Tauri v2，自绘标题栏 | Electron，自绘标题栏内容 + 原生窗口按钮 |

## 2. 三条硬规则

姊妹项目 `doc/fe_design/README.md` 的三条硬规则，翻译到终端：

1. **色彩总纲：每种颜色只出现在约定的位置。**
   - 交互强调色 = `--ring`，派生自方案的光标色（姊妹项目叫 `--accent`，我们这里该名被 shadcn 灰阶占用）。
   - 语义色 `--ok` / `--warn` / `--danger` / `--info` 固定、不派生，明暗各一套。
   - 环境色（生产橙、实验天蓝）只出现在标签页色点、终端区顶缘光条和审批卡徽标。
   - 品牌色只给应用图标，界面里不出现。
   - 已知重叠：实验天蓝与默认方案强调蓝 `#7aa2f7` 同属蓝色系。
2. **类型色/标识只在少数落点出现**，内容区内部不上色。环境标识的两个常驻落点（tab 色点 + 顶缘光条）即此思路。
3. **等宽只给数据**，判据是"这段文字是不是数据本身"，不是它在哪一层：终端网格、转录、命令、路径、文件名、
   面包屑用等宽；UI 文案、按钮、**主机名（用户起的标签）**用界面字体。

## 3. 令牌约定

规则由 `tests/unit/designTokens.test.ts` 扫描渲染层源码守着：字号只写角色类、颜色只写令牌、图标只用尺寸类。

### 3.1 字体

- 界面 `--ff-ui`：Inter 打头的栈；UI 里的等宽 `--ff-mono`：JetBrains Mono 打头（审批卡命令、路径、徽标数字）。
  两者都**不随包打包**，同姊妹项目只排在栈首。
- `--ff-mono` 与终端网格无关。终端网格字体由用户在设置里选，回退栈 `FONT_FALLBACK_STACK`（`shared/terminalThemes.ts`）
  有 CJK 全宽对齐的硬要求，**不要动它**。

### 3.2 字号角色

组件写角色类，不写像素或 Tailwind 尺寸档（`text-xs`、`text-[10px]` 等）；手写 CSS 的 `font-size` 走 `--fs-*` 变量。

| 角色类 | 字号 | 用途 |
| --- | --- | --- |
| `text-badge` | 10 | 徽标 |
| `text-meta` | 11 | 元信息 |
| `text-list` | 12 | 列表行 |
| `text-body` | 13 | 正文（基准） |
| `text-title` | 14 | 标题 |
| `text-code` | 11.5 | 等宽数据（同层界面字小半号） |
| `text-code-body` | 12.5 | 等宽正文 |

等宽比同层界面字体小 0.5px：JetBrains Mono 视觉高度略大于 Inter。新增角色须同步登记到 `lib/utils.ts` 的
`TEXT_ROLES`，否则 `cn()`（tailwind-merge）会把它当颜色类，与 `text-ok` 之类合并时吞掉字号。
界面字号三档由 `--fs-step`（0 / 1 / 2px）整体平移。

### 3.3 图标

只留 **12 / 16** 两档（20 只给空状态），用 `.i-12` / `.i-16` / `.i-20` 统一给尺寸与描边（1.5 / 1.75 / 1.75，
Lucide 的 `stroke-width` 是 24 网格单位）。不用 14：Lucide 画在 24px 网格上，12 与 16 落整像素，14 的描边落半像素发虚。
唯一例外是复选框里的对勾（`ui/Cbx.vue`，`:size="12"`）。

### 3.4 其他

- 会渲染变化数字的地方（用量、时间、大小、退出码、token 总量）用 `tabular-nums`（`.num`），避免重绘抖动。
- **密度三档**（`:root[data-density]` compact / 标准 / cozy）只改行高与控件高、不改字号：主机行 `--py-host`
  4 / 8 / 12px、文件行 `--h-tree-base` 18 / 20 / 24px、控件 `--h-ctl` 26 / 28 / 30px。标准档即默认观感。
- 文字四级 `--fg` … `--fg-4`、表面七阶及其派生规则见 [appearance-design](appearance-design.md#1-主题贯穿外壳从终端底色派生)。
- 焦点环只在 `:focus-visible` 显示。
- 类名不起 `.empty` 这类泛化名字；自写 CSS 类放 `@layer components`，定宽助手用 `wf-` 前缀。

## 4. 控件层

`src/renderer/src/components/ui/`（`Dlg` / `Btn` / `Sw` / `Cbx` / `Sel` / `ConfirmDlg` / `Sash`）与
`assets/{controls,overlay}.css`。**行为用 reka-ui（普通 npm 依赖），外观用本仓库自己的 CSS**；CSS 移植自姊妹项目的
同名样式表，令牌名照抄，两边可逐行对读。不复制第三方组件源码进仓库（如 shadcn-vue 的分发方式），
否则须逐个登记出处与许可。

与姊妹项目的有意分歧：

- **弹窗尺寸给上界，不给固定高度**。最小窗口 960×600，姊妹项目那种 860×560 定高加头部与边距会超出、裁掉内容。
- **下拉框只抄闭合态，且自备 `<button><selectedcontent>`**（`Sel.vue`）。`main.css` 用 `appearance: base-select`
  接管暗色下原生弹层的反色，照抄姊妹项目的 `appearance: none` 会推翻这条修复；而 base-select 下 select 是 flex 容器，
  `overflow` 被 UA 锁成 `visible`、承载选中文本的匿名盒作者够不着，所以闭合态必须自己提供内容盒。

## 5. 尚未对齐：全局禁止文本选中

姊妹项目全局 `user-select: none` + `cursor: default`，需要选中的地方单开白名单——桌面应用不是网页。本项目尚未采用，
须单独一版做。约束：终端区由 xterm 自管选中，**必须排除**；转录、审批卡命令文本等要能选中复制的内容进白名单；
剪贴板整条链挂在选中行为上，改动须对照 [focus-design](focus-design.md) 逐项验证。

## 6. 品牌色

品牌色为紫：沿用姊妹项目品牌渐变的公式换色相（Catppuccin Latte mauve 的色相约 297°，两端保持其 Redis 红的
OKLCH 明度与彩度），`#9c70ee → #7b4aca`，只用于应用图标。标题栏保留本项目自己的应用图标，不照搬姊妹项目的
`.brand-mark`（那是它尚未画图标时的占位）。不选蓝：它是默认方案的强调色，也接近实验环境的天蓝；
青离天蓝与成功绿太近；靛在小尺寸上会被看成蓝。

## 7. 第三方许可清单

- 仓库根的 `LICENSE`（本程序许可）、`THIRD_PARTY_NOTICES.md`（清单，供人读）、`THIRD_PARTY_LICENSES.txt`
  （许可证全文，承担分发义务）由 electron-builder 的 `extraResources` 装进安装目录的 `resources/`；
  Electron / Chromium 那层由 electron-builder 自带的许可文件承担，落在 exe 同级。
- 清单与全文由 `scripts/gen-notices.mjs` 生成（借自姊妹项目的同名脚本）。口径是 `dependencies` 的闭包，
  加上被渲染层打进 bundle 的 dev 依赖（脚本内 `BUNDLED_DEV` 显式登记）；许可证全文按内容去重，各包版权行逐字保留。
- 增删、升级依赖后跑 `npm run gen:notices` 并随依赖改动一起提交。`check:notices`（`--check` 比对）在
  `npm run typecheck` 与 CI 里，清单过期或出现未登记的打包 dev 依赖即失败。细节见
  [development](development.md#第三方许可清单)。
