import { app, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { HostKeyInfo } from '../shared/types'

function knownHostsFile(): string {
  return join(app.getPath('userData'), 'known_hosts.json')
}

async function readKnown(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(knownHostsFile(), 'utf-8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeKnown(known: Record<string, string>): Promise<void> {
  await fs.writeFile(knownHostsFile(), JSON.stringify(known, null, 2), 'utf-8')
}

function keyOf(host: string, port: number): string {
  return `${host}:${port}`
}

/** TOFU（trust on first use）：首次连接记录指纹并放行，之后不匹配则拒绝 */
export async function checkHostKey(
  host: string,
  port: number,
  fingerprint: string
): Promise<HostKeyInfo> {
  const known = await readKnown()
  const stored = known[keyOf(host, port)]
  if (!stored) {
    known[keyOf(host, port)] = fingerprint
    await writeKnown(known)
    return { status: 'new', fingerprint }
  }
  if (stored === fingerprint) return { status: 'match', fingerprint }
  return { status: 'mismatch', fingerprint, storedFingerprint: stored }
}

export function registerHostKeyHandlers(): void {
  ipcMain.handle('hostkeys:get', async (_event, host: string, port: number) => {
    return (await readKnown())[keyOf(host, port)] ?? null
  })

  ipcMain.handle('hostkeys:forget', async (_event, host: string, port: number) => {
    const known = await readKnown()
    delete known[keyOf(host, port)]
    await writeKnown(known)
  })
}
