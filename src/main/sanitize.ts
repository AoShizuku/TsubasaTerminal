/**
 * 转录出口净化：喂给机器消费者（LLM/日志/历史）前剥掉全部终端控制序列
 * 并做 Unicode 归一——ANSI 光标控制可以写出"人眼不可见但转录存在"的文本，
 * 零宽字符/RTL 覆盖可以藏提示注入 payload（security-design 特有攻击面）。
 * 人的屏幕不经过这里。
 */

/** 剥离 ANSI/OSC/DCS 转义序列与除 \n \t 外的 C0 控制字符 */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC：ESC ] … (BEL | ST)
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
      // DCS / SOS / PM / APC：ESC P|X|^|_ … ST
      .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)/g, '')
      // CSI：ESC [ 参数 中间字节 终止字节
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // 其余两字符 ESC 序列
      .replace(/\x1b[@-Z\\-_=><]/g, '')
      // 孤立 ESC、\r 与其余 C0/DEL（保留 \n \t）
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  )
}

/**
 * zsh PROMPT_SP 尾巴：zsh 在 precmd 之前（即 133;D 之前）输出
 * `<PROMPT_EOL_MARK><空格×(列宽-w)>\r<空格×w>\r`（w = 标记可见宽度；缺省标记
 * `%B%S%#%s%b` 即反显的 `%` / root 下 `#`）。屏幕上被 \r 覆盖看不见，但 stripAnsi
 * 只删 \r 不做回车覆盖，每个 zsh 单元末尾就多出 `%` 加一整行空格。
 * 只认这一个尾形：两段空格夹两个 \r 收尾，第二段宽度即标记宽度，向前剥掉同宽的可见
 * 字符及其 SGR。不做通用的 \r 覆盖模拟——不知列宽就算不对折行，`printf foo` 这种
 * 无换行输出的 `foo` 反而会被盖掉。标记之后其他 precmd 钩子补发的 OSC/CSI（如设窗口
 * 标题）原样保留，交给 stripAnsi。
 */
const PROMPT_SP_TAIL =
  /( +)\r( *)\r((?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~])*)$/
const TRAILING_CSI = /\x1b\[[0-?]*[ -/]*[@-~]$/
/** 尾形只在最后一屏行内，限定扫描窗口免得在大输出上跑回溯 */
const PROMPT_SP_WINDOW = 4096
/** 两段空格合计约等于列宽；过短的不认，挡住普通输出偶然以 ` \r \r` 收尾 */
const PROMPT_SP_MIN_WIDTH = 16

export function stripPromptSpTail(raw: string): string {
  const cut = Math.max(0, raw.length - PROMPT_SP_WINDOW)
  const m = PROMPT_SP_TAIL.exec(raw.slice(cut))
  if (!m || m[1].length + m[2].length < PROMPT_SP_MIN_WIDTH) return raw
  let head = raw.slice(0, cut + m.index)
  let width = m[2].length
  for (;;) {
    const csi = TRAILING_CSI.exec(head)
    if (csi) {
      head = head.slice(0, csi.index)
    } else if (width > 0 && head.length > 0) {
      head = head.slice(0, -1)
      width -= 1
    } else {
      break
    }
  }
  return head + m[3]
}

/** 零宽字符、方向覆盖、BOM——提示注入的隐藏文本载体 */
// U+200B-200F 零宽/方向标记、U+2060-2064 不可见连接符、U+202A-202E 方向嵌入、
// U+2066-2069 方向隔离、U+FEFF BOM。动态构造，避免源码嵌入不可见字面量
const cc = (n: number): string => String.fromCharCode(n)
const INVISIBLE = new RegExp(
  `[${cc(0x200b)}-${cc(0x200f)}${cc(0x2060)}-${cc(0x2064)}${cc(0x202a)}-${cc(0x202e)}${cc(0x2066)}-${cc(0x2069)}${cc(0xfeff)}]`,
  'g'
)

export function normalizeUnicode(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '')
}

export function sanitizeForMachine(text: string): string {
  return normalizeUnicode(stripAnsi(text))
}
