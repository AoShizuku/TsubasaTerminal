import MarkdownIt from 'markdown-it'

/**
 * Agent 面板 markdown 渲染（v0.8 审批可读性配套）。
 * 安全边界：Agent 文本可能复述被注入的远端内容——
 * - html:false 禁 raw HTML（透传即 XSS 面），markdown-it 全量转义；
 * - 链接保留 href 但点击被面板委托拦截，确认后才 openExternal
 *   （validateLink 默认挡 javascript: 等危险协议）；
 * - 容忍非规范 markdown（终端输出引用）：linkify + breaks，渲染失败退纯文本。
 */

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

// 代码块加复制按钮（默认渲染结果外包一层，按钮由 AgentPanel 委托处理）
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const inner = defaultFence(tokens, idx, options, env, self)
  return `<div class="md-code"><button type="button" class="md-copy" data-md-copy title="复制代码">复制</button>${inner}</div>`
}

// 表格外包一层横向滚动框：侧栏窄，宽表只在自己的框里滚，不把整条消息流顶出横向滚动条
md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
  `<div class="md-table">${self.renderToken(tokens, idx, options)}`
md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
  `${self.renderToken(tokens, idx, options)}</div>`

// ---------- 表格分隔行容错 ----------

/** 照抄 markdown-it 表格规则的 escapedSplit：`\|` 不切分，列数口径与渲染器一致 */
function escapedSplit(str: string): string[] {
  const result: string[] = []
  let current = ''
  let lastPos = 0
  let isEscaped = false
  for (let pos = 0; pos < str.length; pos++) {
    const ch = str[pos]
    if (ch === '|') {
      if (!isEscaped) {
        result.push(current + str.substring(lastPos, pos))
        current = ''
        lastPos = pos + 1
      } else {
        current += str.substring(lastPos, pos - 1)
        lastPos = pos
      }
    }
    isEscaped = ch === '\\'
  }
  result.push(current + str.substring(lastPos))
  return result
}

/** 表头 / 数据行的列数（首尾管道两侧的空串不算列） */
function rowColumns(line: string): number {
  const cells = escapedSplit(line.trim())
  if (cells.length && cells[0] === '') cells.shift()
  if (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells.length
}

/**
 * 分隔行的各列标记（`---` / `:--` / `--:` / `:-:`）；不是合法分隔行返回 null。
 * 判定同 markdown-it，另要求含 `|`：不带管道的 `---` 是 setext 标题下划线，不能当表格改。
 */
function delimiterCells(line: string): string[] | null {
  if (!line.includes('|')) return null
  const lead = line.match(/^ */)![0].length
  if (lead >= 4) return null
  const text = line.trim()
  if (!/^[-:|][-:|\s]*$/.test(text)) return null
  if (/^-\s/.test(text)) return null // 列表项歧义，markdown-it 同样不认
  const parts = text.split('|')
  const cells: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i].trim()
    if (!t) {
      if (i === 0 || i === parts.length - 1) continue
      return null
    }
    if (!/^:?-+:?$/.test(t)) return null
    cells.push(t)
  }
  return cells
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})/

/**
 * 模型写宽表常把分隔行数错一列（如表头 15 列、分隔行 16 列）。GFM 要求两者列数严格相等，
 * 否则整张表退回成满屏竖线的段落。这里在渲染前把分隔行补齐 / 截断到表头列数；
 * 首个数据行比表头还宽时说明是表头漏了列名，按数据行补空表头，不丢数据。
 * 只动渲染输入，复制按钮给的仍是模型原文；代码围栏内一概不碰。
 */
export function repairTableDelimiters(text: string): string {
  if (!text.includes('|')) return text
  const lines = text.split('\n')
  let fence: { ch: string; len: number } | null = null
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fm = line.match(FENCE_OPEN)
    if (fence) {
      if (fm && fm[1][0] === fence.ch && fm[1].length >= fence.len && line.trim() === fm[1]) {
        fence = null
      }
      continue
    }
    if (fm) {
      fence = { ch: fm[1][0], len: fm[1].length }
      continue
    }
    if (i + 1 >= lines.length || !line.includes('|')) continue
    if (line.match(/^ */)![0].length >= 4) continue
    const aligns = delimiterCells(lines[i + 1])
    if (!aligns) continue
    const header = rowColumns(line)
    if (header === 0 || header === aligns.length) continue

    const body = i + 2 < lines.length && lines[i + 2].includes('|') ? rowColumns(lines[i + 2]) : 0
    const target = Math.max(header, body)
    if (target > header) {
      let h = line.replace(/\s+$/, '')
      if (!/(^|[^\\])\|$/.test(h)) h += ' |'
      lines[i] = h + ' |'.repeat(target - header)
    }
    const cells = aligns.slice(0, target)
    while (cells.length < target) cells.push('---')
    const indent = lines[i + 1].match(/^ */)![0]
    lines[i + 1] = `${indent}| ${cells.join(' | ')} |`
    changed = true
    i++ // 分隔行已处理，下一轮从数据行起
  }
  return changed ? lines.join('\n') : text
}

export function renderMarkdown(text: string): string {
  try {
    return md.render(repairTableDelimiters(text))
  } catch {
    // 渲染器被喂了极端输入：退纯文本（转义后原样展示）
    return `<p>${md.utils.escapeHtml(text)}</p>`
  }
}
