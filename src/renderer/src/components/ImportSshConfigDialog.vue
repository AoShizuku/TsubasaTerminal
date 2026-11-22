<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check } from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import Dlg from '@/components/ui/Dlg.vue'
import { useAppStore } from '@/composables/useAppStore'
import type { SshConfigEntry } from '@shared/types'

/**
 * ~/.ssh/config 一键导入：主进程只读解析，勾选导入为私钥认证主机。
 * 已存在的（user@host:port 相同）默认不勾并标注，避免重复导入。
 */

const open = defineModel<boolean>('open', { required: true })

const { hosts, addHost } = useAppStore()

const entries = ref<SshConfigEntry[]>([])
const checked = ref<Record<string, boolean>>({})
const error = ref<string | null>(null)
const importing = ref(false)
const importedCount = ref<number | null>(null)

const existingKeys = computed(
  () => new Set(hosts.value.map((h) => `${h.username}@${h.host}:${h.port}`))
)

function entryKey(e: SshConfigEntry): string {
  return `${e.username}@${e.host}:${e.port}`
}

watch(open, async (value) => {
  if (!value) return
  importedCount.value = null
  error.value = null
  importing.value = false
  const result = await window.api.sshconfig.load()
  if (!result.ok) {
    error.value = result.error ?? '读取失败'
    entries.value = []
    return
  }
  entries.value = result.entries ?? []
  checked.value = {}
  for (const e of entries.value) {
    checked.value[e.alias] = !existingKeys.value.has(entryKey(e))
  }
})

const checkedCount = computed(() => entries.value.filter((e) => checked.value[e.alias]).length)

async function doImport(): Promise<void> {
  if (importing.value) return
  importing.value = true
  let count = 0
  for (const e of entries.value) {
    if (!checked.value[e.alias]) continue
    await addHost({
      name: e.alias,
      host: e.host,
      port: e.port,
      username: e.username,
      authType: 'privateKey',
      privateKeyPath: e.identityFile,
      shellIntegration: true
    })
    count += 1
  }
  importing.value = false
  importedCount.value = count
}
</script>

<template>
  <Dlg
    v-model:open="open"
    title="从 ~/.ssh/config 导入"
    description="导入为私钥认证主机；通配符 Host 块会被跳过"
    :width="460"
    :busy="importing"
  >
    <div class="p-3">
      <p v-if="error" class="quiet-txt p-2" style="font-size: var(--fs-11)" data-testid="import-error">
        {{ error }}
      </p>
      <p v-else-if="entries.length === 0" class="quiet-txt p-2" style="font-size: var(--fs-11)">
        未解析到可导入的主机。
      </p>
      <!--
        整行可点。此前是 <label> 包原生 checkbox 拿到的这个效果，换成自绘勾选块后
        label 的隐式关联就没了（reka-ui 的 CheckboxRoot 是 button，也不能嵌在 button 里），
        所以行本身担任 role=checkbox —— 语义与点击面都落在同一个元素上。
      -->
      <button
        v-for="e in entries"
        :key="e.alias"
        type="button"
        role="checkbox"
        :aria-checked="checked[e.alias] === true"
        class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--bg-active)]"
        data-testid="import-entry"
        @click="checked[e.alias] = !checked[e.alias]"
      >
        <span class="cbx mt-0.5" :class="{ on: checked[e.alias] }">
          <Check v-if="checked[e.alias]" :size="12" :stroke-width="2.25" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate" style="font-size: var(--fs-12); font-weight: 500">
            {{ e.alias }}
            <span v-if="existingKeys.has(entryKey(e))" class="quiet-txt">· 已存在</span>
          </span>
          <span
            class="quiet-txt block truncate"
            style="font-size: var(--fs-10); font-family: var(--ff-mono)"
          >
            {{ e.username }}@{{ e.host }}:{{ e.port
            }}{{ e.identityFile ? ` · ${e.identityFile}` : '（默认私钥）' }}
          </span>
        </span>
      </button>
    </div>

    <template #footer>
      <span class="quiet-txt min-w-0 flex-1" style="font-size: var(--fs-11)" data-testid="import-result">
        {{
          importedCount !== null
            ? `已导入 ${importedCount} 台（私钥认证）`
            : entries.length > 0
              ? `已选 ${checkedCount} / ${entries.length} 台`
              : ''
        }}
      </span>
      <Btn
        variant="primary"
        data-testid="import-confirm"
        :disabled="checkedCount === 0 || importing"
        @click="doImport"
      >
        导入
      </Btn>
    </template>
  </Dlg>
</template>
