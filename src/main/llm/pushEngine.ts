import { createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import type { SFTPWrapper } from 'ssh2'

/**
 * CLI push 上传引擎（cli-bridge-design 11.6 复审定稿）。
 *
 * **弃 fastPut 手写流式循环**——复审的四条要求收敛到这一个决策：
 * - `'wx'` 独占创建 + 16 hex 随机名（预置同名文件/symlink 直接 EEXIST，不跟着写偏）；
 * - sha256 边传边算（审计记的是**实际写进远端临时文件的字节**，不是提案时的预算值）；
 * - 无进度超时（默认 60s 无字节推进即失败，SFTP 通道卡死不无限挂）；
 * - rename 前 stat 验证 size/mode（fastPut 的 fchmod 吞错路径在这里被显式化）。
 *
 * rename 语义（复审阻断修正）：`ext_openssh_rename` 在服务端未宣告扩展时**同步
 * throw**、真实失败走回调错误——公开 API 层即可分辨，不摸 `_extensions` 私有字段。
 * 同步 throw → 降级 backup-rename 三步；回调错误 → 原样终止，目标一根手指不碰。
 *
 * 本文件只做机械搬运，不含闸门/审批/审计——那些在 tools.ts 的 runPush 编排层。
 * 只 import node 内置与 ssh2 类型，无项目依赖（循环依赖守卫友好，可单测）。
 */

/** 单笔 SFTP 请求的分块（ssh2 会再按服务端 maxWriteLen 切）与并发窗口 */
const CHUNK = 32 * 1024
const WINDOW = 32
/** 元数据操作（open/close/stat/rename/unlink）的单次超时：清理路径不许挂死 */
const OP_TIMEOUT_MS = 15_000
/** 无进度超时缺省：60s 无字节推进即失败 */
const DEFAULT_STALL_MS = 60_000

export interface PushOptions {
  sftp: SFTPWrapper
  localPath: string
  /** canonical 目标绝对路径（父目录已 realpath，调用方保证含 '/'） */
  remotePath: string
  /** 提案时的本地 stat 基准：前后对比的撕裂护栏（size 变 / mtime 变都失败） */
  expectedSize: number
  expectedMtimeMs: number
  /** 显式 --mode 或覆盖继承的原 mode；undefined = 跟随远端 umask */
  mode?: number
  onProgress?: (ackedBytes: number) => void
  signal?: AbortSignal
  stallMs?: number
}

export interface PushOutcome {
  /** 实际写进远端临时文件的字节的 sha256 */
  sha256: string
  bytes: number
  /** 服务端未宣告 posix-rename，走了降级路径（直接 rename 或 backup 三步） */
  fallbackRename: boolean
  /** 清不掉的远端残留（.part / .bak）；空 = 干净 */
  leftovers: string[]
}

/** 传输失败：message 面向调用方，leftovers 是清理不掉的远端残留（如实上报，不掩饰） */
export class PushError extends Error {
  leftovers: string[]

  constructor(message: string, leftovers: string[] = []) {
    super(message)
    this.leftovers = leftovers
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}超时（${Math.round(ms / 1000)}s）`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

type SftpCb<T> = (err: Error | null | undefined, value: T) => void

function op<T>(what: string, fn: (cb: SftpCb<T>) => void): Promise<T> {
  return withTimeout(
    new Promise<T>((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value)))),
    OP_TIMEOUT_MS,
    what
  )
}

async function tryOp(fn: (cb: (err?: Error | null) => void) => void): Promise<Error | null> {
  try {
    await op<void>('操作', (cb) => fn(cb as SftpCb<void>))
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

export async function pushFile(opts: PushOptions): Promise<PushOutcome> {
  const { sftp, localPath, remotePath, expectedSize, expectedMtimeMs, mode, onProgress, signal } = opts
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS
  const rand = randomBytes(8).toString('hex')
  const tmpPath = `${remotePath}.tsubasa-${rand}.part`

  let tmpCreated = false
  let renamed = false

  /** 失败清理（best-effort）：清不掉如实上报，断线时 unlink 本就发不出去 */
  const cleanupTmp = async (): Promise<string[]> => {
    if (!tmpCreated || renamed) return []
    return (await tryOp((cb) => sftp.unlink(tmpPath, cb))) ? [tmpPath] : []
  }
  const fail = async (message: string): Promise<never> => {
    throw new PushError(message, await cleanupTmp())
  }

  // 无进度看门狗：写回调、close、stat 都算进度；race 在每个可能长挂的 await 上
  let lastProgress = Date.now()
  let watchdogReject: ((err: Error) => void) | null = null
  const watchdog = new Promise<never>((_, reject) => (watchdogReject = reject))
  watchdog.catch(() => {})
  // 这里抛普通 Error 不抛 PushError：外层 catch 只对普通 Error 补清理，
  // PushError 视作"清理已做完"原样上抛
  const watchdogTimer = setInterval(() => {
    if (signal?.aborted) {
      watchdogReject?.(new Error('调用方已中止传输'))
    } else if (Date.now() - lastProgress > stallMs) {
      watchdogReject?.(new Error(`传输 ${Math.round(stallMs / 1000)}s 无进度，已中止`))
    }
  }, 1000)
  const tick = (): void => {
    lastProgress = Date.now()
  }

  const local = await fs.open(localPath, 'r').catch((err: unknown) => {
    throw new PushError(`本地文件打开失败：${err instanceof Error ? err.message : String(err)}`)
  })

  try {
    const handle = await op<Buffer>('打开远端临时文件', (cb) =>
      sftp.open(tmpPath, 'wx', mode !== undefined ? { mode } : {}, cb)
    ).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new PushError(`创建远端临时文件失败（${tmpPath}）：${message}`)
    })
    tmpCreated = true

    // 逐块流水线：顺序读（hash 依赖读序）、窗口内并发写；任何写失败记下第一个错误
    const hash = createHash('sha256')
    let acked = 0
    let firstError: Error | null = null
    const pending = new Set<Promise<void>>()
    const writeChunk = (buf: Buffer, position: number): Promise<void> =>
      new Promise<void>((resolve, reject) =>
        sftp.write(handle, buf, 0, buf.length, position, (err) => (err ? reject(err) : resolve()))
      ).then(() => {
        acked += buf.length
        tick()
        onProgress?.(acked)
      })

    let offset = 0
    while (offset < expectedSize) {
      if (firstError) break
      const want = Math.min(CHUNK, expectedSize - offset)
      const buf = Buffer.alloc(want)
      const { bytesRead } = await local.read(buf, 0, want, offset)
      if (bytesRead !== want) {
        firstError = new Error('本地文件在传输期间被截短（读到的字节数与 stat 不符）')
        break
      }
      hash.update(buf)
      const p = writeChunk(buf, offset).catch((err: unknown) => {
        if (!firstError) firstError = err instanceof Error ? err : new Error(String(err))
      })
      pending.add(p)
      void p.finally(() => pending.delete(p))
      offset += want
      if (pending.size >= WINDOW) await Promise.race([Promise.race(pending), watchdog])
    }
    if (pending.size) await Promise.race([Promise.all(pending), watchdog])
    if (firstError) return await fail(`上传失败：${firstError.message}`)

    const closeErr = await tryOp((cb) => sftp.close(handle, cb))
    tick()
    if (closeErr) return await fail(`关闭远端临时文件失败：${closeErr.message}`)

    // 撕裂护栏（correctness，不冒充安全机制）：本地文件在传输期间被改就失败重跑
    const after = await fs.stat(localPath).catch(() => null)
    if (!after || after.size !== expectedSize || after.mtimeMs !== expectedMtimeMs) {
      return await fail('本地文件在传输期间被修改（stat 前后不一致），未提交到目标，请重跑')
    }

    // rename 前验证：size 必须相符；mode 被服务端 umask 掩掉就补显式 chmod（吞错显式化）
    const st = await op<{ size: number; mode: number }>('stat 远端临时文件', (cb) =>
      sftp.stat(tmpPath, cb)
    ).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new PushError(`校验远端临时文件失败：${message}`, await cleanupTmp())
    })
    tick()
    if (st.size !== expectedSize) {
      return await fail(`远端临时文件大小不符（期望 ${expectedSize}，实际 ${st.size}）`)
    }
    if (mode !== undefined && (st.mode & 0o7777) !== mode) {
      const chmodErr = await tryOp((cb) => sftp.chmod(tmpPath, mode, cb))
      if (chmodErr) return await fail(`设置权限位失败：${chmodErr.message}`)
    }

    // 原子覆盖：同步 throw = 未宣告扩展（走降级）；回调错误 = 真实失败（不碰目标）
    let fallbackRename = false
    const leftovers: string[] = []
    const extResult = await withTimeout(
      new Promise<'done' | 'unsupported'>((resolve, reject) => {
        try {
          sftp.ext_openssh_rename(tmpPath, remotePath, (err) =>
            err ? reject(err) : resolve('done')
          )
        } catch {
          resolve('unsupported')
        }
      }),
      OP_TIMEOUT_MS,
      '原子覆盖（posix-rename）'
    ).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      throw new PushError(`原子覆盖失败（目标文件未被改动）：${message}`, await cleanupTmp())
    })

    if (extResult === 'unsupported') {
      fallbackRename = true
      // v3 RENAME 目标存在即失败：先试直连（目标不存在的主路径）
      const direct = await tryOp((cb) => sftp.rename(tmpPath, remotePath, cb))
      if (direct) {
        const targetThere = await op<{ size: number }>('stat 目标', (cb) =>
          sftp.stat(remotePath, cb)
        ).then(
          () => true,
          () => false
        )
        if (!targetThere) {
          return await fail(`重命名到目标失败：${direct.message}`)
        }
        // backup-rename 三步（复审阻断修正：不 unlink 健康目标）
        const backupPath = `${remotePath}.tsubasa-${rand}.bak`
        const step1 = await tryOp((cb) => sftp.rename(remotePath, backupPath, cb))
        if (step1) return await fail(`目标备份失败（目标文件未被改动）：${step1.message}`)
        const step2 = await tryOp((cb) => sftp.rename(tmpPath, remotePath, cb))
        if (step2) {
          const restore = await tryOp((cb) => sftp.rename(backupPath, remotePath, cb))
          const rest = await cleanupTmp()
          if (restore) rest.push(backupPath)
          throw new PushError(
            restore
              ? `重命名失败且原文件还原失败：${step2.message}；原文件在 ${backupPath}`
              : `重命名失败（原文件已还原）：${step2.message}`,
            rest
          )
        }
        renamed = true
        if (await tryOp((cb) => sftp.unlink(backupPath, cb))) leftovers.push(backupPath)
      } else {
        renamed = true
      }
    } else {
      renamed = true
    }

    return { sha256: hash.digest('hex'), bytes: expectedSize, fallbackRename, leftovers }
  } catch (err) {
    if (err instanceof PushError) throw err
    const message = err instanceof Error ? err.message : String(err)
    throw new PushError(message, await cleanupTmp())
  } finally {
    clearInterval(watchdogTimer)
    await local.close().catch(() => {})
  }
}
