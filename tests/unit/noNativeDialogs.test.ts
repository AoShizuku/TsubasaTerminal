import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * 原生弹窗守卫。确认一律走 lib/confirm 的 confirmDialog：原生框外观割裂，
 * 且冻住渲染线程——换成异步确认框时须补的重入与等待期校验，新调用点照抄原生写法就会漏。
 * 主进程只保留系统文件选择器（showOpenDialog / showSaveDialog），不弹消息框。
 */

const ROOT = join(__dirname, '../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

function offenders(dir: string, pattern: RegExp): string[] {
  return sourceFiles(join(ROOT, dir)).flatMap((file) =>
    readFileSync(file, 'utf-8')
      .split('\n')
      .flatMap((line, i) =>
        pattern.test(line) ? [`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`] : []
      )
  )
}

describe('native dialogs', () => {
  it('renderer never calls window.confirm / alert / prompt', () => {
    expect(
      offenders('src/renderer/src', /(?<![\w$.])(?:window\.)?(?:confirm|alert|prompt)\s*\(/)
    ).toEqual([])
  })

  it('main process shows no native message boxes', () => {
    expect(offenders('src/main', /\b(?:showMessageBox|showMessageBoxSync|showErrorBox)\b/)).toEqual(
      []
    )
  })
})
