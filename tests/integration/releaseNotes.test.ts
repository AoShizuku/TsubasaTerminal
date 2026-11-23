import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// 真实脚本跑在独立 Node 进程里，断言 stdout 与退出码：
// release.yml 的 guard 与 Release 说明都直接消费这两样。
function run(...args: string[]) {
  return spawnSync(process.execPath, ['scripts/release-notes.mjs', ...args], {
    encoding: 'utf8',
    windowsHide: true
  })
}

const dirs: string[] = []
function changelog(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  dirs.push(dir)
  const file = join(dir, 'CHANGELOG.md')
  writeFileSync(file, text)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sample = [
  '# 更新日志',
  '',
  '## [Unreleased]',
  '',
  '### 修复',
  '',
  '- 尚未发布的修复',
  '',
  '## [1.1.10] - 2026-12-20',
  '',
  '- 前缀相同的另一版',
  '',
  '## [1.1.1] - 2026-12-01',
  '',
  '### 修复',
  '',
  '- 修了一处',
  '',
  '## [1.0.0] - 2026-11-16',
  '',
  '首个公开版本。',
  '',
  '[1.1.1]: https://example.invalid/v1.1.1',
  '[1.0.0]: https://example.invalid/v1.0.0',
  ''
].join('\n')

describe('release-notes', () => {
  it('截取中间小节到下一个版本标题为止，不含标题本身与前缀相同的版本', () => {
    const result = run('1.1.1', changelog(sample))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('### 修复\n\n- 修了一处\n')
  })

  it('最后一个小节截到文末链接定义之前', () => {
    const result = run('1.0.0', changelog(sample))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('首个公开版本。\n')
  })

  it('CRLF 行尾的 CHANGELOG 同样能截取，输出统一为 LF', () => {
    const result = run('1.1.1', changelog(sample.replace(/\n/g, '\r\n')))
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('### 修复\n\n- 修了一处\n')
  })

  it('没有对应小节时退出码 1，stdout 为空', () => {
    const result = run('9.9.9', changelog(sample))
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('## [9.9.9]')
  })

  it('小节只有标题没有条目时退出码 1', () => {
    const result = run('1.2.0', changelog('## [1.2.0] - 2027-01-01\n\n## [1.1.1] - 2026-12-01\n\n- 修了一处\n'))
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('为空')
  })

  it('缺少版本号参数时退出码 2', () => {
    const result = run()
    expect(result.status).toBe(2)
  })

  // develop 上 package.json 停在最近发布的版本，发版提交同时 bump 并写入新小节，
  // 所以任何时候仓库里的 CHANGELOG 都应能截出当前版本——CI 在打 tag 前就能发现漏写。
  it('仓库 CHANGELOG 含当前 package.json 版本的非空小节', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const result = run(version)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).not.toBe('')
  })
})
