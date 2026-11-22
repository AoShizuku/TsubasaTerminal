import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeSshServer, type FakeSshServer } from './fixtures/fake-ssh-server'
import { activeTerminalText, launchApp, makeHost } from './fixtures/launch'

/**
 * v0.8.4 终端文件传输（见 doc/transfer-design.md）：
 * - ZMODEM 拦截桥：检测→CAN 中止→SFTP 桥双向，帧垃圾不上屏不进转录
 * - trzsz 真通道：TrzszFilter 主进程接管，协议帧剥离，取消干净收场
 * 对话框走 TSUBASATERMINAL_E2E_SAVE_DIR / TSUBASATERMINAL_E2E_SEND_FILES 确定性 mock。
 */

let server: FakeSshServer
let app: ElectronApplication | undefined

test.beforeAll(async () => {
  server = await startFakeSshServer({
    files: {
      '/home/test': [
        { name: 'www', type: 'dir' },
        { name: 'app.log', type: 'file', size: 12, content: 'log-content\n' },
        { name: 'b.txt', type: 'file', size: 5, content: 'bbbb\n' }
      ],
      '/home/test/www': [{ name: 'index.html', type: 'file', size: 64 }]
    }
  })
})

test.afterAll(async () => {
  await server.close()
})

test.afterEach(async () => {
  await app?.close()
  app = undefined
})

async function connect(page: Page): Promise<void> {
  await page.getByTestId('host-item').dblclick()
  await expect.poll(() => activeTerminalText(page)).toContain('test@fake:~$')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
}

async function typeCommand(page: Page, command: string): Promise<void> {
  await expect(page.getByTestId('composer-input')).toBeFocused()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** 读活动会话的结构化转录（机器消费者出口——Agent 看到的就是这个） */
async function getTranscript(page: Page): Promise<Array<{ command: string; output: string }>> {
  return await page.evaluate(async () => {
    const w = window as unknown as {
      __tsubasaterminal: { getSessions: () => Array<{ id: string }> }
      api: {
        transcript: {
          get: (id: string) => Promise<Array<{ command: string; output: string }>>
        }
      }
    }
    const sessionId = w.__tsubasaterminal.getSessions()[0]?.id
    if (!sessionId) return []
    const units = await w.api.transcript.get(sessionId)
    return units.map((u) => ({ command: u.command, output: u.output }))
  })
}

test('ZMODEM 桥下载：sz 检测中止转 SFTP，帧垃圾不上屏不进转录', { tag: '@daily' }, async () => {
  const saveDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-dl-'))
  const abortsBefore = server.zmodemAborts()
  const launched = await launchApp([makeHost(server.port)], undefined, {
    env: { TSUBASATERMINAL_E2E_SAVE_DIR: saveDir }
  })
  app = launched.app
  const page = launched.page
  await connect(page)

  await typeCommand(page, 'sz app.log b.txt')
  // 双文件经 SFTP 落盘（一次目录选择）
  await expect.poll(() => readFileOrNull(join(saveDir, 'app.log'))).toBe('log-content\n')
  await expect.poll(() => readFileOrNull(join(saveDir, 'b.txt'))).toBe('bbbb\n')
  // 服务端收到 CAN 中止序列
  expect(server.zmodemAborts()).toBe(abortsBefore + 1)
  // hint 行可见、ZMODEM 帧垃圾与中止残响不上屏
  await expect.poll(() => activeTerminalText(page)).toContain('✓ app.log')
  // 扣押释放后 composer 才回 prompt（A 随 prompt 一起被扣押，v0.8.5）
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  const text = await activeTerminalText(page)
  expect(text).toContain('[Tsubasa Terminal] 检测到 ZMODEM(sz)')
  expect(text).not.toContain('B00000000000000')
  expect(text).not.toContain('Transfer incomplete')
  // 扣押语义：prompt 在 ✓ 提示之后干净落底（零 Enter）
  expect(text.lastIndexOf('test@fake:~$')).toBeGreaterThan(text.lastIndexOf('✓ app.log'))
  await typeCommand(page, 'echo after-bridge')
  await expect.poll(() => activeTerminalText(page)).toContain('after-bridge')
  // Agent 出口的转录同样干净：sz 单元不含帧数据
  const units = await getTranscript(page)
  const szUnit = units.find((u) => u.command === 'sz app.log b.txt')
  expect(szUnit).toBeTruthy()
  expect(szUnit!.output).not.toContain('B00000000000000')
  expect(szUnit!.output).not.toContain('Transfer incomplete')
})

test('ZMODEM 桥上传：rz 转 SFTP 上传到 cwd', async () => {
  const sendDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-ul-'))
  const localFile = join(sendDir, 'upload-me.txt')
  writeFileSync(localFile, 'from-local\n', 'utf-8')
  const launched = await launchApp([makeHost(server.port)], undefined, {
    env: { TSUBASATERMINAL_E2E_SEND_FILES: localFile }
  })
  app = launched.app
  const page = launched.page
  await connect(page)

  await typeCommand(page, 'rz')
  await expect.poll(() => server.writtenFiles()['/home/test/upload-me.txt']).toBe('from-local\n')
  await expect.poll(() => activeTerminalText(page)).toContain('已上传 1 个文件')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  const text = await activeTerminalText(page)
  expect(text).toContain('[Tsubasa Terminal] 检测到 ZMODEM(rz)')
  expect(text).not.toContain('B0100000023be50')
  // 扣押语义：prompt 在成功提示之后干净落底（零 Enter）
  expect(text.lastIndexOf('test@fake:~$')).toBeGreaterThan(text.lastIndexOf('已上传 1 个文件'))
})

test('trzsz 下载 happy path：协议帧剥离、文件落盘、转录干净', async () => {
  const saveDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-trzsz-'))
  const launched = await launchApp([makeHost(server.port)], undefined, {
    env: { TSUBASATERMINAL_E2E_SAVE_DIR: saveDir }
  })
  app = launched.app
  const page = launched.page
  await connect(page)

  await typeCommand(page, 'tsz hello.txt')
  // TrzszFilter 主进程接管，文件字节不过 IPC 直接落盘
  await expect.poll(() => readFileOrNull(join(saveDir, 'hello.txt'))).toBe('hello from trzsz\n')
  // 传输结束 shell 回 prompt，会话可用
  await expect.poll(() => activeTerminalText(page)).toContain('Saved hello.txt')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  // 剥离断言：协议帧不上屏、不进转录（magic 行在接管前透传属已知边界，不断言）
  const text = await activeTerminalText(page)
  expect(text).not.toContain('#CFG:')
  expect(text).not.toContain('#DATA:')
  const units = await getTranscript(page)
  const tszUnit = units.find((u) => u.command === 'tsz hello.txt')
  expect(tszUnit).toBeTruthy()
  expect(tszUnit!.output).not.toContain('#CFG:')
  expect(tszUnit!.output).not.toContain('#DATA:')
  expect(tszUnit!.output).not.toContain('#NAME:')
})

test('trzsz 取消：保存对话框取消后干净收场，会话可用', async () => {
  const launched = await launchApp([makeHost(server.port)], undefined, {
    env: { TSUBASATERMINAL_E2E_SAVE_DIR: 'CANCEL' }
  })
  app = launched.app
  const page = launched.page
  await connect(page)

  await typeCommand(page, 'tsz hello.txt')
  await expect.poll(() => activeTerminalText(page)).toContain('Cancelled')
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt')
  await typeCommand(page, 'echo still-alive')
  await expect.poll(() => activeTerminalText(page)).toContain('still-alive')
})
