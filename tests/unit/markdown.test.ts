import { describe, expect, it } from 'vitest'

import { renderMarkdown, repairTableDelimiters } from '../../src/renderer/src/lib/markdown'

/** 渲染结果里的表头文字，按列 */
function headers(html: string): string[] {
  return [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map((m) => m[1])
}

describe('repairTableDelimiters', () => {
  it('分隔行比表头多一列（模型数错列的实况）：截到表头列数，整张表照常渲染', () => {
    // 真实缺陷的形状：表头 15 列、分隔行 `|---:|` + 15 个 `|---|` 共 16 列，整表退成满屏竖线
    const cols = Array.from({ length: 15 }, (_, i) => `列${i + 1}`)
    const text = [
      '巡检汇总：',
      '',
      `| ${cols.join(' | ')} |`,
      '|---:|' + '---|'.repeat(15),
      `| ${cols.map((_, i) => `v${i + 1}`).join(' | ')} |`
    ].join('\n')

    const html = renderMarkdown(text)
    expect(headers(html)).toEqual(cols)
    // 已有的对齐标记照留
    expect(html).toContain('<th style="text-align:right">列1</th>')
    expect(html).toContain('<td>v15</td>')
    expect(html).not.toContain('|---')
  })

  it('分隔行少列：补 --- 到表头列数', () => {
    const html = renderMarkdown('| 主机 | 负载 | 磁盘 |\n|---|---|\n| web1 | 0.42 | 38% |')
    expect(headers(html)).toEqual(['主机', '负载', '磁盘'])
    expect(html).toContain('<td>38%</td>')
  })

  it('数据行比表头宽：判为表头漏了列名，补空表头而不丢数据', () => {
    const html = renderMarkdown('| 主机 | 负载 |\n|---|---|---|\n| web1 | 0.42 | 38% |')
    expect(headers(html)).toEqual(['主机', '负载', ''])
    expect(html).toContain('<td>38%</td>')
  })

  it('不带首尾管道的写法同样修复，转义管道不算分列', () => {
    const fixed = repairTableDelimiters('a \\| b | c\n--- | --- | ---\nx | y')
    expect(fixed.split('\n')[1]).toBe('| --- | --- |')
    expect(headers(renderMarkdown('a \\| b | c\n--- | --- | ---\nx | y'))).toEqual(['a | b', 'c'])
  })

  it('列数本来就对、或根本不是表格：原文不动', () => {
    const ok = '| a | b |\n|---|---|\n| 1 | 2 |'
    expect(repairTableDelimiters(ok)).toBe(ok)
    // 不带管道的 --- 是 setext 标题下划线
    const setext = 'a | b\n---'
    expect(repairTableDelimiters(setext)).toBe(setext)
    expect(renderMarkdown(setext)).toContain('<h2>a | b</h2>')
    // 列表项开头的 "- " 不是分隔行
    const list = 'x | y | z\n- | ---'
    expect(repairTableDelimiters(list)).toBe(list)
  })

  it('代码围栏里的内容一概不碰，含未闭合的围栏（流式输出中途）', () => {
    const fenced = '```text\n| a | b |\n|---|---|---|\n```\n'
    expect(repairTableDelimiters(fenced)).toBe(fenced)
    const tilde = '~~~~\n| a | b |\n|---|\n~~~\n| still | fenced |\n|---|\n'
    expect(repairTableDelimiters(tilde)).toBe(tilde)
    const streaming = '先看输出：\n```\n| a | b |\n|---|---|---|'
    expect(repairTableDelimiters(streaming)).toBe(streaming)
  })

  it('围栏关闭后恢复修复', () => {
    const text = '```\ncode\n```\n\n| a | b |\n|---|---|---|\n| 1 | 2 |'
    expect(headers(renderMarkdown(text))).toEqual(['a', 'b'])
  })
})

describe('renderMarkdown 外壳', () => {
  it('表格外包横向滚动框，代码块带复制按钮', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n```bash\ndf -h /\n```')
    expect(html).toMatch(/<div class="md-table"><table>[\s\S]*<\/table>\s*<\/div>/)
    expect(html).toMatch(/<div class="md-code"><button[^>]*data-md-copy[^>]*>复制<\/button><pre>/)
  })
})
