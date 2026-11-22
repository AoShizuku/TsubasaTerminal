import { createHash } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * skill 原地安装：Codex 落点迁到 `~/.agents/skills/`，旧 `~/.codex/skills/`
 * 只清本安装器 manifest 记录且未改的文件。全程真实文件系统（TSUBASATERMINAL_CLI_HOME 沙盒），
 * 只替身 electron 的 app 版本号。
 */

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getPath: () => state.home,
    getAppPath: () => state.home,
    isPackaged: false
  }
}))

const MARKER = '.tsubasa-ssh-install.json'

let home: string
let previousHome: string | undefined

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function agentsDir(): string {
  return join(home, '.agents', 'skills', 'tsubasa-ssh')
}

function legacyDir(): string {
  return join(home, '.codex', 'skills', 'tsubasa-ssh')
}

/** 按旧版安装器的产物格式放一份 skill（正文 + manifest） */
function seedManaged(dir: string, body: string, version = '0.13.16'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8')
  writeFileSync(
    join(dir, MARKER),
    JSON.stringify({ version, files: { 'SKILL.md': sha(body) } }, null, 2),
    'utf-8'
  )
}

/** 旁边的 `.system` 与别家 skill：迁移清理绝不能碰 */
function seedNeighbours(): { system: string; other: string } {
  const system = join(home, '.codex', 'skills', '.system', 'skill-creator', 'SKILL.md')
  const other = join(home, '.codex', 'skills', 'tsubasa-mysql', 'SKILL.md')
  mkdirSync(join(system, '..'), { recursive: true })
  mkdirSync(join(other, '..'), { recursive: true })
  writeFileSync(system, 'system skill', 'utf-8')
  writeFileSync(other, 'mysql skill', 'utf-8')
  return { system, other }
}

async function load(): Promise<typeof import('../../../src/main/cli/install')> {
  return await import('../../../src/main/cli/install')
}

beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'tsubasaterminal-skill-test-'))
  state.home = home
  previousHome = process.env['TSUBASATERMINAL_CLI_HOME']
  process.env['TSUBASATERMINAL_CLI_HOME'] = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env['TSUBASATERMINAL_CLI_HOME']
  else process.env['TSUBASATERMINAL_CLI_HOME'] = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('Codex skill 落点', () => {
  it('装到 ~/.agents/skills，宿主检测仍看 ~/.codex，Claude 落点不变', async () => {
    const install = await load()
    let codex = await install.skillStatus('codex')
    expect(codex.dir).toBe(agentsDir())
    expect(codex.hostPresent).toBe(false)
    expect(codex.legacyDir).toBeNull()

    mkdirSync(join(home, '.codex'))
    // 只有 ~/.agents 不算检测到 Codex
    mkdirSync(join(home, '.agents'))
    codex = await install.installSkill('codex')
    expect(codex).toMatchObject({ state: 'installed', installedVersion: '9.9.9', hostPresent: true })
    expect(existsSync(join(agentsDir(), 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.codex', 'skills'))).toBe(false)

    const claude = await install.installSkill('claude')
    expect(claude.dir).toBe(join(home, '.claude', 'skills', 'tsubasa-ssh'))
    expect(claude.legacyDir).toBeNull()
    expect(readFileSync(join(claude.dir, 'SKILL.md'), 'utf-8')).toBe(
      readFileSync(join(agentsDir(), 'SKILL.md'), 'utf-8')
    )
  })

  it('接管手工复制到 ~/.agents 的旧副本，并清掉 ~/.codex 下未改的旧安装', async () => {
    const neighbours = seedNeighbours()
    seedManaged(agentsDir(), 'old skill body\n')
    seedManaged(legacyDir(), 'old skill body\n')
    const install = await load()

    const before = await install.skillStatus('codex')
    expect(before).toMatchObject({ state: 'outdated', installedVersion: '0.13.16' })
    expect(before.legacyDir).toBe(legacyDir())

    const after = await install.installSkill('codex')
    expect(after).toMatchObject({ state: 'installed', installedVersion: '9.9.9', legacyDir: null })
    expect(readFileSync(join(agentsDir(), 'SKILL.md'), 'utf-8')).toContain('name: tsubasa-ssh')
    expect(existsSync(legacyDir())).toBe(false)
    // 父目录、.system、别家 skill 原样
    expect(existsSync(join(home, '.codex', 'skills'))).toBe(true)
    expect(readFileSync(neighbours.system, 'utf-8')).toBe('system skill')
    expect(readFileSync(neighbours.other, 'utf-8')).toBe('mysql skill')
  })

  it('旧落点手工改过：文件与 manifest 都保留，状态如实报出旧目录', async () => {
    seedManaged(legacyDir(), 'old skill body\n')
    writeFileSync(join(legacyDir(), 'SKILL.md'), 'old skill body\n<!-- 我改的 -->\n', 'utf-8')
    const install = await load()

    const after = await install.installSkill('codex')
    expect(after.state).toBe('installed')
    expect(after.legacyDir).toBe(legacyDir())
    expect(readFileSync(join(legacyDir(), 'SKILL.md'), 'utf-8')).toContain('我改的')
    expect(existsSync(join(legacyDir(), MARKER))).toBe(true)
  })

  it('旧落点有 manifest 之外的文件：只删托管且未改的，目录与额外文件保留', async () => {
    seedManaged(legacyDir(), 'old skill body\n')
    writeFileSync(join(legacyDir(), 'notes.md'), 'my notes', 'utf-8')
    const install = await load()

    const after = await install.installSkill('codex')
    expect(after.legacyDir).toBe(legacyDir())
    expect(existsSync(join(legacyDir(), 'SKILL.md'))).toBe(false)
    expect(existsSync(join(legacyDir(), MARKER))).toBe(false)
    expect(readFileSync(join(legacyDir(), 'notes.md'), 'utf-8')).toBe('my notes')
  })

  it('旧落点没有 manifest（用户自己放的）：整目录不动', async () => {
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(join(legacyDir(), 'SKILL.md'), 'hand made', 'utf-8')
    const install = await load()

    const after = await install.installSkill('codex')
    expect(after.legacyDir).toBe(legacyDir())
    expect(readFileSync(join(legacyDir(), 'SKILL.md'), 'utf-8')).toBe('hand made')
  })

  it('manifest 里的越界条目不跟随，hash 对得上也不删', async () => {
    const { other } = seedNeighbours()
    mkdirSync(legacyDir(), { recursive: true })
    writeFileSync(
      join(legacyDir(), MARKER),
      JSON.stringify({ version: '0.13.16', files: { '../tsubasa-mysql/SKILL.md': sha('mysql skill') } }),
      'utf-8'
    )
    const install = await load()

    const after = await install.installSkill('codex')
    expect(readFileSync(other, 'utf-8')).toBe('mysql skill')
    expect(existsSync(join(legacyDir(), MARKER))).toBe(true)
    expect(after.legacyDir).toBe(legacyDir())
  })

  it('新落点手工改过时不覆盖，但仍清掉旧落点未改的托管副本', async () => {
    seedManaged(agentsDir(), 'mine\n')
    writeFileSync(join(agentsDir(), 'SKILL.md'), 'mine, edited\n', 'utf-8')
    seedManaged(legacyDir(), 'old skill body\n')
    const install = await load()

    const after = await install.installSkill('codex')
    expect(after).toMatchObject({ state: 'modified', legacyDir: null })
    expect(readFileSync(join(agentsDir(), 'SKILL.md'), 'utf-8')).toBe('mine, edited\n')
    expect(existsSync(legacyDir())).toBe(false)
  })

  it('卸载同时清理新旧两处，旧落点手工内容保留', async () => {
    const neighbours = seedNeighbours()
    const install = await load()
    await install.installSkill('codex')
    seedManaged(legacyDir(), 'old skill body\n')
    writeFileSync(join(legacyDir(), 'extra.txt'), 'keep me', 'utf-8')

    const after = await install.removeSkill('codex')
    expect(after.state).toBe('absent')
    expect(existsSync(agentsDir())).toBe(false)
    expect(existsSync(join(legacyDir(), 'SKILL.md'))).toBe(false)
    expect(readFileSync(join(legacyDir(), 'extra.txt'), 'utf-8')).toBe('keep me')
    expect(after.legacyDir).toBe(legacyDir())
    expect(readFileSync(neighbours.system, 'utf-8')).toBe('system skill')
    expect(readFileSync(neighbours.other, 'utf-8')).toBe('mysql skill')
  })

  it('旧落点是指向新落点的链接：不进去删，也不算残留', async () => {
    const install = await load()
    await install.installSkill('codex')
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
    symlinkSync(agentsDir(), legacyDir(), 'junction')

    const after = await install.installSkill('codex', true)
    expect(after).toMatchObject({ state: 'installed', legacyDir: null })
    expect(existsSync(join(agentsDir(), 'SKILL.md'))).toBe(true)
    expect(existsSync(join(agentsDir(), MARKER))).toBe(true)
  })

  it('~/.codex/skills 整个链到 ~/.agents/skills：同一处文件不当旧副本删', async () => {
    const install = await load()
    await install.installSkill('codex')
    mkdirSync(join(home, '.codex'), { recursive: true })
    symlinkSync(join(home, '.agents', 'skills'), join(home, '.codex', 'skills'), 'junction')

    const after = await install.installSkill('codex', true)
    expect(after).toMatchObject({ state: 'installed', legacyDir: null })
    expect(existsSync(join(agentsDir(), 'SKILL.md'))).toBe(true)
    const removed = await install.removeSkill('codex')
    expect(removed.state).toBe('absent')
    expect(existsSync(join(home, '.agents', 'skills'))).toBe(true)
  })
})
