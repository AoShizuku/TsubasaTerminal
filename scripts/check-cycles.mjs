/**
 * 循环依赖守卫（v0.12.2 前的整理）。
 *
 * 为什么要有：拆掉的环会长回来，而且长回来的时候没有任何症状——
 * 循环依赖不报错、typecheck 不管、e2e 也照过，只在某天有人把一个调用
 * 从函数体提到模块顶层时突然变成 "undefined is not a function"。
 * 唯一能守住的办法是把"当前有几个环"变成一个会红的数字。
 *
 * 判定口径：
 * - 只算 **value import**。`import type {...}` 与 `import { type A }` 编译期擦除，
 *   构不成运行时环，报了只会让人学会忽略这个脚本。
 * - .vue 只取 <script> 段。
 * - 解析 `@/`、`@shared/` 与相对路径，与 electron.vite.config / tsconfig 的
 *   alias 保持一致。
 *
 * 用法：node scripts/check-cycles.mjs        有环则非零退出并列出每条边
 *      node scripts/check-cycles.mjs --list  只列出，恒零退出（排查用）
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, dirname, resolve, relative } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', 'src')
const RENDERER = join(ROOT, 'renderer', 'src')

const norm = (p) => p.split('\\').join('/')
const rel = (p) => norm(relative(ROOT, p))

const files = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|vue)$/.test(entry)) files.push(norm(p))
  }
}
walk(ROOT)

function resolveSpec(spec, fromFile) {
  let base
  if (spec.startsWith('@shared/')) base = norm(join(ROOT, 'shared', spec.slice('@shared/'.length)))
  else if (spec.startsWith('@/')) base = norm(join(RENDERER, spec.slice(2)))
  else if (spec.startsWith('.')) base = norm(resolve(dirname(fromFile), spec))
  else return null // 第三方包，不参与
  for (const cand of [base, base + '.ts', base + '.vue', join(base, 'index.ts')]) {
    const c = norm(cand)
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

/** file -> Map<targetFile, 'value' | 'type'> */
const graph = new Map()
for (const file of files) {
  let src = readFileSync(file, 'utf8')
  if (file.endsWith('.vue')) {
    src = (src.match(/<script[^>]*>[\s\S]*?<\/script>/g) || []).join('\n')
  }
  const edges = new Map()
  const re = /import\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src))) {
    const target = resolveSpec(m[3], file)
    if (!target) continue
    let kind = 'value'
    if (m[1]) kind = 'type'
    else if (m[2].trim().startsWith('{')) {
      const specs = m[2]
        .replace(/[{}]/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (specs.length && specs.every((s) => s.startsWith('type '))) kind = 'type'
    }
    // 同一对文件出现多条 import 时，value 优先（有一条实值边就是实值边）
    edges.set(target, edges.get(target) === 'value' ? 'value' : kind)
  }
  graph.set(file, edges)
}

// Tarjan 强连通分量，只走 value 边
const index = new Map()
const low = new Map()
const onStack = new Map()
const stack = []
const groups = []
let counter = 0

function strongConnect(v) {
  index.set(v, counter)
  low.set(v, counter)
  counter++
  stack.push(v)
  onStack.set(v, true)
  for (const [w, kind] of graph.get(v) || []) {
    if (kind !== 'value') continue
    if (!index.has(w)) {
      strongConnect(w)
      low.set(v, Math.min(low.get(v), low.get(w)))
    } else if (onStack.get(w)) {
      low.set(v, Math.min(low.get(v), index.get(w)))
    }
  }
  if (low.get(v) === index.get(v)) {
    const comp = []
    let w
    do {
      w = stack.pop()
      onStack.set(w, false)
      comp.push(w)
    } while (w !== v)
    if (comp.length > 1) groups.push(comp)
  }
}
for (const f of files) if (!index.has(f)) strongConnect(f)

/**
 * 存量基线（棘轮）：只认这一组已知环，新长出来的一律红。
 *
 * 断这一组要把 TransferPipeline 的"反向找 session"改成上层注入端口
 * （见 doc 里的审查结论），属于有回归面的改动，不与本次整理同批做——
 * 但**不允许它再长大**，也不允许别处新长环。清掉后把这个数组置空。
 */
const KNOWN_CYCLES = [['main/audit.ts', 'main/ssh.ts', 'main/transfer.ts']]
const keyOf = (comp) => comp.map(rel).sort().join(' + ')
const baseline = new Set(KNOWN_CYCLES.map((c) => c.slice().sort().join(' + ')))

function describe(comp) {
  const set = new Set(comp)
  const lines = [`  组（${comp.length} 个文件）: ${keyOf(comp)}`]
  for (const f of comp.slice().sort()) {
    for (const [w, kind] of graph.get(f) || []) {
      if (set.has(w) && kind === 'value') lines.push(`    ${rel(f)} -> ${rel(w)}`)
    }
  }
  return lines.join('\n')
}

console.log(`循环依赖检查：扫描 ${files.length} 个文件（只算 value import）`)

const fresh = groups.filter((c) => !baseline.has(keyOf(c)))
const seen = new Set(groups.map(keyOf))
const gone = [...baseline].filter((k) => !seen.has(k))

for (const k of gone) {
  console.log(`\n✓ 基线里的环已消失，请从 KNOWN_CYCLES 删掉这条：${k}`)
}
for (const c of groups.filter((c) => baseline.has(keyOf(c)))) {
  console.log(`\n· 已知存量环（基线内，暂不阻断）:\n${describe(c)}`)
}

if (fresh.length === 0) {
  console.log(`\n✓ 没有新增循环依赖`)
  process.exit(0)
}

for (const c of fresh) console.log(`\n✗ 新增循环依赖:\n${describe(c)}`)
console.log(
  `\n新增 ${fresh.length} 组。断环的既有 idiom：下层留注入口、上层装配时递依赖` +
    `（见 focusManager.setActiveSessionProvider / conversations.setActiveConvIdsProvider / ToolContext.ptyGuard）。`
)
process.exit(process.argv.includes('--list') ? 0 : 1)
