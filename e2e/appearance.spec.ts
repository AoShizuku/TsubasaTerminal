import { readFileSync } from 'fs'
import { join } from 'path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'
import { contrastRatio, deriveShell } from '../src/shared/shellPalette'
import { themeById } from '../src/shared/terminalThemes'

/**
 * v0.9 外观：配色方案切换即时应用（共享设置 store → 终端区/xterm）并持久化。
 * v0.9.1 追加：主题贯穿——UI 外壳的 CSS 变量从终端 background 沿 OKLCH 派生。
 */

/** 断言 documentElement 上的内联变量原文，不走 getComputedStyle（会被 UA 归一成 rgb()） */
const shellVar = (page: import('@playwright/test').Page, name: string): Promise<string> =>
  page.evaluate((n) => document.documentElement.style.getPropertyValue(n).trim(), name)

const cssRgb = (hex: string): string => {
  const value = hex.replace('#', '')
  return `rgb(${parseInt(value.slice(0, 2), 16)}, ${parseInt(value.slice(2, 4), 16)}, ${parseInt(value.slice(4, 6), 16)})`
}

const rgbToHex = (rgb: string): string =>
  '#' +
  rgb
    .match(/\d+/g)!
    .slice(0, 3)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('')

let ssh: FakeSshServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  ssh = await startFakeSshServer()
})

test.afterAll(async () => {
  await ssh.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

test('配色/字号变更即时生效并写入 settings.json', { tag: '@daily' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page

  // 默认背景（tsubasaterminal 主题 v0.9.1 重做：#16181f，脱离纯黑）
  await expect(page.getByTestId('terminal-area')).toHaveCSS(
    'background-color',
    'rgb(22, 24, 31)'
  )

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-theme').selectOption('dracula')
  // 终端区背景即时跟随主题（#282a36）
  await expect(page.getByTestId('terminal-area')).toHaveCSS(
    'background-color',
    'rgb(40, 42, 54)'
  )
  // 派生色的完整矩阵在 component/unit 层；e2e 只守设置→root变量→真实消费这条接线。
  const draculaShell = deriveShell(themeById('dracula').theme)
  await expect.poll(() => shellVar(page, '--background')).toBe(draculaShell.background)
  await expect(page.locator('body')).toHaveCSS('background-color', cssRgb(draculaShell.background))
  await page.getByTestId('settings-font-size').fill('16')
  await page.getByTestId('settings-font-size').dispatchEvent('change')
  await page.getByTestId('settings-close').click()

  const settings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(launched.userDataDir, 'settings.json'), 'utf-8'))
  await expect.poll(() => settings().terminalTheme).toBe('dracula')
  await expect.poll(() => settings().terminalFontSize).toBe(16)

  // 已开会话仍可用（主题热切换不打断终端）
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
})

/**
 * v0.13.0 修订：`appearance: base-select` 下 select 是 flex 容器，且 UA 把
 * `overflow` **硬锁成 visible**、`align-items` 留在 normal(stretch)。两个后果都只有
 * 自备 `<button><selectedcontent>` 才治得了（见 components/ui/Sel.vue）：
 * 长字体名会整段溢出、把设置弹窗撑出横向滚动条；文字比中线高半个行距。
 */
test('下拉框：长选项省略不溢出、文字居中，展开时 ESC 只关弹层', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    // 持久化的自定义字体名会被 unshift 进候选表，长度不受候选清单约束
    settings: { terminalFontFamily: 'CaskaydiaCove Nerd Font Mono 超长名字' }
  })
  app = launched.app
  const page = launched.page

  await page.getByTestId('open-settings').click()
  const box = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="settings-font"]') as HTMLSelectElement
    return {
      align: getComputedStyle(sel).alignItems,
      scrollW: sel.scrollWidth,
      clientW: sel.clientWidth,
      hasButton: !!sel.querySelector(':scope > button selectedcontent')
    }
  })
  expect(box.hasButton).toBe(true)
  expect(box.align).toBe('center')
  // 不溢出 = 省略号真的生效了（溢出时实测 scrollWidth 266 / clientWidth 159）
  expect(box.scrollW).toBeLessThanOrEqual(box.clientW + 1)

  // 弹层开着时 ESC 归弹层；再按一次才轮到弹窗
  await page.getByTestId('settings-theme').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-theme')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('settings-theme')).toHaveCount(0)
})

/**
 * 终端字体下拉走真实系统字体枚举（Local Font Access）。旧实现用 document.fonts.check
 * 过滤写死候选，系统字体无论装没装都返回 true，下拉框里的名字可能本机根本没有，
 * 选了 xterm 也只会静默落回退栈。这条经过 Electron 里真实的字体 API 与 xterm 接线。
 * e2e 只在 Windows 本地跑，Consolas 是系统自带字体。
 */
test('字体下拉列出本机真实字体名，未安装的已存字体标注，选中后终端即用', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalFontFamily: 'Definitely Not A Font' }
  })
  app = launched.app
  const page = launched.page

  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.getByTestId('open-settings').click()
  const font = page.getByTestId('settings-font')
  await expect(font.locator('option[value="Definitely Not A Font"]')).toHaveText(
    'Definitely Not A Font（未安装）'
  )
  await expect(font.locator('option[value="Consolas"]')).toHaveCount(1)
  // 符号字体量宽也等宽，但不能进终端字体表
  await expect(font.locator('option[value="Marlett"]')).toHaveCount(0)

  await font.selectOption('Consolas')
  await expect
    .poll(() => page.locator('.xterm-rows').first().evaluate((el) => getComputedStyle(el).fontFamily))
    .toMatch(/^Consolas,/)
  await expect
    .poll(() => JSON.parse(readFileSync(join(launched.userDataDir, 'settings.json'), 'utf-8')).terminalFontFamily)
    .toBe('Consolas')
})

/**
 * v0.14.2 设计语言对齐：界面与 UI 等宽的字体栈同姊妹项目，Tailwind 的 font-sans /
 * font-mono 接到同一套变量上（不留第二套栈）。终端网格字体不受影响。
 */
test('界面字体栈接到对齐后的变量，终端网格仍走自己的字体栈', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  const fonts = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.className = 'font-mono'
    document.body.append(probe)
    const result = {
      body: getComputedStyle(document.body).fontFamily,
      mono: getComputedStyle(probe).fontFamily,
      grid: getComputedStyle(document.querySelector('.xterm-rows')!).fontFamily
    }
    probe.remove()
    return result
  })
  expect(fonts.body).toMatch(/^Inter, "Inter Variable", "Segoe UI Variable Text"/)
  expect(fonts.mono).toMatch(/^"JetBrains Mono", "Cascadia Mono"/)
  expect(fonts.mono).toMatch(/"Microsoft YaHei UI", monospace$/)
  expect(fonts.grid).toMatch(/^"Cascadia Mono", Consolas, "Sarasa Mono SC"/)

  // 字号按角色：@theme 的 text-* 角色类真的生成进了产物（拼错角色名不会报错，只会静默不生效）
  await expect(page.locator('body')).toHaveCSS('font-size', '13px')
  const hostRow = page.getByTestId('host-item').first()
  // 左栏主机行：名称正文 13、地址列表 12（v0.14.2 首轮验收从 12/11 上调）
  await expect(hostRow.locator('span.text-body')).toHaveCSS('font-size', '13px')
  await expect(hostRow.locator('span.text-list')).toHaveCSS('font-size', '12px')
  await expect(page.getByTestId('host-info').locator('dl')).toHaveCSS('font-size', '12px')
  await expect(page.getByTestId('composer-input')).toHaveCSS('font-size', '12.5px')

  // 图标两档：CSS 的 stroke-width 压过 Lucide 写在 SVG 上的 stroke-width="2"
  const gear = page.locator('[data-testid="open-settings"] svg')
  await expect(gear).toHaveCSS('width', '16px')
  await expect(gear).toHaveCSS('stroke-width', '1.75px')
  const trash = page.getByTestId('delete-host').first()
  await expect(trash).toHaveCSS('width', '12px')
  await expect(trash).toHaveCSS('stroke-width', '1.5px')
})

/**
 * v0.14.2 密度三档：设置 → settings.json → App.vue 写 <html data-density> →
 * main.css 的 :root[data-density] 覆盖行高与控件高。重启后首帧即真值。
 */
test('密度三档：切换即时改行高与控件高，重启后保持', async () => {
  const first = await launchApp([makeHost(ssh.port)])
  app = first.app
  const page = first.page
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-density', 'standard')
  await expect(page.getByTestId('host-item').first()).toHaveCSS('padding-top', '8px')

  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-density-standard')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('settings-density-compact').click()
  await expect(html).toHaveAttribute('data-density', 'compact')
  await expect(page.getByTestId('settings-theme')).toHaveCSS('height', '26px')
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('host-item').first()).toHaveCSS('padding-top', '4px')
  // 文件行的 h-(--h-tree) 真的生成进了产物、且跟着密度走
  const treeRow = (): Promise<string> =>
    page.evaluate(() => {
      const probe = document.createElement('div')
      probe.className = 'h-(--h-tree)'
      document.body.append(probe)
      const height = getComputedStyle(probe).height
      probe.remove()
      return height
    })
  expect(await treeRow()).toBe('18px')
  await expect
    .poll(() => JSON.parse(readFileSync(join(first.userDataDir, 'settings.json'), 'utf-8')).uiDensity)
    .toBe('compact')
  await app.close()
  app = undefined

  const second = await launchApp([], first.userDataDir)
  app = second.app
  await expect(second.page.locator('html')).toHaveAttribute('data-density', 'compact')
})

/**
 * v0.14.5 界面字号三档：设置 → settings.json → App.vue 写 <html data-ui-font-size> →
 * main.css 的 --fs-step 平移整张字号表（含 Tailwind 角色类与 controls.css 的 var(--fs-*)）。
 * 终端网格字号走 terminalFontSize，不受影响；文件行定高跟着抬，与密度叠加。
 */
test('界面字号三档：整张字号表平移、文件行跟着抬，终端字号不动，重启后保持', async () => {
  const first = await launchApp([makeHost(ssh.port)])
  app = first.app
  const page = first.page
  const html = page.locator('html')
  const hostName = page.getByTestId('host-item').first().locator('span.text-body')
  const hostAddr = page.getByTestId('host-item').first().locator('span.text-list')
  const treeRow = (): Promise<string> =>
    page.evaluate(() => {
      const probe = document.createElement('div')
      probe.className = 'h-(--h-tree)'
      document.body.append(probe)
      const height = getComputedStyle(probe).height
      probe.remove()
      return height
    })
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  const termFont = (): Promise<string> =>
    page.locator('.xterm-rows').first().evaluate((el) => getComputedStyle(el).fontSize)
  const termBefore = await termFont()

  await expect(html).toHaveAttribute('data-ui-font-size', 'standard')
  await expect(hostName).toHaveCSS('font-size', '13px')
  await expect(hostAddr).toHaveCSS('font-size', '12px')
  expect(await treeRow()).toBe('20px')

  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-ui-font-size-standard')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('settings-ui-font-size-larger').click()
  await expect(html).toHaveAttribute('data-ui-font-size', 'larger')
  // controls.css 里直接写 var(--fs-12) 的控件也跟着走
  await expect(page.getByTestId('settings-theme')).toHaveCSS('font-size', '14px')
  await page.getByTestId('settings-density-compact').click()
  await page.getByTestId('settings-close').click()

  await expect(hostName).toHaveCSS('font-size', '15px')
  await expect(hostAddr).toHaveCSS('font-size', '14px')
  // 紧凑 18 + 特大 2×2：特大档 14px 字的行盒 18.7px，不抬就装不下
  expect(await treeRow()).toBe('22px')
  expect(await termFont()).toBe(termBefore)
  await expect
    .poll(() => JSON.parse(readFileSync(join(first.userDataDir, 'settings.json'), 'utf-8')).uiFontSize)
    .toBe('larger')
  await app.close()
  app = undefined

  const second = await launchApp([], first.userDataDir)
  app = second.app
  await expect(second.page.locator('html')).toHaveAttribute('data-ui-font-size', 'larger')
  await expect(second.page.locator('body')).toHaveCSS('font-size', '15px')
})

test('重启后外观设置生效（持久化回读）', async () => {
  const first = await launchApp([makeHost(ssh.port)])
  app = first.app
  await first.page.getByTestId('open-settings').click()
  await first.page.getByTestId('settings-theme').selectOption('nord')
  await first.page.getByTestId('settings-close').click()
  await app.close()
  app = undefined

  const second = await launchApp([], first.userDataDir)
  app = second.app
  // nord 背景 #2e3440
  await expect(second.page.getByTestId('terminal-area')).toHaveCSS(
    'background-color',
    'rgb(46, 52, 64)'
  )
  // 外壳变量也随持久化的方案回读（不是只有终端）
  await expect.poll(() => shellVar(second.page, '--background')).toBe('#343a47')
})

/**
 * v0.14.0 删除 Solarized Dark：老配置里存的 id 由主进程读盘时改写为默认方案。
 * 只靠渲染层 themeById 回落的话终端会画默认色，但设置页下拉框拿着一个没有对应
 * option 的值，显示成空白——这条守的是"读盘 → 设置 store → 下拉框"整条接线。
 */
test('老配置选的 Solarized Dark 回读为默认方案，下拉框不留空', async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalTheme: 'solarized-dark' }
  })
  app = launched.app
  const page = launched.page

  await expect(page.getByTestId('terminal-area')).toHaveCSS('background-color', 'rgb(22, 24, 31)')
  await page.getByTestId('open-settings').click()
  await expect(page.getByTestId('settings-theme')).toHaveValue('tsubasaterminal')
  await expect(page.locator('[data-testid="settings-theme"] option[value="solarized-dark"]')).toHaveCount(0)
})

/**
 * v0.13.5 纯黑 OLED：**两条路必须分开走**——终端网格取方案原值（真 #000000，
 * OLED 上熄灯），外壳走 SHELL_ANCHOR_FLOOR_L 兜底的阶梯（否则七档全塌进 sRGB
 * 低端的量化区，左右栏与终端区逐字节相同、分隔线 1.04:1 等于没有）。
 *
 * 上面几条逐 hex 断言同时就是护栏的**零回归守卫**：现有 8 套 L₀ 全在 0.210 以上，
 * `Math.max` 不该触发，误触发那边先红。
 */
test('纯黑 OLED：终端区真 #000，外壳走明度下限护栏仍分得出栏', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-theme').selectOption('pitch-black')

  // 终端区**不过护栏**：方案原值直通，是真纯黑
  await expect(page.getByTestId('terminal-area')).toHaveCSS('background-color', 'rgb(0, 0, 0)')

  // 外壳被锚点下限（L₀ 0 → 0.13）兜起来：没有护栏时这七档是
  // #000000/#000000/#010101/#020202/#040404/#070707/#141414
  await expect.poll(() => shellVar(page, '--background')).toBe('#0c0c0c')
  await expect.poll(() => shellVar(page, '--card')).toBe('#121212')
  await expect.poll(() => shellVar(page, '--bg-subtle')).toBe('#151515')
  await expect.poll(() => shellVar(page, '--muted')).toBe('#181818')
  await expect.poll(() => shellVar(page, '--bg-active')).toBe('#1e1e1e')
  await expect.poll(() => shellVar(page, '--border')).toBe('#242424')
  await expect.poll(() => shellVar(page, '--bd-strong')).toBe('#333333')
  // 无彩到底：底色 C=0，四级文字全是纯灰，没有冷调蓝斑。
  // 前景**拉满纯白**——v0.13.5 日用返工：纯黑底上对比度 ≡ 绝对亮度（底是 0，
  // 没有第二个变量），守 8–11:1 舒适带只能靠压暗前景，而那正是"字发灰又不亮"
  // 的来源。舒适带的前提是"可以抬底降对比"，底锁死在 0 就没这个手段了。
  await expect.poll(() => shellVar(page, '--foreground')).toBe('#ffffff')
  await expect.poll(() => shellVar(page, '--fg-2')).toBe('#c7c7c7')
  await expect.poll(() => shellVar(page, '--muted-foreground')).toBe('#929292')
  await expect.poll(() => shellVar(page, '--fg-4')).toBe('#666666')
  // 光标色被征用为强调/焦点环：纯白，是这套配色里唯一的高光
  await expect.poll(() => shellVar(page, '--ring')).toBe('#ffffff')

  await page.getByTestId('settings-close').click()

  // 护栏存在的**理由**本身：左右栏底与终端区底不能同色，否则分不出栏
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(12, 12, 12)')
  await expect(page.getByTestId('terminal-area')).toHaveCSS('background-color', 'rgb(0, 0, 0)')
  // 分隔线立得住（无护栏时是 #070707，对底 1.04:1）
  await expect(page.locator('aside').first()).toHaveCSS('border-right-color', 'rgb(36, 36, 36)')

  // 终端仍可用（纯黑不是特殊路径，热切换照样不打断会话）
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  // **网格里的字是纯白**——这次返工的核心落点。外壳变量与 xterm 是两条路
  // （前者过 deriveShell、后者拿方案原值），上面断的是前者，这里断后者。
  await expect(page.locator('.xterm-rows').first()).toHaveCSS('color', 'rgb(255, 255, 255)')
})

/**
 * v0.14.3 亮色主题：选浅色方案即亮色界面，没有单独的明暗开关。守的是整条接线——
 * 设置 → applyAppTheme 摘 dark class、写内联变量 → main.css 的 color-scheme 与
 * :root:not(.dark) 固定色 → 弹窗遮罩变淡 → xterm 最低对比度 → 原生窗口底色 →
 * settings.json → 重启后主进程按已存方案建窗。派生值的完整矩阵在 unit 层。
 */
test('亮色方案：切 Catppuccin Latte 后外壳、固定色、终端对比度与原生窗口一起翻亮，重启保持', { tag: '@daily' }, async () => {
  const first = await launchApp([makeHost(ssh.port)])
  app = first.app
  const page = first.page
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  const html = page.locator('html')
  await expect(html).toHaveClass(/\bdark\b/)

  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-theme').selectOption('catppuccin-latte')
  const latte = deriveShell(themeById('catppuccin-latte').theme)
  await expect(html).not.toHaveClass(/\bdark\b/)
  await expect(html).toHaveCSS('color-scheme', 'light')
  await expect.poll(() => shellVar(page, '--background')).toBe(latte.background)
  await expect.poll(() => shellVar(page, '--ring')).toBe(latte.ring)
  // v0.14.5：外壳正文不沿用终端前景 #4c4f69，压到 #1f212b；主机名真的画成这个色
  await expect.poll(() => shellVar(page, '--foreground')).toBe('#1f212b')
  await expect.poll(() => shellVar(page, '--muted-foreground')).toBe('#4f515d')
  // 控件面是白（与浮层同级），不是暗色那种 muted 灰；遮罩按亮色的 0.34
  await expect(page.getByTestId('settings-theme')).toHaveCSS('background-color', cssRgb(latte.card))
  await expect(page.locator('.scrim')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.34)')
  await page.getByTestId('settings-close').click()

  await expect(page.getByTestId('terminal-area')).toHaveCSS('background-color', 'rgb(239, 241, 245)')
  await expect(page.locator('body')).toHaveCSS('background-color', cssRgb(latte.background))
  await expect(page.getByTestId('host-item').first().locator('span.text-body')).toHaveCSS('color', cssRgb('#1f212b'))
  // 不派生的固定色换成亮色那套（main.css :root:not(.dark)）：成功绿是 #166534
  const okColor = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.className = 'text-ok'
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  expect(okColor).toBe('rgb(22, 101, 52)')
  // 原生窗口底色跟上（页面未画出时露出的那块）
  await expect
    .poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()))
    .toBe(latte.background)

  // 终端：Latte 的黄 #df8e1d 对底只有 2.31:1，最低对比度在渲染时兜到 3:1（v0.14.5 起），方案原值不动
  await page.getByTestId('composer-input').fill('yellow')
  await page.getByTestId('composer-input').press('Enter')
  const yellow = page.locator('.xterm-rows span', { hasText: 'pale-yellow' }).first()
  await expect(yellow).toBeVisible()
  // xterm 的 DOM 渲染器会整行重建 span，取到刚被换下的节点时 computed color 是空串，故轮询
  const renderedYellow = async (): Promise<string | null> => {
    const color = await yellow.evaluate((el) => getComputedStyle(el).color)
    return /\d/.test(color) ? rgbToHex(color) : null
  }
  await expect
    .poll(async () => {
      const rendered = await renderedYellow()
      // 原值 #df8e1d 画出来就是没兜底；否则算实际画出来的颜色对终端底的对比
      return rendered && rendered !== '#df8e1d' ? contrastRatio(rendered, '#eff1f5') : 0
    })
    .toBeGreaterThanOrEqual(3)
  // 兜底不过冲：只压到刚够 3:1 附近（xterm 每轮乘 0.9），黄仍是琥珀色而不是 4.5 时的土棕
  await expect
    .poll(async () => {
      const rendered = await renderedYellow()
      return rendered ? contrastRatio(rendered, '#eff1f5') : 99
    })
    .toBeLessThan(4)

  await expect
    .poll(() => JSON.parse(readFileSync(join(first.userDataDir, 'settings.json'), 'utf-8')).terminalTheme)
    .toBe('catppuccin-latte')
  await app.close()
  app = undefined

  // 重启：主进程按已存方案建窗（窗口底色），渲染层首帧即亮色
  const second = await launchApp([], first.userDataDir)
  app = second.app
  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase())
  ).toBe(latte.background)
  await expect(second.page.locator('html')).not.toHaveClass(/\bdark\b/)
  await expect(second.page.locator('body')).toHaveCSS('background-color', cssRgb(latte.background))
})

test('字符宽度按字素簇算：emoji、VS16、keycap、肤色修饰、ZWJ 组合各占 2 格，后续字符与 ab| 对齐', async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')

  await page.getByTestId('composer-input').fill('widths')
  await page.getByTestId('composer-input').press('Enter')
  const columns = (): Promise<Array<{ text: string; col: number }>> =>
    page.evaluate(() => {
      const hook = (
        window as unknown as {
          __tsubasaterminal: { getActiveMarkerColumns: (m: string) => Array<{ text: string; col: number }> | null }
        }
      ).__tsubasaterminal
      return hook.getActiveMarkerColumns('|') ?? []
    })
  await expect.poll(async () => (await columns()).length).toBe(10)
  // 改前 Unicode 6 表：U+2705、VS16 序列、keycap 都只占 1 格，`|` 落在第 1 列
  for (const row of await columns()) expect(row, row.text).toEqual({ text: row.text, col: 2 })
})
