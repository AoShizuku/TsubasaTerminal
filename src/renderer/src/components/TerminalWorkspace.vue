<script setup lang="ts">
import { computed } from 'vue'
import { Terminal } from 'lucide-vue-next'
import TabBar from './TabBar.vue'
import TerminalView from './TerminalView.vue'
import MultiApprovalOverlay from './MultiApprovalOverlay.vue'
import Composer from './Composer.vue'
import WriteFileViewer from './WriteFileViewer.vue'
import ExperienceViewer from './ExperienceViewer.vue'
import ContextViewer from './ContextViewer.vue'
import { useAppStore } from '@/composables/useAppStore'
import { composerState } from '@/composables/useComposerStore'
import { useSettingsStore } from '@/composables/useSettingsStore'
import { envStyle } from '@/lib/env'
import { themeById } from '@shared/terminalThemes'
import { cn } from '@/lib/utils'

const { sessions, activeSessionId, activeSession } = useAppStore()

// 全屏 TUI（vim/htop）时 composer 整体让位，终端拿满高度
const composerVisible = computed(
  () => activeSession.value && composerState(activeSession.value.id).mode !== 'tui'
)

/**
 * 活动会话的环境标识（v0.9 视觉层，v0.9.1 形态返工）：终端区顶缘 2px 光条。
 * 它在终端区上而非 composer 上——TUI 态 composer 让位时它照常在，
 * v0.9 的底栏常驻徽章那条兜底理由随之消失，已删。
 */
const activeEnv = computed(() => envStyle(activeSession.value?.host.envLevel))

/** 终端区背景跟随配色方案（xterm 网格外的留白区域同色，避免描边感） */
const { settings } = useSettingsStore()
const themeBg = computed(
  () => themeById(settings.value?.terminalTheme).theme.background ?? '#0c0d10'
)
</script>

<template>
  <main class="flex h-full flex-col">
    <TabBar />

    <!-- overflow-hidden：侧栏拖拽期间 TerminalView 不 fit，画布保持旧宽；
         中栏收窄时它是 absolute 的、会画到右栏上面（定位元素比后续兄弟的背景晚绘），
         得在这一层裁掉。右键菜单是 fixed，不受影响 -->
    <div
      class="relative min-h-0 flex-1 overflow-hidden"
      :style="{ backgroundColor: themeBg }"
      data-testid="terminal-area"
    >
      <!-- 生产机顶缘 2px 光条：absolute + pointer-events-none 不进布局，
           更不碰 term.open 的目标元素（FitAddon 按 border-box 高度算行数）。
           它落在 tab 条 border-b 的位置上——是替代那条线，不是并排画第二条 -->
      <div
        v-if="activeEnv?.rail"
        :class="cn('pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5', activeEnv.rail)"
        data-testid="env-rail"
      />
      <TerminalView
        v-for="session in sessions"
        v-show="session.id === activeSessionId"
        :key="session.id"
        :session="session"
        :active="session.id === activeSessionId"
        class="absolute inset-0"
      />
      <!-- 多机批次浮层：浮在终端区顶部、全 tab 可见（跨会话单例）。
           absolute 挂在包裹 div 上，绝不碰 term.open 的目标元素——FitAddon 按
           border-box 算行数，动它就是网格溢出、TUI 底行被裁的老坑 -->
      <MultiApprovalOverlay />
      <div
        v-if="sessions.length === 0"
        class="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground"
      >
        <Terminal class="i-20 opacity-40" />
        <p class="text-body">点击左侧主机开始 SSH 会话</p>
      </div>
    </div>

    <!-- 中栏底部这个位置是**独占**的，占用方只剩两档（v0.13.1 二次返工）：
         提案查看器 > 上下文原文，TUI 时全让。经验编辑器已改为模态弹窗、退出此链 -->

    <!-- write_file 只读查看器：中栏占位（终端 refit 让位），不覆盖终端输出 -->
    <WriteFileViewer v-if="activeSession" :session-id="activeSession.id" />

    <!-- save_experience 可编辑查看器：同一个只读位——审批串行，
         同一时刻至多一个提案，与 write_file 查看器天然互斥 -->
    <ExperienceViewer v-if="activeSession" :session-id="activeSession.id" />

    <!-- 上下文原文查看器：同一个位置、同一套语义（右栏只放"多大、谁写的"） -->
    <ContextViewer v-if="activeSession" :session-id="activeSession.id" />

    <!-- 钉底 composer：本地组稿、整行发送（composer-design Phase 1）。
         TUI 隐藏用 class 而非 v-show：v-show 的 display 更新是 post-render effect，
         会晚于 composer 的 post watcher 落焦导致 focus() 静默失败 -->
    <Composer
      v-if="activeSession"
      :session-id="activeSession.id"
      :class="{ hidden: !composerVisible }"
    />
  </main>
</template>
