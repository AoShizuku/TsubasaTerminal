<script setup lang="ts">
import { ChevronDown, ChevronRight, Download, FileText, Folder, Link2 } from 'lucide-vue-next'
import type { FileNode } from './file-tree'

defineProps<{
  node: FileNode
  depth: number
  onToggle: (node: FileNode) => void
  onDownload: (node: FileNode) => void
}>()
</script>

<template>
  <div>
    <div
      class="group flex h-(--h-tree) cursor-pointer items-center gap-1.5 rounded px-1 text-list hover:bg-accent"
      :style="{ paddingLeft: `${depth * 12 + 4}px` }"
      data-testid="file-node"
      @click="node.entry.type === 'dir' && onToggle(node)"
    >
      <template v-if="node.entry.type === 'dir'">
        <ChevronDown v-if="node.expanded" class="i-12 shrink-0 text-muted-foreground" />
        <ChevronRight v-else class="i-12 shrink-0 text-muted-foreground" />
        <Folder class="i-12 shrink-0 text-info/70" />
      </template>
      <template v-else>
        <span class="w-3 shrink-0" />
        <Link2 v-if="node.entry.type === 'link'" class="i-12 shrink-0 text-muted-foreground" />
        <FileText v-else class="i-12 shrink-0 text-muted-foreground" />
      </template>
      <!-- 文件名是路径的一部分，按数据给等宽（姊妹项目硬规则三） -->
      <span class="min-w-0 flex-1 truncate font-mono text-code">{{ node.entry.name }}</span>
      <Download
        v-if="node.entry.type === 'file'"
        class="i-12 shrink-0 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        title="下载"
        data-testid="file-download"
        @click.stop="onDownload(node)"
      />
    </div>

    <div v-if="node.expanded">
      <div
        v-if="node.loading"
        class="px-1 py-0.5 text-meta text-muted-foreground"
        :style="{ paddingLeft: `${(depth + 1) * 12 + 4}px` }"
      >
        加载中…
      </div>
      <div
        v-else-if="node.error"
        class="px-1 py-0.5 text-meta text-destructive"
        :style="{ paddingLeft: `${(depth + 1) * 12 + 4}px` }"
      >
        {{ node.error }}
      </div>
      <FileTreeNode
        v-for="child in node.children ?? []"
        :key="child.entry.path"
        :node="child"
        :depth="depth + 1"
        :on-toggle="onToggle"
        :on-download="onDownload"
      />
    </div>
  </div>
</template>
