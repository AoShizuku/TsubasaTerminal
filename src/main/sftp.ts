import { BrowserWindow, dialog, ipcMain } from 'electron'
import { basename } from 'path'
import type {
  SftpEntry,
  SftpHomeResult,
  SftpListResult,
  SftpTransferResult
} from '../shared/types'
import { getSftp } from './ssh'
import { describeSftpError } from './sftpError'

/** 远端是 POSIX 路径，不能用 path.join */
function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** 出口统一走 errno 分流：EACCES 说身份不足，不再误诊成"嵌套够不着" */
function errMsg(err: unknown): string {
  return describeSftpError(err)
}

export function registerSftpHandlers(): void {
  ipcMain.handle('sftp:home', async (_event, sessionId: string): Promise<SftpHomeResult> => {
    try {
      const sftp = await getSftp(sessionId)
      const path = await new Promise<string>((resolve, reject) =>
        sftp.realpath('.', (err, resolved) => (err ? reject(err) : resolve(resolved)))
      )
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: errMsg(err) }
    }
  })

  ipcMain.handle(
    'sftp:list',
    async (_event, sessionId: string, path: string): Promise<SftpListResult> => {
      try {
        const sftp = await getSftp(sessionId)
        const list = await new Promise<
          Array<{ filename: string; attrs: { size?: number; isDirectory(): boolean; isSymbolicLink(): boolean } }>
        >((resolve, reject) =>
          sftp.readdir(path, (err, entries) => (err ? reject(err) : resolve(entries)))
        )
        const entries: SftpEntry[] = list
          .map((item) => ({
            name: item.filename,
            path: joinRemote(path, item.filename),
            type: item.attrs.isDirectory()
              ? ('dir' as const)
              : item.attrs.isSymbolicLink()
                ? ('link' as const)
                : ('file' as const),
            size: item.attrs.size ?? 0
          }))
          .sort(
            (a, b) =>
              (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) ||
              a.name.localeCompare(b.name)
          )
        return { ok: true, entries }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
  )

  ipcMain.handle(
    'sftp:download',
    async (
      event,
      sessionId: string,
      remotePath: string,
      fileName: string
    ): Promise<SftpTransferResult> => {
      try {
        const sftp = await getSftp(sessionId)
        const win = BrowserWindow.fromWebContents(event.sender)
        const result = win
          ? await dialog.showSaveDialog(win, { defaultPath: fileName })
          : await dialog.showSaveDialog({ defaultPath: fileName })
        if (result.canceled || !result.filePath) return { ok: false, canceled: true }
        const filePath = result.filePath
        await new Promise<void>((resolve, reject) =>
          sftp.fastGet(remotePath, filePath, (err) => (err ? reject(err) : resolve()))
        )
        return { ok: true, savedTo: filePath }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
  )

  ipcMain.handle(
    'sftp:upload',
    async (event, sessionId: string, remoteDir: string): Promise<SftpTransferResult> => {
      try {
        const sftp = await getSftp(sessionId)
        const win = BrowserWindow.fromWebContents(event.sender)
        const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
        const result = win
          ? await dialog.showOpenDialog(win, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true }
        const uploaded: string[] = []
        for (const localPath of result.filePaths) {
          const name = basename(localPath)
          await new Promise<void>((resolve, reject) =>
            sftp.fastPut(localPath, joinRemote(remoteDir, name), (err) =>
              err ? reject(err) : resolve()
            )
          )
          uploaded.push(name)
        }
        return { ok: true, uploaded }
      } catch (err) {
        return { ok: false, error: errMsg(err) }
      }
    }
  )
}
