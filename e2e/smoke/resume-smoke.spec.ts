import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test, type Page } from '@playwright/test'
import { launchApp, type TestHost } from '../fixtures/launch'

/**
 * 对话接续与迁移的真机验证：
 * fake server 不校验 thinking signature，验不了两件事——
 * 1. signature 跨进程重启后原样回传，真实 provider 是否接受；
 * 2. 回灌的完整历史（thinking/tool_use/tool_result 配对）真实 provider 是否接受。
 *
 * 环境变量（缺一整组跳过，不进日常 test:e2e / 每夜烟测默认不跑）：
 *   TSUBASATERMINAL_SMOKE_RESUME=1     显式开启本组
 *   TSUBASATERMINAL_SMOKE_HOST_A       主机 A（接续在这台上做）
 *   TSUBASATERMINAL_SMOKE_PORT_A       默认 22
 *   TSUBASATERMINAL_SMOKE_HOST_B       主机 B（迁移目的地）
 *   TSUBASATERMINAL_SMOKE_PORT_B       默认 22
 *   TSUBASATERMINAL_SMOKE_USER         默认 root（两台同用户）
 *   TSUBASATERMINAL_SMOKE_KEY          私钥路径；留空走 ~/.ssh 默认私钥
 *   TSUBASATERMINAL_SMOKE_LLM_PROFILES 真实 llm-profiles.json 路径（safeStorage 加密的
 *                               key 在同一 Windows 用户下可解密，直接拷入隔离 userData）
 *
 * 断言口径：真实 LLM 输出不可精确断言，验的是链路不炸——回复落地、工具执行、
 * 无 turn-end error（provider 若拒收回灌历史/签名，这里必然以 400 出错收场）。
 */

const ENABLED = process.env.TSUBASATERMINAL_SMOKE_RESUME === '1'
const HOST_A = process.env.TSUBASATERMINAL_SMOKE_HOST_A
const HOST_B = process.env.TSUBASATERMINAL_SMOKE_HOST_B
const LLM_PROFILES = process.env.TSUBASATERMINAL_SMOKE_LLM_PROFILES

test.skip(
  !ENABLED || !HOST_A || !HOST_B || !LLM_PROFILES || !existsSync(LLM_PROFILES ?? ''),
  '未设置 TSUBASATERMINAL_SMOKE_RESUME/HOST_A/HOST_B/LLM_PROFILES，跳过接续迁移真机验证'
)

function makeRealHost(id: string, name: string, host: string, port: number): TestHost {
  return {
    id,
    name,
    host,
    port,
    username: process.env.TSUBASATERMINAL_SMOKE_USER || 'root',
    authType: 'privateKey',
    privateKeyPath: process.env.TSUBASATERMINAL_SMOKE_KEY || undefined
  }
}

async function connectReal(page: Page, hostName: string): Promise<void> {
  await page.getByTestId('host-item').filter({ hasText: hostName }).dblclick()
  await expect(page.getByTestId('composer')).toHaveAttribute('data-mode', 'prompt', {
    timeout: 60_000
  })
}

/** 发一条消息并等这一轮的回复落地且无出错收场（真实 LLM，超时放宽） */
async function askAndWait(page: Page, text: string): Promise<void> {
  const before = await page.getByTestId('agent-assistant-msg').count()
  await page.getByTestId('agent-input').fill(text)
  await page.getByTestId('agent-input').press('Enter')
  await expect(page.getByTestId('agent-assistant-msg')).not.toHaveCount(before, {
    timeout: 150_000
  })
  // busy 退场 = turn-end 已到；随后断言不是 error 收场
  await expect(page.getByTestId('agent-stop')).toHaveCount(0, { timeout: 150_000 })
  await expect(page.getByText(/^出错：/)).toHaveCount(0)
}

test('真机：接续（signature 跨重启回传）+ 迁移（跨机重建 system），真实 provider 接受回灌历史', async () => {
  // 隔离 userData + 真实 LLM profile（safeStorage 同用户可解密）+ 两台真实主机
  const userDataDir = mkdtempSync(join(tmpdir(), 'tsubasaterminal-resume-smoke-'))
  const hostA = makeRealHost(
    'smoke-resume-a',
    'resume-A',
    HOST_A!,
    Number(process.env.TSUBASATERMINAL_SMOKE_PORT_A) || 22
  )
  const hostB = makeRealHost(
    'smoke-resume-b',
    'resume-B',
    HOST_B!,
    Number(process.env.TSUBASATERMINAL_SMOKE_PORT_B) || 22
  )
  writeFileSync(join(userDataDir, 'hosts.json'), JSON.stringify([hostA, hostB], null, 2), 'utf-8')
  copyFileSync(LLM_PROFILES!, join(userDataDir, 'llm-profiles.json'))
  const profiles = JSON.parse(readFileSync(LLM_PROFILES!, 'utf-8')) as Array<{
    id: string
    provider: string
  }>
  const anthropicProfile = profiles.find((p) => p.provider === 'anthropic')
  expect(anthropicProfile, 'llm-profiles.json 里需要至少一个 anthropic 协议的 profile').toBeTruthy()
  writeFileSync(
    join(userDataDir, 'settings.json'),
    JSON.stringify({ redactionEnabled: true, activeLlmProfileId: anthropicProfile!.id }),
    'utf-8'
  )

  // ---- 第一程（主机 A）：真实对话，产生 thinking + tool_use 的完整历史 ----
  const first = await launchApp([], userDataDir)
  let page = first.page
  try {
    await connectReal(page, 'resume-A')
    await askAndWait(page, '请执行 hostname 命令，然后用一句话告诉我这台机器叫什么。')
    // 白名单只读命令应自动执行（executed）
    await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
      'data-status',
      /executed|ok/
    )
    // 等索引落盘再重启（app.quit 不等挂起的写）
    await expect
      .poll(() => {
        try {
          return readFileSync(join(userDataDir, 'conversations', 'index.jsonl'), 'utf-8')
        } catch {
          return ''
        }
      })
      .toContain('"turnCount":1')
  } finally {
    await first.app.close()
  }

  // ---- 第二程：重启接续（同主机 A）——signature 跨进程回传 ----
  const second = await launchApp([], userDataDir)
  page = second.page
  try {
    await connectReal(page, 'resume-A')
    await page.getByTestId('agent-history-toggle').click()
    await page.getByTestId('agent-history-item').first().click()
    const resumeBtn = page.getByTestId('agent-review-resume')
    await expect(resumeBtn).toBeVisible()
    await expect(resumeBtn).toContainText('约重算')
    await resumeBtn.click()
    await expect(page.getByTestId('agent-review-bar')).toHaveCount(0)
    // 旧消息灌回实时流
    await expect(page.getByTestId('agent-assistant-msg').first()).toBeVisible()

    // 接着聊：完整历史（含 signature）回灌给真实 provider——被拒会 400 出错收场
    await askAndWait(page, '我们刚才执行了什么命令？直接回答，不用再执行。')

    // ---- 迁移（主机 B）：关 A 的会话，把对话捞到 B 继续 ----
    await page.getByTestId('session-tab').hover()
    await page.getByTestId('close-tab').click()
    await connectReal(page, 'resume-B')
    await page.getByTestId('agent-history-toggle').click()
    await page.getByTestId('agent-history-item').first().click()
    await page.getByTestId('agent-review-resume').click()
    await expect(page.getByTestId('agent-review-bar')).toHaveCount(0)
    await expect(page.getByText('对话已迁移到')).toBeVisible()

    // 迁移后接着聊：system 已重建（新主机档案），历史仍原样回灌
    await askAndWait(page, '现在已经换了一台机器。请再执行一次 hostname，确认当前主机名。')
    await expect(page.getByTestId('agent-tool-card').last()).toHaveAttribute(
      'data-status',
      /executed|ok/
    )
    // hostIds 追加成两台
    const index = readFileSync(join(userDataDir, 'conversations', 'index.jsonl'), 'utf-8')
    expect(index).toContain('"hostIds":["smoke-resume-a","smoke-resume-b"]')
  } finally {
    await second.app.close()
  }
})
