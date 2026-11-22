import { build } from 'esbuild'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

/**
 * CLI 单文件产物（cli-bridge-design 6.1）。
 *
 * 产物跑在 `ELECTRON_RUN_AS_NODE=1` 的 TsubasaTerminal.exe 里（无窗口的纯 Node），
 * 因此目标是 CJS + 当前 Electron 的 Node 版本，外部依赖零——只用 node 内置模块。
 * 打包时由 electron-builder 的 `extraResources` 落 `resources\cli\`（**asar 外**，
 * 不赌 RUN_AS_NODE 模式下的 asar 补丁行为）。
 *
 * 前置约束记死：将来给 electron-builder 配 fuses 做加固时，**`runAsNode` 必须保持
 * 开启**，关了这条 CLI 通道当场就死。
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'))

await build({
  entryPoints: [resolve(root, 'src/cli/index.ts')],
  outfile: resolve(root, 'out/cli/tsubasa-ssh.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  // 版本烘进产物：`--help` / `--version` 不连管道也要能答（应用没开时同样要能用）
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
  banner: {
    js: '// tsubasa-ssh — Tsubasa Terminal CLI 通道（自动生成，请勿手工编辑）'
  }
})

console.log('[build-cli] out/cli/tsubasa-ssh.js')
