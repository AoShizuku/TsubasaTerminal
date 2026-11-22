<script setup lang="ts">
import { ref, watch } from 'vue'
import Btn from '@/components/ui/Btn.vue'
import { useAppStore } from '@/composables/useAppStore'
import type { HostConfig } from '@shared/types'

const emit = defineEmits<{
  connect: [host: HostConfig]
  edit: [host: HostConfig]
}>()

const { selectedHost } = useAppStore()
const fingerprint = ref<string | null>(null)

watch(
  selectedHost,
  async (host) => {
    fingerprint.value = host ? await window.api.hosts.getFingerprint(host.host, host.port) : null
  },
  { immediate: true }
)

async function forgetFingerprint(): Promise<void> {
  if (!selectedHost.value) return
  await window.api.hosts.forgetFingerprint(selectedHost.value.host, selectedHost.value.port)
  fingerprint.value = null
}
</script>

<template>
  <div v-if="selectedHost" class="shrink-0 space-y-2 border-t p-3" data-testid="host-info">
    <div class="truncate text-body font-medium">{{ selectedHost.name }}</div>
    <dl class="space-y-1 text-list text-muted-foreground">
      <div class="truncate">地址：{{ selectedHost.host }}:{{ selectedHost.port }}</div>
      <div class="truncate">用户：{{ selectedHost.username }}</div>
      <div>认证：{{ selectedHost.authType === 'password' ? '密码' : '私钥' }}</div>
      <div
        v-if="selectedHost.privateKeyPath"
        class="truncate"
        :title="selectedHost.privateKeyPath"
      >
        私钥：{{ selectedHost.privateKeyPath }}
      </div>
      <div v-if="fingerprint" class="truncate" :title="fingerprint">指纹:{{ fingerprint }}</div>
      <!-- 本机知识：有没有写过必须一眼可见——它每轮都进 Agent 的上下文 -->
      <div class="truncate" data-testid="info-knowledge" :title="selectedHost.knowledge">
        AI 知识：{{
          selectedHost.knowledge ? `已写 ${selectedHost.knowledge.length} 字（编辑里改）` : '未写'
        }}
      </div>
    </dl>
    <div class="flex gap-1.5">
      <Btn
        variant="primary"
        size="sm"
        class="flex-1"
        data-testid="info-connect"
        @click="emit('connect', selectedHost)"
      >
        连接
      </Btn>
      <Btn size="sm" class="flex-1" data-testid="info-edit" @click="emit('edit', selectedHost)">
        编辑
      </Btn>
      <Btn
        v-if="fingerprint"
        size="sm"
        title="删除已记录的主机密钥指纹（主机重装后重连前使用）"
        data-testid="info-forget-key"
        @click="forgetFingerprint"
      >
        重置指纹
      </Btn>
    </div>
  </div>
</template>
