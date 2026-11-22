import { expect, test } from '@playwright/test'
import { activeTerminalText, launchApp, type TestHost } from '../fixtures/launch'

/**
 * 真实 VPS 每夜烟测：与功能回归（fake server，离线确定性）分离，
 * 验证真实网络/真实 bash 下的核心链路：私钥认证连接、shell integration 注入、
 * composer 整行发送与结构化转录、干净断开。
 *
 * 环境变量（缺 HOST 整组跳过，不影响日常 test:e2e）：
 *   TSUBASATERMINAL_SMOKE_HOST  目标主机地址（IP 或域名，不解析 SSH config 别名）
 *   TSUBASATERMINAL_SMOKE_USER  默认 root
 *   TSUBASATERMINAL_SMOKE_PORT  默认 22
 *   TSUBASATERMINAL_SMOKE_KEY   私钥路径；留空走 ~/.ssh 默认私钥
 *   TSUBASATERMINAL_SMOKE_TMUX  设为 1 追加 tmux 保活链路用例（目标机需装 tmux ≥3.3）
 *
 * 每夜调度：scripts/register-nightly-smoke.ps1 注册 Windows 计划任务。
 */

const HOST = process.env.TSUBASATERMINAL_SMOKE_HOST

test.skip(!HOST, '未设置 TSUBASATERMINAL_SMOKE_HOST，跳过真机烟测')

test('真机烟测：连接 → prompt 激活 → 命令执行 → 结构化转录', async () => {
  const host: TestHost = {
    id: 'smoke-host',
    name: 'smoke',
    host: HOST!,
    port: Number(process.env.TSUBASATERMINAL_SMOKE_PORT) || 22,
    username: process.env.TSUBASATERMINAL_SMOKE_USER || 'root',
    authType: 'privateKey',
    privateKeyPath: process.env.TSUBASATERMINAL_SMOKE_KEY || undefined
  }
  const { app, page } = await launchApp([host])
  try {
    await page.getByTestId('host-item').dblclick()
    // prompt 态 = 连接成功且 shell integration 在真实 bash 上生效
    await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
      timeout: 60_000
    })

    await page.getByTestId('composer-input').fill('echo tsubasaterminal-smoke-$((6*7))')
    await page.getByTestId('composer-input').press('Enter')
    await expect
      .poll(() => activeTerminalText(page), { timeout: 30_000 })
      .toContain('tsubasaterminal-smoke-42')
    // 回到 prompt（OSC 133 完整时序在真机成立）
    await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
      timeout: 30_000
    })

    // 结构化转录成立（命令-输出-退出码切单元）
    const commands = await page.evaluate(async () => {
      const w = window as unknown as {
        __tsubasaterminal: { getSessions: () => Array<{ id: string }> }
        api: { transcript: { get: (id: string) => Promise<Array<{ command: string }>> } }
      }
      const sessionId = w.__tsubasaterminal.getSessions()[0]?.id
      if (!sessionId) return []
      return (await w.api.transcript.get(sessionId)).map((u) => u.command)
    })
    expect(commands.some((c) => c.includes('tsubasaterminal-smoke'))).toBe(true)
  } finally {
    await app.close()
  }
})

test('真机烟测（tmux 保活）：attach 会话池，passthrough 下 prompt 仍激活', async () => {
  test.skip(process.env.TSUBASATERMINAL_SMOKE_TMUX !== '1', '未设置 TSUBASATERMINAL_SMOKE_TMUX=1')
  const host: TestHost = {
    id: 'smoke-tmux-host',
    name: 'smoke-tmux',
    host: HOST!,
    port: Number(process.env.TSUBASATERMINAL_SMOKE_PORT) || 22,
    username: process.env.TSUBASATERMINAL_SMOKE_USER || 'root',
    authType: 'privateKey',
    privateKeyPath: process.env.TSUBASATERMINAL_SMOKE_KEY || undefined,
    tmuxKeepalive: true
  }
  const { app, page } = await launchApp([host])
  try {
    await page.getByTestId('host-item').dblclick()
    // prompt 态成立 = bootstrap attach 成功 + integration 在 tmux 内 source +
    // OSC 经 DCS passthrough 穿透 tmux 到达 xterm（allow-passthrough 生效）
    await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
      timeout: 60_000
    })
    await page.getByTestId('composer-input').fill('echo tmux-smoke-$((6*7))')
    await page.getByTestId('composer-input').press('Enter')
    await expect
      .poll(() => activeTerminalText(page), { timeout: 30_000 })
      .toContain('tmux-smoke-42')
    // 内层 shell exit → tmux 会话结束（顺带清池）→ 干净关闭，不触发重连
    await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
      timeout: 30_000
    })
    await page.getByTestId('composer-input').fill('exit')
    await page.getByTestId('composer-input').press('Enter')
    await expect
      .poll(() => activeTerminalText(page), { timeout: 30_000 })
      .toContain('[连接已关闭]')
    expect(await activeTerminalText(page)).not.toContain('自动重连')
  } finally {
    await app.close()
  }
})

test('真机烟测（tmux 保活）：断开后重连回到原现场（会话池复用）', async () => {
  test.skip(process.env.TSUBASATERMINAL_SMOKE_TMUX !== '1', '未设置 TSUBASATERMINAL_SMOKE_TMUX=1')
  const host: TestHost = {
    id: 'smoke-tmux-pool',
    name: 'smoke-pool',
    host: HOST!,
    port: Number(process.env.TSUBASATERMINAL_SMOKE_PORT) || 22,
    username: process.env.TSUBASATERMINAL_SMOKE_USER || 'root',
    authType: 'privateKey',
    privateKeyPath: process.env.TSUBASATERMINAL_SMOKE_KEY || undefined,
    tmuxKeepalive: true
  }
  // 第一程：连接 → 留下现场标记 → 直接断开（不 exit，tmux 会话 detach 留池）
  const first = await launchApp([host])
  await first.page.getByTestId('host-item').dblclick()
  await expect(first.page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 60_000
  })
  await first.page.getByTestId('composer-input').fill('echo pool-marker-$((70+7))')
  await first.page.getByTestId('composer-input').press('Enter')
  await expect
    .poll(() => activeTerminalText(first.page), { timeout: 30_000 })
    .toContain('pool-marker-77')
  await first.app.close()

  // 第二程：重新连接 → bootstrap 应 attach 回池中空闲会话，原现场（标记）还在屏上
  const second = await launchApp([host], first.userDataDir)
  try {
    await second.page.getByTestId('host-item').dblclick()
    await expect(second.page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
      timeout: 60_000
    })
    await expect
      .poll(() => activeTerminalText(second.page), { timeout: 30_000 })
      .toContain('pool-marker-77')
    // 清池收场
    await second.page.getByTestId('composer-input').fill('exit')
    await second.page.getByTestId('composer-input').press('Enter')
    await expect
      .poll(() => activeTerminalText(second.page), { timeout: 30_000 })
      .toContain('[连接已关闭]')
  } finally {
    await second.app.close()
  }
})
