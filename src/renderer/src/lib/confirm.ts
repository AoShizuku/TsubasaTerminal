import { shallowRef } from 'vue'

/**
 * 确认框单点入口。取代 `window.confirm`——原生框与应用的弹窗外观割裂，
 * 且冻住整个渲染线程。调用方在 store / lib 里也要能问（粘贴护栏、经验编辑器的
 * 放弃确认），没有模板可挂组件，所以做成命令式：App 挂唯一一个 ConfirmDlg，
 * 这里只存"当前在问什么"。
 *
 * 从同步变异步后，原生框顺带替我们挡住的事要自己挡：
 * - **同一时刻只问一件事**：第二个请求直接回 false，不排队。确认框开着时底下的
 *   东西点不到，能撞上来的只有快捷键（例如再按一次 Ctrl+V），排队只会让用户
 *   关掉一个又冒出一个。
 * - **等待期间世界会变**：调用方 await 之后须重新校验自己依赖的状态（会话还在不在），
 *   原生框期间 JS 不跑，这件事以前不存在。
 */

export interface ConfirmOptions {
  title: string
  message: string
  /** 需要原样看清的内容（URL、粘贴内容预览）：等宽、完整换行，不截断 */
  detail?: string
  confirmText?: string
  /** null = 只有一个按钮的告知框 */
  cancelText?: string | null
  /** 危险操作：确认按钮标红，默认焦点落在取消上（手滑回车不会误删） */
  danger?: boolean
}

export interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void
}

export const confirmRequest = shallowRef<ConfirmRequest | null>(null)

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  if (confirmRequest.value) return Promise.resolve(false)
  return new Promise((resolve) => {
    confirmRequest.value = { ...options, resolve }
  })
}

/** ✕ / Esc / 点遮罩都按取消兑现；重复兑现是空操作 */
export function settleConfirm(ok: boolean): void {
  const request = confirmRequest.value
  if (!request) return
  confirmRequest.value = null
  request.resolve(ok)
}
