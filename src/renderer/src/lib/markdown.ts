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

export function renderMarkdown(text: string): string {
  try {
    return md.render(text)
  } catch {
    // 渲染器被喂了极端输入：退纯文本（转义后原样展示）
    return `<p>${md.utils.escapeHtml(text)}</p>`
  }
}
