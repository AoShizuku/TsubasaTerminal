<script setup lang="ts">
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import ExperienceFields from './ExperienceFields.vue'
import Btn from './ui/Btn.vue'
import Dlg from './ui/Dlg.vue'
import Sel from './ui/Sel.vue'
import {
  closeExperienceEditor,
  experienceEditor,
  saveExperienceEditor
} from '@/composables/useExperienceStore'

/**
 * 经验编辑器（v0.10.3 提炼补录 / v0.13.1 事后编辑，同一个面板）：**模态弹窗**。
 *
 * 前两版分别落右栏与中栏，都返工了。中栏那版看着最有道理——`save_experience`
 * 审批时改经验用的就是中栏，"同一件事必须在同一个位置"——但那条论证**是被审批
 * 语境绑架了**：审批必须在中栏，因为"内容与决策同屏"是硬约束（弹窗盖住 composer
 * 就没法边看边 y/n）；事后编辑一条经验没有这个约束。形态相似 ≠ 语境相同。
 *
 * 硬账：它是**任务**不是面板，跟终端会话的关系弱到只取一个 hostId，却要占中栏
 * 70% 把终端挤成一条缝，还逼出一条让位链（四个占用方各写各的可见性判定、两种
 * 让位语义、不对称守卫）。而"藏起来"那档例外——引进来本是为了保住防盲批体验，
 * 结果它成了唯一打破防盲批不变量的东西（查看器没渲染却记成"已查看"）。
 *
 * 弹窗白拿三件事：尺寸自由（840 宽写 4KB markdown）、天然独占（退出让位链，
 * 三个中栏查看器的判定各删一条）、**模态开着时 TabBar 在它下面，"切 tab 稿子
 * 没了"从存在性上消失**。
 *
 * 关闭的三条路（✕ / ESC / 点遮罩）都经 `open` 的 setter 收进 closeExperienceEditor，
 * 未保存确认因此只写一处；落盘中 busy 挡住 ESC 与遮罩。
 */

const isEdit = computed(() => experienceEditor.mode === 'edit')

const open = computed({
  get: () => experienceEditor.open,
  // 只接管"关"：确认被拒时 store 里的 open 不动，getter 立刻把它读回来
  set: (value) => {
    if (!value) void closeExperienceEditor()
  }
})

const description = computed(() =>
  isEdit.value
    ? `${experienceEditor.id ? `#${experienceEditor.id} · ` : ''}正文改完即时生效，梗概进索引要等下一个对话`
    : '从这段对话里提炼一条可复用的排障经验，改完自己保存'
)
</script>

<template>
  <Dlg
    v-model:open="open"
    :title="isEdit ? '编辑排障经验' : '提炼为排障经验'"
    :description="description"
    :width="840"
    :busy="experienceEditor.saving"
    close-testid="agent-extract-close"
  >
    <!-- 高度给区间而非定高：最小窗口 960×600 下 .dlg 的上界只剩 544px，
         定高会把页脚（作用域 + 保存）裁掉——同 v0.13.0 两个弹窗的教训 -->
    <div
      class="flex h-[58vh] max-h-[520px] min-h-[320px] flex-col gap-2 p-3"
      data-testid="agent-extract-panel"
      :data-mode="experienceEditor.mode"
    >
      <div
        v-if="experienceEditor.loading"
        class="flex flex-1 items-center justify-center gap-2 text-list text-muted-foreground"
      >
        <Loader2 class="i-12 animate-spin" />
        Agent 正在起草…
      </div>
      <template v-else>
        <!-- 记/不记的边界（knowledge-design 4.6）只在起草时给：回头改的人
             已经知道自己在改什么 -->
        <p v-if="!isEdit" class="shrink-0 text-meta leading-relaxed text-muted-foreground">
          只记：非显然的因果（症状 → 真因）、反直觉的坑、时序特性、组织约定。
          不记：通用知识、一次性操作记录、机器配置事实（那是本机知识）、大段命令输出。
          存多了索引噪音会把有用的淹掉。
        </p>
        <ExperienceFields
          v-model:summary="experienceEditor.summary"
          v-model:detail="experienceEditor.detail"
          testid="agent-extract"
        />
        <p
          v-if="experienceEditor.error"
          class="shrink-0 text-meta text-destructive"
          data-testid="agent-extract-error"
        >
          {{ experienceEditor.error }}
        </p>
      </template>
    </div>

    <template #footer>
      <label class="flex shrink-0 items-center gap-1.5 text-list text-muted-foreground">
        作用域
        <Sel
          v-model="experienceEditor.scope"
          data-testid="agent-extract-scope"
          class="wf-120"
        >
          <option value="host">{{ isEdit ? '仅本机' : '仅来源主机' }}</option>
          <option value="global">所有主机</option>
        </Sel>
      </label>
      <span class="min-w-0 flex-1" />
      <Btn
        variant="primary"
        data-testid="agent-extract-save"
        :disabled="experienceEditor.saving || experienceEditor.loading"
        @click="saveExperienceEditor"
      >
        {{ experienceEditor.saving ? '保存中…' : isEdit ? '保存修改' : '保存' }}
      </Btn>
    </template>
  </Dlg>
</template>
