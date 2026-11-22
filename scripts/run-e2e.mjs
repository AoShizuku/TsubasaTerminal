import { spawn } from 'child_process'
import { createRequire } from 'module'

const mode = process.argv[2] ?? 'full'
if (mode !== 'full' && mode !== 'daily') {
  console.error(`[e2e] 未知模式：${mode}（只接受 full / daily）`)
  process.exit(2)
}

function positiveWorkers(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isInteger(parsed) && parsed > 0) return parsed
  }
  return undefined
}

const commonWorkers = process.env.TSUBASATERMINAL_E2E_WORKERS
const hiddenWorkers = positiveWorkers(
  process.env.TSUBASATERMINAL_E2E_HIDDEN_WORKERS,
  commonWorkers,
  mode === 'daily' ? 2 : 5
)
const headedWorkers = positiveWorkers(
  process.env.TSUBASATERMINAL_E2E_HEADED_WORKERS,
  commonWorkers,
  2
)
const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')

function runPhase(args, extraEnv, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      windowsHide: true
    })
    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`Playwright 被信号 ${signal} 中止`))
      else resolve({ code: code ?? 1, stdout })
    })
  })
}

// grep 必须与 daily/车道取交集；其余参数原样传递（包括文件、--grep-invert、
// --repeat-each、--list 和 --workers）。同名 grep 遵循 Playwright 的最后一次优先。
const forwarded = []
let grep = '.*'
for (let i = 3; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg === '--grep' || arg === '-g') {
    if (process.argv[i + 1] === undefined) throw new Error(`${arg} 缺少正则表达式`)
    grep = process.argv[++i]
  } else if (arg.startsWith('--grep=')) {
    grep = arg.slice('--grep='.length)
  } else if (arg.startsWith('-g') && arg.length > 2) {
    grep = arg.slice(2)
  } else {
    forwarded.push(arg)
  }
}
// 在加入包装前校验，避免一个不完整的表达式意外吃掉车道约束。
new RegExp(grep)

if (forwarded.includes('--help') || forwarded.includes('-h')) {
  process.exit((await runPhase(['--help'], {})).code)
}

function countTests(suites) {
  return suites.reduce((count, suite) => count +
    suite.specs.reduce((sum, spec) => sum + spec.tests.length, 0) +
    countTests(suite.suites ?? []), 0)
}

let selected = 0
for (const [name, headed, workers] of [
  ['后台渲染', false, hiddenWorkers],
  ['桌面边界', true, headedWorkers]
]) {
  // 不增加捕获组，保留用户表达式里的反向引用；跨行匹配也保持原表达式语义。
  const pattern = '^' +
    (mode === 'daily' ? '(?=[\\s\\S]*@daily)' : '') +
    (headed ? '(?=[\\s\\S]*@headed)' : '(?![\\s\\S]*@headed)') +
    `(?=[\\s\\S]*(?:${grep}))[\\s\\S]*$`
  const args = [`--workers=${workers}`, ...forwarded, '--grep', pattern]
  const env = { TSUBASATERMINAL_E2E_HIDDEN: headed ? '0' : '1' }
  // 先收集、不启动 Electron：空车道可跳过，但两边都为空仍须失败，不能掩盖拼错的筛选。
  const discovery = await runPhase(
    [...args, '--list', '--reporter=json', '--pass-with-no-tests'], env, true
  )
  if (discovery.code !== 0) {
    process.stderr.write(discovery.stdout)
    process.exit(discovery.code)
  }
  const count = countTests(JSON.parse(discovery.stdout).suites)
  console.log(`[e2e] ${mode} · ${name} · ${count} 条`)
  if (count === 0) continue
  selected += count
  const result = await runPhase(args, env)
  if (result.code !== 0) process.exit(result.code)
}
if (selected === 0 && !forwarded.includes('--pass-with-no-tests')) {
  console.error('[e2e] 没有匹配的测试，请检查文件与筛选条件')
  process.exit(1)
}
