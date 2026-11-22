import specsRaw from '@/assets/fig-specs.json'

/**
 * L1 语法补全：withfig/autocomplete 提取的精简语料（scripts/extract-specs.mjs 生成，
 * 两层：命令 → 子命令，各带 options；generators 等动态部分由 L2 远端预取负责）。
 */

interface SpecOption {
  names: string[]
  description?: string
}

interface SpecSubcommand {
  names: string[]
  description?: string
  options: SpecOption[]
}

interface CommandSpec {
  description?: string
  options: SpecOption[]
  subcommands: SpecSubcommand[]
}

const specs = specsRaw as unknown as Record<string, CommandSpec>

export interface CompletionCandidate {
  label: string
  description?: string
}

/** 已输入 token（当前词之前）+ 当前词 → spec 层候选 */
export function specCandidates(tokens: string[], word: string): CompletionCandidate[] {
  if (tokens.length === 0) {
    return Object.keys(specs)
      .filter((name) => name.startsWith(word) && name !== word)
      .map((name) => ({ label: name, description: specs[name].description }))
  }
  const spec = specs[tokens[0]]
  if (!spec) return []
  const subToken = tokens.slice(1).find((t) => !t.startsWith('-'))
  const sub = subToken ? spec.subcommands.find((s) => s.names.includes(subToken)) : undefined

  if (word.startsWith('-')) {
    // flag 位：子命令 options 优先，命令级 options 兜底
    const pool = sub ? [...sub.options, ...spec.options] : spec.options
    const seen = new Set<string>()
    const out: CompletionCandidate[] = []
    for (const option of pool) {
      for (const name of option.names) {
        if (name.startsWith(word) && !seen.has(name)) {
          seen.add(name)
          out.push({ label: name, description: option.description })
        }
      }
    }
    return out
  }
  if (!sub) {
    // 子命令位
    return spec.subcommands
      .filter((s) => s.names.some((n) => n.startsWith(word)))
      .map((s) => ({
        label: s.names.find((n) => n.startsWith(word)) ?? s.names[0],
        description: s.description
      }))
  }
  return []
}

/** 当前命令是否有 spec（有则子命令位不再混入文件候选，减少噪音） */
export function hasSpec(command: string): boolean {
  return command in specs
}
