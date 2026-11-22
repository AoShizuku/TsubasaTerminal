<script setup lang="ts">
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  X
} from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import { useAppStore, type SessionElevation } from '@/composables/useAppStore'
import { hasPendingApproval } from '@/composables/useApprovalStore'
import { peekComposerMode } from '@/composables/useComposerStore'
import { isMultiTarget, multiApprovalState } from '@/composables/useMultiApprovalStore'
import { toggleLeftPane, toggleRightPane, useUiStore } from '@/composables/useUiStore'
import { elevationReasonText } from '@/lib/elevation'
import { envStyle } from '@/lib/env'
import { cn } from '@/lib/utils'
import type { SessionStatus } from '@shared/types'

const { sessions, activeSessionId, activateSession, requestCloseSession } = useAppStore()

/**
 * 侧栏折叠把手：**两态都常驻**，不做"折叠后才出现"。
 * TabBar 是唯一横跨中栏的常驻条，两端本来空着；把手常驻等于当前折叠状态一眼可读，
 * 且展开/折叠共用同一个落点——否则"哪里能收起"和"哪里能放回来"就是两处入口。
 * 图标画的是**点下去会发生什么**（展开态给 Close，折叠态给 Open）。
 */
const { leftPaneOpen, rightPaneOpen } = useUiStore()

const statusDot: Record<SessionStatus, string> = {
  connecting: 'bg-warn animate-pulse',
  connected: 'bg-ok',
  closed: 'bg-muted-foreground',
  error: 'bg-danger'
}

/** 身份徽章：成功 = 安静的 root（不加警示色——用户自己勾的）；
 *  降级 = 醒目带原因；握手中 = 弱化省略号 */
function elevationBadge(e: SessionElevation): { label: string; cls: string; title: string } {
  if (e.phase === 'active') {
    return { label: 'root', cls: 'text-muted-foreground', title: '已以 root 运行（登录后自动 sudo -i）' }
  }
  if (e.phase === 'degraded') {
    return {
      label: 'root 未生效',
      cls: 'text-warn',
      title: `以 root 运行未生效，本会话为登录用户身份：${elevationReasonText(e.reason)}`
    }
  }
  return { label: 'root…', cls: 'text-muted-foreground/60', title: '正在切换到 root（sudo -i 握手中）' }
}

/**
 * 多机批次的 tab 指示（9.5）：**只有目标 tab 呼吸，非目标 tab 完全不动**。
 * 浮层说"有一批要批"，tab 呼吸说"打的是这几台"——波及范围可视化，两层信息不重复。
 * 挂起=琥珀脉冲；执行=天蓝脉冲；终态=✓/✗ 短暂停留（浮层关掉即消失）。
 */
const multiState = multiApprovalState()

/**
 * 待审批角标（v0.13.4 扩到 TUI 中的活动 tab）：提案卡只长在 composer 上，
 * 两种"看不见"都要在这里兜住——别的 tab 挂着提案（老规则），以及活动 tab 自己在
 * 全屏 TUI 里、composer 整体让位（裸 tmux / vim 期间提案无声阻塞的止血）。
 * 活动 tab 且审批卡就在眼前时不显示：重复即噪音。
 */
function approvalBadgeTitle(sessionId: string): string | null {
  if (!hasPendingApproval(sessionId)) return null
  if (sessionId !== activeSessionId.value) return '该会话有待你决策的提案'
  if (peekComposerMode(sessionId) === 'tui') {
    return '有提案待决策——审批卡被全屏应用遮住，退出 TUI 后可见'
  }
  return null
}

function multiBadge(sessionId: string): { cls: string; label: string; title: string } | null {
  if (!isMultiTarget(sessionId)) return null
  if (multiState.phase === 'pending') {
    return { cls: 'bg-warn', label: '批量待批', title: '该会话在多机批次的目标里，等待你在批次卡上决策' }
  }
  if (multiState.phase === 'executing') {
    const done = multiState.hostStatus[sessionId]?.done
    return done
      ? finalDot(sessionId)
      : { cls: 'bg-info', label: '批量执行中', title: '多机批次命令正在该会话执行' }
  }
  return finalDot(sessionId)
}

function finalDot(sessionId: string): { cls: string; label: string; title: string } {
  const status = multiState.hostStatus[sessionId]
  const ok = status?.done && status.exitCode === 0
  return ok
    ? { cls: 'bg-ok', label: '批量 ✓', title: '多机批次命令在该会话执行完毕（exit 0）' }
    : { cls: 'bg-danger', label: '批量 ✗', title: '多机批次命令在该会话非零退出或未捕获结果' }
}
</script>

<template>
  <!-- 滚动从外层挪进中间的 tab 区：两个把手要 shrink-0 常驻，
       不能跟着 tab 一起滚走。外层 overflow-hidden 兜住 tab 溢出 -->
  <div
    class="flex h-10 shrink-0 items-end gap-1 overflow-hidden border-b bg-muted/20 px-2 pt-1.5"
  >
    <!-- data-return-home：把手不持键盘焦点，点完回终端（focus-design） -->
    <Btn
      variant="ghost"
      icon-only
      class="mb-0.5"
      :title="leftPaneOpen ? '隐藏主机列表（Ctrl+Shift+B）' : '显示主机列表（Ctrl+Shift+B）'"
      data-testid="toggle-left-pane"
      data-return-home
      @click="toggleLeftPane()"
    >
      <component
        :is="leftPaneOpen ? PanelLeftClose : PanelLeftOpen"
        class="i-16"
      />
    </Btn>

    <div class="flex h-full min-w-0 flex-1 items-end gap-1 overflow-x-auto">
      <div
        v-for="session in sessions"
        :key="session.id"
        role="tab"
        data-testid="session-tab"
        :title="session.error || session.title"
        :class="
          cn(
            'group flex h-8 min-w-0 max-w-48 cursor-pointer items-center gap-2 rounded-t-md border border-b-0 px-3 text-list transition-colors',
            session.id === activeSessionId
              ? 'bg-background text-foreground'
              : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted/60'
          )
        "
        @click="activateSession(session.id)"
      >
        <span :class="cn('size-1.5 shrink-0 rounded-full', statusDot[session.status])" />
        <span class="truncate">{{ session.title }}</span>
        <!-- 待审批（v0.12.1 fix）：提案卡只长在活动 tab 的 composer 上，别的会话有提案
             挂着时外面必须看得见——桌面通知划掉了、系统静音了，这里是唯一的定位入口。
             活动 tab 不显示：卡片就在眼前，重复即噪音。环境色是氛围所以安静，
             待决提案是事件，给脉冲点 + 字样 -->
        <span
          v-if="approvalBadgeTitle(session.id)"
          class="flex shrink-0 items-center gap-1 text-badge text-warn"
          :title="approvalBadgeTitle(session.id)!"
          data-testid="tab-approval-badge"
        >
          <span class="size-1.5 animate-pulse rounded-full bg-warn" />
          待审批
        </span>
        <!-- 多机批次目标呼吸：复用待审批徽章位；活动 tab 也显示（波及范围
             可视化——浮层不长在 tab 上，重复噪音的顾虑不适用）。动画尊重系统减弱设置 -->
        <span
          v-if="multiBadge(session.id)"
          class="flex shrink-0 items-center gap-1 text-badge text-muted-foreground"
          :title="multiBadge(session.id)!.title"
          data-testid="tab-multi-badge"
        >
          <span
            :class="
              cn(
                'size-1.5 rounded-full motion-reduce:animate-none',
                multiBadge(session.id)!.cls,
                multiState.phase !== 'final' ? 'animate-pulse' : ''
              )
            "
          />
          {{ multiBadge(session.id)!.label }}
        </span>
        <!-- 身份徽章：requested 的会话常驻；phase 定形态，降级 title 带原因 -->
        <span
          v-if="session.elevation"
          :class="cn('shrink-0 text-badge', elevationBadge(session.elevation).cls)"
          :title="elevationBadge(session.elevation).title"
          :data-phase="session.elevation.phase"
          data-testid="tab-root-badge"
        >
          {{ elevationBadge(session.elevation).label }}
        </span>
        <!-- 环境标识：色点 + 字样双编码（不整 tab 填色——环境色是氛围不是事件） -->
        <span
          v-if="envStyle(session.host.envLevel)"
          :class="cn('flex shrink-0 items-center gap-1 text-badge', envStyle(session.host.envLevel)!.fg)"
          data-testid="tab-env-badge"
        >
          <span :class="cn('size-1.5 rounded-full', envStyle(session.host.envLevel)!.dot)" />
          {{ envStyle(session.host.envLevel)!.label }}
        </span>
        <button
          class="shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
          title="关闭会话"
          data-testid="close-tab"
          @click.stop="requestCloseSession(session.id)"
        >
          <X class="i-12" />
        </button>
      </div>

      <div v-if="sessions.length === 0" class="pb-1.5 pl-1 text-meta text-muted-foreground">
        未打开任何会话
      </div>
    </div>

    <Btn
      variant="ghost"
      icon-only
      class="mb-0.5"
      :title="
        rightPaneOpen ? '隐藏 Agent / 文件栏（Ctrl+Shift+M）' : '显示 Agent / 文件栏（Ctrl+Shift+M）'
      "
      data-testid="toggle-right-pane"
      data-return-home
      @click="toggleRightPane()"
    >
      <component
        :is="rightPaneOpen ? PanelRightClose : PanelRightOpen"
        class="i-16"
      />
    </Btn>
  </div>
</template>
