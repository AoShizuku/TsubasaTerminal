import { defineConfig } from '@playwright/test'

/** 真实 VPS 每夜烟测（v0.9）：真实网络时延不定，超时全面放宽；与功能回归分离 */
export default defineConfig({
  testDir: './e2e/smoke',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: './test-results-smoke'
})
