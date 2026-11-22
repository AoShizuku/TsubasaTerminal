/**
 * 生成 THIRD_PARTY_NOTICES.md（清单）与 THIRD_PARTY_LICENSES.txt（许可证全文）。
 * 依赖变更后重跑（开源发布前置的依赖许可清点）：
 *
 *   node scripts/gen-notices.mjs           重新生成两个文件
 *   node scripts/gen-notices.mjs --check   与已提交的两个文件比对，不一致非零退出
 *
 * 借自姊妹项目 TsubasaRedisManager 的同名脚本，去掉 Cargo 半边，按 Electron 的
 * 打包方式重定"分发了什么"的口径：
 *
 * - **`dependencies` 的闭包**（见 prodClosure，不走 peer 边）。main/preload 用
 *   externalizeDepsPlugin 外置 `dependencies`，electron-builder 把它们的闭包原样
 *   装进 app.asar 的 node_modules；渲染层虽把它们打进 bundle，但同一批包本来就随
 *   asar 分发。v0.14.0 拿打好的 asar 逐包核过：76 个包与这份闭包一一对应。
 * - **打进产物的 dev 依赖**另行登记（BUNDLED_DEV）。dev 依赖不进 asar，但 Vite
 *   会把渲染层 import 到的代码/样式连同内容打进 bundle，那份内容同样随包分发。
 *   守卫：扫描 src/ 下所有运行时 import，凡解析到 dev 依赖而未登记的，`--check`
 *   直接红——"新加一个 dev 依赖被渲染层 import"这件事没有别的症状。
 * - **Electron 与 Chromium 不在此列**：electron-builder 把 `LICENSE.electron.txt`
 *   与 `LICENSES.chromium.html` 放在安装目录、与 exe 同级，见下方注记。
 *
 * 许可证全文按**内容**去重：同一份 MIT 全文只出现一次，上方列出共享它的包。
 * 各包自己的版权行因此仍逐字保留——那正是 MIT/ISC/BSD 要求复制的部分。
 *
 * 产出两个文件：清单留在 .md 供人读，全文进 .txt 承担分发义务；
 * 两者与 LICENSE 一起由 electron-builder 的 extraResources 装进 resources/。
 */

import { builtinModules } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)([-_.].*)?$/i
const INVENTORY = 'THIRD_PARTY_NOTICES.md'
const LICENSES = 'THIRD_PARTY_LICENSES.txt'

/**
 * 打进产物的 dev 依赖。值写**为什么**它会随包分发——这一栏是给下一个
 * 改依赖的人复核用的，不是装饰。
 */
const BUNDLED_DEV = {
  // 不经 import 进来：scripts/extract-specs.mjs 从它的 build/ 提取精简补全语料，
  // 生成 src/renderer/src/assets/fig-specs.json 并提交进仓库，再由渲染层打进 bundle
  '@withfig/autocomplete': 'command specs extracted into src/renderer/src/assets/fig-specs.json',
  // main.css 的 `@import 'tailwindcss'` 把 preflight 与主题层样式打进 CSS bundle
  tailwindcss: 'preflight and theme stylesheet compiled into the renderer CSS bundle'
}

/** 运行时 import 里**不**算第三方分发的说明符 */
const NON_PACKAGE = new Set([...builtinModules, 'electron'])
const isAlias = (spec) => spec.startsWith('@/') || spec.startsWith('@shared/')

/**
 * 手写的注记。生成器只会读包目录里的许可证文件，下面这些它看不到——
 * 有的藏在别处随包分发，有的是关于**没有**引入什么的决策。
 * 改依赖、改配色方案、改打包配置时顺带复核这一节，它不会自己更新。
 */
const MANUAL_NOTES = `## Additional notices

**Electron and Chromium.** The application runs on Electron (MIT), which embeds
Chromium, Node.js, V8 and their own dependencies. electron-builder places
\`LICENSE.electron.txt\` and \`LICENSES.chromium.html\` next to \`TsubasaTerminal.exe\` in
the installation directory; those two files are the notice for that layer and
are not repeated here.

**Command-line companion.** \`resources/cli/tsubasa-ssh.js\` is bundled from this
repository's own source and uses only Node.js built-in modules. It contains no
third-party code.

**Completion corpus.** \`src/renderer/src/assets/fig-specs.json\` is committed
data derived from \`@withfig/autocomplete\` (ISC, listed above):
\`scripts/extract-specs.mjs\` keeps the names, options and descriptions of a
fixed set of commands and drops everything else. It is the only third-party
material committed to this repository, and its notice is the ISC text in
THIRD_PARTY_LICENSES.txt.

**Terminal color schemes.** Tokyo Night, Dracula, Gruvbox Dark, Nord,
One Half Dark, One Half Light, Catppuccin Mocha and Catppuccin Latte in
\`src/shared/terminalThemes.ts\` reproduce the published color values of those
schemes, as converted by the iTerm2-Color-Schemes collection (the Catppuccin
ANSI colors from the official catppuccin/palette, the Latte selection color
from the official catppuccin/windows-terminal port). All eight schemes, that
collection and those Catppuccin projects are published under the MIT License.
Only color values are used; no source files from those projects are included.

**No vendored UI source.** The interface is styled with stylesheets authored in
this repository; \`reka-ui\` supplies unstyled behavioral primitives and is
consumed as an ordinary npm dependency. shadcn-vue component copies that
earlier versions carried under \`components/ui/\` were removed in v0.13.0 and
rewritten as this repository's own wrappers, so no copied component source
remains.
`

/** 包目录里随包分发的许可证文件。名字五花八门，按模式收而不是猜。 */
function licenseTexts(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => {
      const text = fs.readFileSync(path.join(dir, e.name), 'utf8').replace(/^﻿/, '')
      return { file: e.name, text: text.replace(/\r\n?/g, '\n').trim() }
    })
    .filter((entry) => entry.text.length > 0)
}

/** manifest 的 license 字段历史上有字符串、对象、数组三种写法 */
function declaredLicense(meta, dir) {
  const pick = (m) => {
    if (!m) return null
    if (typeof m.license === 'string') return m.license
    if (m.license && typeof m.license.type === 'string') return m.license.type
    if (Array.isArray(m.licenses)) {
      const types = m.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean)
      if (types.length) return types.join(' OR ')
    }
    return null
  }
  const fromLock = pick(meta)
  if (fromLock) return fromLock
  try {
    return pick(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))) ?? '(not declared)'
  } catch {
    return '(not declared)'
  }
}

/* ── 包集合 ──────────────────────────────────────────────
   package-lock v3 的 packages 表已经标好了 dev/devOptional，比跑 npm ls 稳；
   嵌套安装（a/node_modules/b）的包名取最后一个 node_modules/ 之后。 */

function lockPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  return Object.entries(lock.packages ?? {})
    .filter(([key]) => key.startsWith('node_modules/'))
    .map(([key, meta]) => ({
      key,
      meta,
      name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length)
    }))
}

function toEntry({ key, meta, name }, bundledReason) {
  const dir = path.join(root, key)
  if (!fs.existsSync(dir)) {
    throw new Error(`${name}@${meta.version} 在 lockfile 里但未安装（${key}）——先 npm ci 再生成`)
  }
  return {
    name,
    version: meta.version,
    license: declaredLicense(meta, dir),
    bundled: bundledReason ?? null,
    texts: licenseTexts(dir)
  }
}

/**
 * 按 Node 的解析规则在 lockfile 里找 `from` 目录下 require(name) 会命中的那份：
 * 先找自己的 node_modules，再逐级往上，最后是根。
 */
function resolveIn(byKey, fromKey, name) {
  let base = fromKey
  for (;;) {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`
    if (byKey.has(key)) return byKey.get(key)
    if (!base) return null
    const cut = base.lastIndexOf('/node_modules/')
    base = cut < 0 ? '' : base.slice(0, cut)
  }
}

/**
 * 沿 dependencies / optionalDependencies 边从根往下走，**不走 peer 边**。
 * 不能直接用 lockfile 的"非 dev"标记：npm 7+ 会把 prod 包的 peer 依赖装上并标成
 * prod——`@electron-toolkit/utils` peer 依赖 `electron`，于是 electron 本体连同
 * @electron/get 那一串下载器都成了"prod"，而 electron-builder 根本不把它装进 asar。
 */
function prodClosure(all) {
  const byKey = new Map(all.map((p) => [p.key, p]))
  const rootMeta = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages['']
  const reached = new Map()
  const edges = (fromKey, meta) => [
    ...Object.keys(meta.dependencies ?? {}).map((n) => [fromKey, n, false]),
    ...Object.keys(meta.optionalDependencies ?? {}).map((n) => [fromKey, n, true])
  ]
  const queue = edges('', rootMeta)
  while (queue.length) {
    const [fromKey, name, optional] = queue.shift()
    const p = resolveIn(byKey, fromKey, name)
    if (!p) {
      // 可选依赖不在 lockfile 里是正常的（平台不符）；必需依赖找不到说明 lockfile 坏了
      if (optional) continue
      throw new Error(`${fromKey || '(root)'} 依赖 ${name}，lockfile 里却解析不到`)
    }
    if (reached.has(p.key)) continue
    reached.set(p.key, p)
    queue.push(...edges(p.key, p.meta))
  }
  return [...reached.values()]
}

function collect() {
  const all = lockPackages()
  const byName = new Map()
  for (const p of all) if (!byName.has(p.name) || p.key === `node_modules/${p.name}`) byName.set(p.name, p)

  const seen = new Set()
  const out = []
  const push = (p, reason) => {
    const id = `${p.name}@${p.meta.version}`
    if (seen.has(id)) return
    seen.add(id)
    out.push(toEntry(p, reason))
  }

  for (const p of prodClosure(all)) push(p)

  const bundled = []
  for (const [name, reason] of Object.entries(BUNDLED_DEV)) {
    const p = byName.get(name)
    if (!p) throw new Error(`BUNDLED_DEV 登记了 ${name}，但 lockfile 里没有它——依赖已删就把登记一并删掉`)
    const before = out.length
    push(p, reason)
    if (out.length > before) bundled.push(out[out.length - 1])
  }

  const sortFn = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  const shipped = out.filter((e) => !e.bundled).sort(sortFn)
  return { shipped, bundled: bundled.sort(sortFn), byName }
}

/* ── 守卫：运行时 import 到的 dev 依赖必须已登记 ─────────── */

const IMPORT_RE = [
  // import x from 'p' / import { a } from 'p' / export * from 'p'（排除 import type / export type）
  /(?:^|[\s;])(?:import|export)\s+(?!type\s)[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  // 副作用 import：import 'p'
  /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
  // 动态 import('p')
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  // CSS：@import 'p' / @plugin 'p'
  /@(?:import|plugin)\s+['"]([^'"]+)['"]/g
]

function packageOf(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || isAlias(spec)) return null
  if (spec.startsWith('node:') || spec.includes(':')) return null
  const parts = spec.split('/')
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
  return NON_PACKAGE.has(name) ? null : name
}

function sourceFiles(dir) {
  const files = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) files.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mts|js|mjs|vue|css)$/.test(e.name) && !e.name.endsWith('.d.ts')) files.push(p)
  }
  return files
}

function unregisteredDevImports(byName) {
  const problems = []
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8')
    for (const re of IMPORT_RE) {
      for (const m of text.matchAll(re)) {
        const name = packageOf(m[1])
        if (!name) continue
        const p = byName.get(name)
        const rel = path.relative(root, file).split(path.sep).join('/')
        if (!p) problems.push(`${rel}: import '${m[1]}' 不在 lockfile 里`)
        else if ((p.meta.dev || p.meta.devOptional) && !(name in BUNDLED_DEV)) {
          problems.push(`${rel}: '${name}' 是 dev 依赖却被运行时代码 import——它会打进产物，登记进 BUNDLED_DEV 或移到 dependencies`)
        }
      }
    }
  }
  return [...new Set(problems)]
}

/* ── 输出 ───────────────────────────────────────────────── */

function table(rows) {
  return [
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} |`)
  ].join('\n')
}

function render({ shipped, bundled }) {
  const everyone = [...shipped, ...bundled]

  // 文本 → 共享它的包。同一份全文只落一次
  const texts = new Map()
  for (const pkg of everyone) {
    for (const { text } of pkg.texts) {
      if (!texts.has(text)) texts.set(text, new Set())
      texts.get(text).add(`${pkg.name} ${pkg.version}`)
    }
  }
  const missing = everyone.filter((p) => p.texts.length === 0)

  const md = []
  md.push('# Third-Party Notices')
  md.push('')
  md.push('Tsubasa Terminal is distributed under the MIT License (see `LICENSE`).')
  md.push('It bundles third-party components that remain under their own licenses.')
  md.push('')
  md.push('The license and copyright texts these components require to be reproduced are')
  md.push(`in [${LICENSES}](${LICENSES}). This file is the inventory; that file is the notice.`)
  md.push('Both are installed with the application under `resources/`, next to `LICENSE`.')
  md.push('')
  md.push('Both are generated — run `node scripts/gen-notices.mjs` after any dependency')
  md.push('change rather than editing them by hand; `npm run typecheck` fails while they')
  md.push('are out of date. They cover what is actually shipped: the production')
  md.push('dependency closure from `package-lock.json`, which electron-builder installs')
  md.push('into `app.asar`, plus the development dependencies whose content the build')
  md.push('compiles into the application bundle. Other build-time tooling does not reach')
  md.push('the installed application and carries no distribution duty.')
  md.push('')
  md.push(`Covered: ${shipped.length} packaged npm dependencies, ${bundled.length} bundled build-time packages.`)
  md.push('')
  md.push('## Packaged npm dependencies')
  md.push('')
  md.push(table(shipped))
  md.push('')
  md.push('## Build-time packages compiled into the bundle')
  md.push('')
  md.push('| Package | Version | License | What ships |')
  md.push('| --- | --- | --- | --- |')
  for (const r of bundled) md.push(`| ${r.name} | ${r.version} | ${r.license} | ${r.bundled} |`)
  md.push('')

  if (missing.length) {
    md.push('## Packages shipping no license file')
    md.push('')
    md.push('These declare a license in their manifest but ship no license text inside the')
    md.push('published package. The SPDX identifier in the tables above governs, and the')
    md.push(`standard text for each of those identifiers appears in ${LICENSES} by way of`)
    md.push('the other packages using it.')
    md.push('')
    md.push(table(missing))
    md.push('')
  }

  md.push(MANUAL_NOTES)

  const txt = []
  txt.push('THIRD-PARTY LICENSE TEXTS')
  txt.push('')
  txt.push('Reproduced verbatim from the packages bundled with Tsubasa Terminal.')
  txt.push(`See ${INVENTORY} for the package inventory and versions.`)
  txt.push('')
  txt.push('Identical texts appear once, with every package sharing them named above the')
  txt.push('text. Per-package copyright lines are therefore preserved as written.')
  txt.push('')

  let index = 0
  for (const [text, users] of texts) {
    index += 1
    txt.push('='.repeat(78))
    txt.push(`${index}. ${[...users].sort().join(', ')}`)
    txt.push('='.repeat(78))
    txt.push('')
    txt.push(text)
    txt.push('')
  }

  return { md: md.join('\n'), txt: txt.join('\n'), textCount: texts.size, missing: missing.length }
}

function main() {
  const check = process.argv.includes('--check')
  const collected = collect()

  const problems = unregisteredDevImports(collected.byName)
  if (problems.length) {
    console.error('[gen-notices] 运行时代码 import 了未登记的包：')
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }

  const out = render(collected)
  const files = [
    [path.join(root, INVENTORY), out.md],
    [path.join(root, LICENSES), out.txt]
  ]

  if (check) {
    const norm = (s) => s.replace(/\r\n?/g, '\n')
    const stale = files.filter(([file, content]) => {
      try {
        return norm(fs.readFileSync(file, 'utf8')) !== norm(content)
      } catch {
        return true
      }
    })
    if (stale.length) {
      console.error(
        `[gen-notices] ${stale.map(([f]) => path.basename(f)).join('、')} 与当前依赖不一致——` +
          '跑 node scripts/gen-notices.mjs 重新生成并提交'
      )
      process.exit(1)
    }
    console.log(`[gen-notices] ok：${collected.shipped.length} + ${collected.bundled.length} 个包，清单与全文均为最新`)
    return
  }

  for (const [file, content] of files) fs.writeFileSync(file, content, 'utf8')
  const kb = (file) => (fs.statSync(file).size / 1024).toFixed(0)
  console.log(`wrote ${INVENTORY} (${kb(files[0][0])} KB)`)
  console.log(`wrote ${LICENSES} (${kb(files[1][0])} KB)`)
  console.log(
    `  packaged: ${collected.shipped.length}, bundled build-time: ${collected.bundled.length}, license texts: ${out.textCount}`
  )
  if (out.missing) console.log(`  no license file shipped: ${out.missing} packages`)
}

main()
