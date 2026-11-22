<script setup lang="ts">
import { computed } from 'vue'
import {
  ChevronRight,
  Download,
  FileText,
  Folder,
  FolderTree,
  Link2,
  List,
  Magnet,
  RefreshCw,
  Upload
} from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import FileTreeNode from './FileTreeNode.vue'
import type { FileNode } from './file-tree'
import { useAppStore } from '@/composables/useAppStore'
import { useFileStore } from '@/composables/useFileStore'
import { cn } from '@/lib/utils'
import type { SftpEntry } from '@shared/types'

const { activeSession } = useAppStore()
const fileStore = useFileStore()

const state = computed(() => {
  const session = activeSession.value
  if (!session || session.status !== 'connected') return null
  return fileStore.states[session.id] ?? null
})

const sessionId = computed(() => activeSession.value?.id ?? '')

interface Crumb {
  label: string
  path: string
}

const crumbs = computed<Crumb[]>(() => {
  const path = state.value?.viewPath
  if (!path) return []
  const parts = path.split('/').filter(Boolean)
  const result: Crumb[] = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    result.push({ label: part, path: acc })
  }
  return result
})

function onEntryClick(entry: SftpEntry): void {
  if (entry.type === 'dir') fileStore.navigateTo(sessionId.value, entry.path)
}

function onTreeToggle(node: FileNode): void {
  void fileStore.toggleTreeNode(sessionId.value, node)
}

function onTreeDownload(node: FileNode): void {
  void fileStore.download(sessionId.value, node.entry)
}
</script>

<template>
  <div
    v-if="!state"
    class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
  >
    <FolderTree class="i-20 text-muted-foreground/40" />
    <p class="text-list leading-relaxed text-muted-foreground">
      连接主机后，这里会显示当前会话的服务器文件
    </p>
  </div>

  <div v-else class="flex h-full flex-col p-3">
    <!-- 工具条 -->
    <div class="mb-2 flex shrink-0 items-center gap-1">
      <Btn
        variant="ghost"
        icon-only
        size="sm"
        :title="state.view === 'flat' ? '切换到树视图' : '切换到目录视图'"
        data-testid="view-toggle"
        @click="fileStore.setView(sessionId, state.view === 'flat' ? 'tree' : 'flat')"
      >
        <FolderTree v-if="state.view === 'flat'" class="i-16" />
        <List v-else class="i-16" />
      </Btn>
      <Btn
        v-if="state.view === 'flat'"
        variant="ghost"
        icon-only
        size="sm"
        :class="state.follow ? 'text-primary' : 'text-muted-foreground/50'"
        :title="state.follow ? '正在跟随终端目录（点击暂停）' : '已暂停跟随（点击恢复并跳回当前目录）'"
        :data-active="state.follow ? 'on' : 'off'"
        data-testid="follow-toggle"
        @click="fileStore.toggleFollow(sessionId)"
      >
        <Magnet class="i-16" />
      </Btn>
      <span class="min-w-0 flex-1" />
      <Btn
        variant="ghost"
        icon-only
        size="sm"
        title="刷新"
        data-testid="sftp-refresh"
        @click="state.view === 'flat' ? fileStore.refreshFlat(sessionId) : fileStore.loadTreeRoot(sessionId)"
      >
        <RefreshCw class="i-16" />
      </Btn>
      <Btn
        variant="ghost"
        icon-only
        size="sm"
        title="上传文件到当前目录"
        data-testid="sftp-upload"
        @click="fileStore.upload(sessionId)"
      >
        <Upload class="i-16" />
      </Btn>
    </div>

    <!-- 平铺（跟随）视图 -->
    <template v-if="state.view === 'flat'">
      <div
        class="mb-1.5 flex shrink-0 flex-wrap items-center gap-0.5 font-mono text-code text-muted-foreground"
        data-testid="breadcrumb"
      >
        <template v-for="(crumb, index) in crumbs" :key="crumb.path">
          <ChevronRight v-if="index > 1" class="i-12 shrink-0" />
          <button
            class="max-w-32 truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
            :title="crumb.path"
            data-testid="crumb"
            @click="fileStore.navigateTo(sessionId, crumb.path)"
          >
            {{ crumb.label }}
          </button>
        </template>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
        <div v-if="state.entriesLoading && state.entries.length === 0" class="p-2 text-meta text-muted-foreground">
          加载中…
        </div>
        <div v-else-if="state.entriesError" data-testid="file-error" class="p-2 text-meta text-destructive">
          {{ state.entriesError }}
        </div>
        <template v-else>
          <div v-if="state.entries.length === 0" class="p-2 text-meta text-muted-foreground">
            空目录
          </div>
          <div
            v-for="entry in state.entries"
            :key="entry.path"
            :class="
              cn(
                'group flex h-(--h-tree) items-center gap-1.5 rounded px-1 text-list',
                entry.type === 'dir' ? 'cursor-pointer hover:bg-accent' : 'hover:bg-accent/50'
              )
            "
            data-testid="flat-entry"
            @click="onEntryClick(entry)"
          >
            <Folder v-if="entry.type === 'dir'" class="i-12 shrink-0 text-info/70" />
            <Link2 v-else-if="entry.type === 'link'" class="i-12 shrink-0 text-muted-foreground" />
            <FileText v-else class="i-12 shrink-0 text-muted-foreground" />
            <!-- 文件名、路径是数据，给等宽（姊妹项目硬规则三） -->
            <span class="min-w-0 flex-1 truncate font-mono text-code">{{ entry.name }}</span>
            <Download
              v-if="entry.type === 'file'"
              class="i-12 shrink-0 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              title="下载"
              data-testid="file-download"
              @click.stop="fileStore.download(sessionId, entry)"
            />
          </div>
        </template>
      </div>
    </template>

    <!-- 树（浏览）视图 -->
    <template v-else>
      <div class="mb-1.5 shrink-0 truncate font-mono text-code text-muted-foreground" :title="state.home">
        {{ state.home || '…' }}
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/20 p-1.5">
        <div v-if="state.treeLoading && !state.treeLoaded" class="p-2 text-meta text-muted-foreground">
          加载中…
        </div>
        <div v-else-if="state.treeError" class="p-2 text-meta text-destructive">
          {{ state.treeError }}
        </div>
        <template v-else>
          <div v-if="state.tree.length === 0" class="p-2 text-meta text-muted-foreground">空目录</div>
          <FileTreeNode
            v-for="node in state.tree"
            :key="node.entry.path"
            :node="node"
            :depth="0"
            :on-toggle="onTreeToggle"
            :on-download="onTreeDownload"
          />
        </template>
      </div>
    </template>

    <p v-if="state.notice" class="mt-2 shrink-0 break-all text-meta text-muted-foreground">
      {{ state.notice }}
    </p>
  </div>
</template>
