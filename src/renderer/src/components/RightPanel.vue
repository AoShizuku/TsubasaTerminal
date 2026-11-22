<script setup lang="ts">
/**
 * v0.13.0：`components/ui/tabs` 那四个 shadcn-vue 复制件删掉了，这里直接用
 * reka-ui 的原语 + 本仓库自己的 `.seg` 外观——那四个文件本来就只是
 * "转发 props + 拼一串 Tailwind"，中间层没有存在的理由。
 * `role="tab"` 由 reka-ui 原生给出，按角色选 tab 的 e2e 一条都不用改。
 */
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import AgentPanel from './panels/AgentPanel.vue'
import FilePanel from './panels/FilePanel.vue'
import { useUiStore } from '@/composables/useUiStore'

const { rightPanelTab } = useUiStore()
</script>

<template>
  <aside class="flex h-full flex-col">
    <TabsRoot v-model="rightPanelTab" class="flex h-full min-h-0 flex-col">
      <!-- data-return-home：tab 触发器不持键盘焦点，点完回终端 -->
      <div class="flex h-11 shrink-0 items-center border-b px-2" data-return-home>
        <TabsList class="seg w-full">
          <TabsTrigger value="agent" class="flex-1">Agent</TabsTrigger>
          <TabsTrigger value="files" class="flex-1">文件</TabsTrigger>
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
    </TabsRoot>
  </aside>
</template>
