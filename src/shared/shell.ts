/**
 * 跨进程共享的 shell 拼接原语。
 *
 * 住在 shared/ 而不是任一侧，是因为三个互不相干的调用点都要它，
 * 且都不该为一个转义函数牵出别的依赖：
 * - 主进程 `ssh.ts` / `elevation.ts`：sudo 与 sftp-server 的命令模板拼装
 * - 主进程 `llm/gate.ts`：`~` 展开与 exec 的 cwd 前缀
 * - 渲染进程 `lib/completion.ts`：compgen 查询拼装
 *
 * v0.12.2 前的整理：此前主进程（gate.ts）与渲染进程（completion.ts）各存一份
 * 同语义实现，gate.ts 的注释里写着"与渲染进程 lib/completion.ts 同语义"
 * ——注释保不住同语义，同一个文件才能。顺带断掉 `ssh.ts`/`elevation.ts`
 * 为了它而反向 import `llm/gate` 的层级倒置（核心 SSH 层不该依赖 AI 层）。
 */

/**
 * POSIX 单引号转义：远端命令拼接的唯一安全形态，value 的内容永不逃出引号。
 * 内嵌单引号按 `'\''`（闭合 → 转义引号 → 重开）拆装。
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
