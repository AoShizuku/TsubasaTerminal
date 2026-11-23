// 从 CHANGELOG 截取某个版本的小节，作为 GitHub Release 说明输出到 stdout。
//
// 用法：node scripts/release-notes.mjs <版本号> [CHANGELOG 路径]
// 版本号不带 v 前缀。锚点是 `## [版本号]` 标题，截到下一个 `## ` 标题或文末链接定义为止。
// 找不到小节或小节为空时退出码 1：release.yml 的 guard 靠它拦下“bump 了版本却没写 CHANGELOG”，
// 出包步骤用同一份输出作 Release 说明。改 CHANGELOG 标题格式须同步改这里。
import { readFileSync } from 'node:fs'

const [version, file = 'CHANGELOG.md'] = process.argv.slice(2)
if (!version) {
  console.error('[release-notes] 用法：node scripts/release-notes.mjs <版本号> [CHANGELOG 路径]')
  process.exit(2)
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/)
const anchor = `## [${version}]`
const start = lines.findIndex(line => line === anchor || line.startsWith(`${anchor} `))
if (start < 0) {
  console.error(`[release-notes] ${file} 中没有 ${anchor} 小节`)
  process.exit(1)
}

const body = []
for (const line of lines.slice(start + 1)) {
  if (line.startsWith('## ') || /^\[[^\]]+\]:\s/.test(line)) break
  body.push(line)
}
const notes = body.join('\n').trim()
if (!notes) {
  console.error(`[release-notes] ${file} 的 ${anchor} 小节为空`)
  process.exit(1)
}
process.stdout.write(`${notes}\n`)
