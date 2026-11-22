import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

/**
 * 粘贴路径。落点跟着 composer 模式走，与焦点的"家"同一套规则：
 * prompt 态进草稿（粘来的多行命令先看得见、能改），其余态经 term.paste 直通 pty。
 * 右键语义随"选中即复制"设置翻面——开着时复制早已完成，右键直接粘贴；
 * 关掉时才恢复 Windows Terminal 的二合一。
 */

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

async function connectAndWaitPrompt(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

function seedClipboard(electronApp: ElectronApplication, text: string): Promise<void> {
  return electronApp.evaluate(({ clipboard: cb }, value) => cb.writeText(value), text)
}

function clipboard(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ clipboard: cb }) => cb.readText())
}

/** 终端要点 xterm 渲染层：terminal-view 外层带 padding，按在 padding 上 xterm 收不到 */
function terminalScreen(page: Page): Locator {
  return page.getByTestId('terminal-view').locator('.xterm-screen')
}

/** 在元素上拖出一个真实选区（mousedown → move → mouseup） */
async function dragSelect(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('目标不可见，无法拖选')
  await page.mouse.move(box.x + 3, box.y + 3)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3, { steps: 12 })
  await page.mouse.up()
}

test('prompt 态右键粘贴落 composer 草稿：多行不进 pty，Enter 才执行', { tag: ['@headed', '@daily'] }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await seedClipboard(launched.app, 'echo draft-mark-aa\necho draft-mark-bb')
  await terminalScreen(page).click({ button: 'right' })

  // 落草稿：多行原样躺着，可见可改
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'echo draft-mark-aa\necho draft-mark-bb'
  )
  await expect(page.getByTestId('composer-input')).toBeFocused()
  // 一个字符都没进 pty——这正是 prompt 态落草稿的意义
  expect(await activeTerminalText(page)).not.toContain('draft-mark-aa')

  // Enter 才发送，链路与手打一致
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toMatch(/^draft-mark-aa$/m)
  await expect.poll(() => activeTerminalText(page)).toMatch(/^draft-mark-bb$/m)
})

test('直通态三条路径都进同一个 pty 行缓冲：右键 / Ctrl+Shift+V / Ctrl+V', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  // ask：远端等输入，composer 停在 running——粘贴答案是这条路最真实的用法
  await page.keyboard.type('ask')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('input? ')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'running')

  await seedClipboard(launched.app, 'pasted-mouse')
  await terminalScreen(page).click({ button: 'right' })
  await expect.poll(() => activeTerminalText(page)).toContain('pasted-mouse')

  // 键盘路径：焦点此刻在 xterm（running 态的家），两个键位都该接管
  await seedClipboard(launched.app, '-kbd')
  await page.keyboard.press('Control+Shift+V')
  await expect.poll(() => activeTerminalText(page)).toContain('pasted-mouse-kbd')

  await seedClipboard(launched.app, '-cv')
  await page.keyboard.press('Control+v')
  await expect.poll(() => activeTerminalText(page)).toContain('pasted-mouse-kbd-cv')

  // 三次粘贴拼在同一行上，回车后作为一个整体交给远端
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toContain('answer: pasted-mouse-kbd-cv')
})

test('Shift+右键出菜单：无选区时复制项禁用，点粘贴生效，Esc 关闭', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)])
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await seedClipboard(launched.app, 'menu-paste-mark')
  await terminalScreen(page).click({ button: 'right', modifiers: ['Shift'] })
  const menu = page.getByTestId('terminal-context-menu')
  await expect(menu).toBeVisible()
  // 没选区就没得复制——菜单项不该假装能点
  await expect(page.getByTestId('menu-copy')).toBeDisabled()

  await page.getByTestId('menu-paste').click()
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('menu-paste-mark')

  // Esc 关闭，且不误伤草稿
  await terminalScreen(page).click({ button: 'right', modifiers: ['Shift'] })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.getByTestId('composer-input')).toHaveValue('menu-paste-mark')
})

test('关掉选中即复制后右键恢复 WT 二合一：先复制清选区，再右键才粘贴', { tag: '@headed' }, async () => {
  const launched = await launchApp([makeHost(ssh.port)], undefined, {
    settings: { terminalCopyOnSelect: false }
  })
  app = launched.app
  const page = launched.page
  await connectAndWaitPrompt(page)

  await page.keyboard.type('echo wt-dual-mark')
  await page.keyboard.press('Enter')
  await expect.poll(() => activeTerminalText(page)).toMatch(/^wt-dual-mark$/m)

  await seedClipboard(launched.app, 'SENTINEL')
  await dragSelect(page, terminalScreen(page))
  // 选中即复制关着：拖选不动剪贴板
  expect(await clipboard(launched.app)).toBe('SENTINEL')

  // 第一次右键 = 复制（有选区），不粘贴
  await terminalScreen(page).click({ button: 'right' })
  await expect.poll(() => clipboard(launched.app)).toContain('wt-dual-mark')
  await expect(page.getByTestId('composer-input')).toHaveValue('')

  // 选区已被清掉，第二次右键 = 粘贴，粘的正是刚复制的那份
  await terminalScreen(page).click({ button: 'right' })
  await expect(page.getByTestId('composer-input')).toHaveValue(/wt-dual-mark/)
})
