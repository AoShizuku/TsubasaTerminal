/**
 * 一行屏幕文本看着像不像 shell prompt（stalled 提示与自动重载 SI 共用的判定）。
 *
 * 传统结尾 `$ # > %` 之外，v0.13.15 补上提示符框架的常见结尾：starship / pure / p10k
 * 的 `❯`，以及 `λ` `»`（arch 真机 starship 下嵌套 zsh 换 shell 后既无提示也不自动
 * 重载）。它们都不像密码提示（`:` 结尾）或 `y/N` 问答，误判代价与旧集合同级：多一行
 * 灰字，或往前台进程多写一行 source。oh-my-zsh robbyrussell 的 `➜  dir ` 以目录名
 * 结尾，仍不认（行首判定误伤面另算，未做）。
 */
const PROMPT_TAIL = /[$#>%❯λ»]$/

export function isPromptLikeLine(text: string): boolean {
  const trimmed = text.trimEnd()
  return trimmed.trim().length > 0 && PROMPT_TAIL.test(trimmed)
}
