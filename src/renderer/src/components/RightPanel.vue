<script setup lang="ts">
/**
 * v0.13.0：`components/ui/tabs` 那四个 shadcn-vue 复制件删掉了，这里直接用
 * reka-ui 的原语 + 本仓库自己的 `.seg` 外观——那四个文件本来就只是
 * "转发 props + 拼一串 Tailwind"，中间层没有存在的理由。
 * `role="tab"` 由 reka-ui 原生给出，按角色选 tab 的 e2e 一条都不用改。
 */
import { computed, watch } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import AgentPanel from './panels/AgentPanel.vue'
import CliPanel from './panels/CliPanel.vue'
import FilePanel from './panels/FilePanel.vue'
import { useAppStore } from '@/composables/useAppStore'
import { useSettingsStore } from '@/composables/useSettingsStore'
import { retreatFromCliTab, useUiStore } from '@/composables/useUiStore'
import { cliUnread } from '@/composables/useCliStore'

const { rightPanelTab } = useUiStore()
const { settings } = useSettingsStore()
const { activeSessionId } = useAppStore()

/** CLI 栏跟着 CLI 通道总开关走：通道关着就没有外部 agent 能来，栏也不占位 */
const cliEnabled = computed(() => settings.value?.cliBridgeEnabled === true)

/** 新条目到达而用户停在别的栏：标签上亮一个点，不替用户切栏 */
const cliDot = computed(() => rightPanelTab.value !== 'cli' && cliUnread(activeSessionId.value))

// 总开关关掉：当前栏与各标签页记着的 CLI 栏一并退回 Agent
watch(cliEnabled, (on) => {
  if (!on) retreatFromCliTab()
})
</script>

<template>
  <aside class="flex h-full flex-col">
    <TabsRoot v-model="rightPanelTab" class="flex h-full min-h-0 flex-col">
      <!-- data-return-home：tab 触发器不持键盘焦点，点完回终端 -->
      <div class="flex h-11 shrink-0 items-center border-b px-2" data-return-home>
        <TabsList class="seg w-full">
          <TabsTrigger value="agent" class="flex-1">Agent</TabsTrigger>
          <TabsTrigger value="files" class="flex-1">文件</TabsTrigger>
          <TabsTrigger v-if="cliEnabled" value="cli" class="flex-1" data-testid="cli-tab">
            CLI
            <span v-if="cliDot" class="size-1.5 rounded-full bg-info" data-testid="cli-tab-unread" />
          </TabsTrigger>
        </TabsList>
      </div>
      <!-- forceMount：切走不卸载，文件树状态与滚动位置得以保留 -->
      <TabsContent
        value="agent"
        force-mount
        class="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
      >
        <AgentPanel />
      </TabsContent>
      <TabsContent
        value="files"
        force-mount
        class="min-h-0 flex-1 overflow-y-auto data-[state=inactive]:hidden"
        data-return-home
      >
        <FilePanel />
      </TabsContent>
      <TabsContent
        v-if="cliEnabled"
        value="cli"
        force-mount
        class="min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden"
        data-return-home
      >
        <CliPanel />
      </TabsContent>
    </TabsRoot>
  </aside>
</template>
