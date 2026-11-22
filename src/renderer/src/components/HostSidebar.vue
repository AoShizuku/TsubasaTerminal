<script setup lang="ts">
import { ref, watch } from 'vue'
import { FolderInput, Plus, Server, Trash2 } from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import HostFormDialog from './HostFormDialog.vue'
import HostInfoPanel from './HostInfoPanel.vue'
import ImportSshConfigDialog from './ImportSshConfigDialog.vue'
import { useAppStore } from '@/composables/useAppStore'
import { useUiStore } from '@/composables/useUiStore'
import { confirmDialog } from '@/lib/confirm'
import { cn } from '@/lib/utils'
import type { HostConfig, HostInput } from '@shared/types'

const { hosts, selectedHostId, selectHost, addHost, updateHost, removeHost, openSession } =
  useAppStore()
/** 主机表单是全局唯一的落点，右栏的"去写本机知识"也指向这里 */
const { hostEditRequest } = useUiStore()

/** 由 electron.vite.config.ts 从 package.json 注入——不再手抄一遍字面量 */
const version = __APP_VERSION__

const dialogOpen = ref(false)
const importOpen = ref(false)
const editingHost = ref<HostConfig | null>(null)

function openCreate(): void {
  editingHost.value = null
  dialogOpen.value = true
}

function openEdit(host: HostConfig): void {
  editingHost.value = host
  dialogOpen.value = true
}

/**
 * 删主机（v0.13.1 二次返工起要确认）：此前点垃圾桶图标**直接删、无提示**，
 * 而现在删主机会级联删掉它名下的排障经验（不这么做那些条目就成了注入侧与管理
 * 列表同时筛不到的幽灵）。连带删是不可逆的，条数先查出来写进提示里——
 * 笼统说"相关数据会被删除"等于没说。
 */
async function onRemoveHost(host: HostConfig): Promise<void> {
  const owned = (await window.api.experience.list(host.id)).filter(
    (e) => e.scope === 'host' && e.hostId === host.id
  ).length
  const extra = owned > 0 ? `\n\n该主机的 ${owned} 条排障经验会一并删除，不可恢复。` : ''
  const ok = await confirmDialog({
    title: '删除主机',
    message: `删除主机「${host.name || host.host}」？${extra}`,
    confirmText: '删除',
    danger: true
  })
  if (!ok) return
  await removeHost(host.id)
}

/** 右栏"去写本机知识"的落点：请求消费完就置空，下次点同一台仍能触发 */
watch(hostEditRequest, (hostId) => {
  if (!hostId) return
  const host = hosts.value.find((h) => h.id === hostId)
  if (host) openEdit(host)
  hostEditRequest.value = null
})

async function handleSave(input: HostInput): Promise<void> {
  if (input.id) await updateHost(input)
  else await addHost(input)
}
</script>

<template>
  <aside class="flex h-full flex-col">
    <div class="flex h-11 shrink-0 items-center justify-between border-b px-3">
      <!-- 左栏只有主机列表，不是密集树：比姊妹项目侧栏高一档（v0.14.2 首轮验收） -->
      <span class="text-body font-semibold">主机列表</span>
      <div class="flex items-center gap-0.5">
        <Btn
          variant="ghost"
          icon-only
          title="从 ~/.ssh/config 导入主机"
          data-testid="import-ssh-config"
          @click="importOpen = true"
        >
          <FolderInput class="i-16" />
        </Btn>
        <Btn variant="ghost" icon-only title="新建主机" data-testid="add-host" @click="openCreate">
          <Plus class="i-16" />
        </Btn>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto p-2">
      <div
        v-if="hosts.length === 0"
        class="px-2 py-10 text-center text-list leading-relaxed text-muted-foreground"
      >
        暂无主机<br />点击右上角 <span class="font-semibold">+</span> 添加
      </div>

      <button
        v-for="host in hosts"
        :key="host.id"
        :class="
          cn(
            'group flex w-full items-start gap-2 rounded-md px-2 py-(--py-host) text-left transition-colors',
            host.id === selectedHostId ? 'bg-accent' : 'hover:bg-accent/50'
          )
        "
        title="单击选中，双击连接"
        data-testid="host-item"
        @click="selectHost(host.id)"
        @dblclick="openSession(host)"
      >
        <Server class="mt-0.5 i-16 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-body">{{ host.name || host.host }}</span>
          <span class="block truncate text-list text-muted-foreground">
            {{ host.username }}@{{ host.host }}:{{ host.port }}
          </span>
        </span>
        <Trash2
          class="mt-0.5 i-12 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
          data-testid="delete-host"
          @click.stop="onRemoveHost(host)"
        />
      </button>
    </div>

    <HostInfoPanel @connect="openSession" @edit="openEdit" />

    <div class="shrink-0 border-t p-2 text-center text-meta text-muted-foreground">
      Tsubasa Terminal v{{ version }}
    </div>

    <HostFormDialog v-model:open="dialogOpen" :host="editingHost" @save="handleSave" />
    <ImportSshConfigDialog v-model:open="importOpen" />
  </aside>
</template>
