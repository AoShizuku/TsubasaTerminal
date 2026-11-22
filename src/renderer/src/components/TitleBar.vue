<script setup lang="ts">
import { ref, watch } from 'vue'
import { Settings } from 'lucide-vue-next'
// 取源稿 svg 而不是 icon.png：那张 1024² 位图近 1 MB，只为画 16px 会占掉渲染层
// 三分之一的资源体积，缩到 16px 还发糊；svg 不含 <text>，不依赖系统字体。
// 不用姊妹项目的 CSS 渐变方块：那是它还没画图标时的占位，我们已有正式图标。
import appIcon from '../../../../build/icon.svg'
import { TITLE_BAR_HEIGHT } from '@shared/types'
import { openSettings } from '@/composables/useUiStore'
import { useSettingsStore } from '@/composables/useSettingsStore'
import { dialogScrimOpacity, underDialogScrim } from '@/composables/useDialogScrim'
import { deriveShell } from '@shared/shellPalette'
import { themeById } from '@shared/terminalThemes'

const { settings } = useSettingsStore()
const platform = window.api.window.platform
const themeError = ref(false)
let themeRequest = 0

async function syncTheme(): Promise<void> {
  const request = ++themeRequest
  const palette = deriveShell(themeById(settings.value?.terminalTheme).theme)
  try {
    await window.api.window.setTitleBarTheme({
      color: underDialogScrim(palette.subtle),
      symbolColor: underDialogScrim(palette.foreground2),
      // 窗口底色不在 DOM 遮罩下也不在其上（页面未画出时才露出），不预合成
      background: palette.background
    })
    if (request === themeRequest) themeError.value = false
  } catch {
    if (request === themeRequest) themeError.value = true
  }
}

watch(
  [() => settings.value?.terminalTheme, dialogScrimOpacity],
  () => void syncTheme(),
  { immediate: true }
)
</script>

<template>
  <header
    class="app-titlebar"
    data-testid="title-bar"
    :data-platform="platform"
    :style="{ '--h-title': `${TITLE_BAR_HEIGHT}px` }"
  >
    <div class="app-titlebar-content">
      <div class="app-titlebar-brand">
        <img :src="appIcon" alt="" draggable="false" />
        <span>Tsubasa Terminal</span>
      </div>
      <div class="app-titlebar-actions">
        <div v-if="themeError" role="status">
          <button class="app-titlebar-retry" @click="syncTheme">
            标题栏配色未同步，点击重试
          </button>
        </div>
        <button
          class="app-titlebar-settings"
          title="设置"
          aria-label="设置"
          data-testid="open-settings"
          @click="openSettings()"
        >
          <Settings class="i-16" />
        </button>
      </div>
    </div>
  </header>
</template>

<style>
@layer components {
  .app-titlebar {
    height: var(--h-title);
    flex: none;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--bd);
    app-region: drag;
    user-select: none;
  }
  .app-titlebar-content {
    display: flex;
    align-items: center;
    height: 100%;
    margin-left: env(titlebar-area-x, 0px);
    width: env(titlebar-area-width, 100%);
    padding-left: 12px;
  }
  .app-titlebar[data-platform='darwin'] .app-titlebar-content {
    padding-left: 78px;
  }
  .app-titlebar-brand {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: var(--fs-12);
    font-weight: 600;
  }
  .app-titlebar-brand img {
    width: 16px;
    height: 16px;
    flex: none;
  }
  .app-titlebar-actions {
    display: flex;
    align-items: center;
    height: 100%;
    margin-left: auto;
    app-region: no-drag;
  }
  .app-titlebar-settings {
    display: grid;
    place-items: center;
    width: 44px;
    height: 100%;
    color: var(--fg-2);
  }
  .app-titlebar-settings:hover {
    background: var(--bg-active);
  }
  .app-titlebar-settings:focus-visible,
  .app-titlebar-retry:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: -3px;
  }
  .app-titlebar-retry {
    padding: 0 8px;
    font-size: var(--fs-11);
    color: var(--warn);
  }
}
</style>
