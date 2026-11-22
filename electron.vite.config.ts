import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { createLogger } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json' with { type: 'json' }

// Vue compiler-dom 内嵌的 HTML 嵌套白名单还停在 select 只认 optgroup/option/hr 的年代，
// 不认识 customizable select 规范里合法的 <button><selectedcontent>（上游 main 分支也没更新），
// Sel.vue 每次编译都告警一条。compileTemplate 把 onWarn 硬设为自己的收集器
// （spread compilerOptions 在它之前），配置层没有口子，只能在 logger 出口滤掉这条已知误报
const rendererLogger = createLogger()
const rawWarn = rendererLogger.warn
rendererLogger.warn = (msg, options) => {
  if (msg.includes('<button> cannot be child of <select>')) return
  rawWarn(msg, options)
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    customLogger: rendererLogger,
    // 版本号只有 package.json 一处事实源（v0.13.0）：此前侧栏底部与设置「关于」
    // 各写一遍字面量，发版时漏改一处就是界面上撒谎
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      // `<selectedcontent>` 是 customizable select 的原生标签，Vue 不认识它，
      // 不放行的话每次渲染 Sel.vue 都报 "Failed to resolve component"
      vue({ template: { compilerOptions: { isCustomElement: (tag) => tag === 'selectedcontent' } } }),
      tailwindcss()
    ]
  }
})
