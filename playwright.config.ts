import { defineConfig } from '@playwright/test'

const requestedWorkers = Number(process.env.TSUBASATERMINAL_E2E_WORKERS)
const workers = Number.isInteger(requestedWorkers) && requestedWorkers > 0 ? requestedWorkers : 2

export default defineConfig({
  testDir: './e2e',
  // 真实 VPS 烟测与功能回归分离：走 playwright.smoke.config.ts（npm run test:smoke）
  testIgnore: '**/smoke/**',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // 按文件并行、文件内串行：每个 Electron 实例有独立 userData（TSUBASATERMINAL_USER_DATA）
  // 与独立随机端口的 fake server，互不可见
  fullyParallel: false,
  // 直接调用 playwright 时默认 2 workers；npm 的 e2e 脚本另由 run-e2e.mjs 编排：
  // 日常两车道都用 2，全量才让后台渲染车道用 5；可见窗口始终不超过 2 个。
  workers,
  reporter: [['list']],
  outputDir: './test-results'
})
