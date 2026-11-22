import { defineComponent, h, type PropType } from 'vue'

import type Btn from '@/components/ui/Btn.vue'
import type Dlg from '@/components/ui/Dlg.vue'
import type Sw from '@/components/ui/Sw.vue'

/**
 * 组件测试共用的控件替身（v0.13.7 收口）。此前 SettingsDialog / HostFormDialog /
 * ExperienceEditor 各手抄一份，三份的 props 形状还互不相同——正是"两处重复即两处
 * 漂移"那个形状。
 *
 * 替身只保留父组件真正依赖的契约：open、具名 slot、v-model。Dlg 的 Teleport /
 * 焦点陷阱 / ESC 归它自己的组件边界（那两条接缝 `data-modal` 与 `close-auto-focus`
 * 由 e2e 守），Sel 的 customizable-select 属浏览器行为，都不在 jsdom 里伪造。
 */

/** 对话框：渲染全部具名 slot，关闭按钮沿用调用方传进来的 testid */
export const DlgStub = defineComponent({
  name: 'Dlg',
  inheritAttrs: false,
  props: {
    open: { type: Boolean, required: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    width: { type: Number, default: 560 },
    busy: { type: Boolean, default: false },
    closeTestid: { type: String, default: 'dlg-close' },
    top: { type: Boolean, default: false }
  },
  emits: ['update:open', 'openAutoFocus'],
  setup(props, { emit, slots }) {
    return () =>
      props.open
        ? h('section', { 'data-testid': 'dlg-stub', 'data-busy': String(props.busy) }, [
            h('h2', props.title),
            h('p', props.description),
            h(
              'button',
              {
                'data-testid': props.closeTestid,
                onClick: () => emit('update:open', false)
              },
              '关闭'
            ),
            h('header', slots.tabs?.()),
            h('main', slots.default?.()),
            h('footer', slots.footer?.())
          ])
        : null
  }
})

/** 下拉框：原生 select 的最小 v-model 契约 */
export const SelStub = defineComponent({
  name: 'Sel',
  inheritAttrs: false,
  props: {
    modelValue: {
      type: [String, Number] as PropType<string | number | undefined>,
      default: undefined
    },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit, slots }) {
    return () =>
      h(
        'select',
        {
          ...attrs,
          value: props.modelValue,
          disabled: props.disabled,
          onChange: (event: Event) =>
            emit('update:modelValue', (event.target as HTMLSelectElement).value)
        },
        slots.default?.()
      )
  }
})

/** 开关：真 Sw 是 reka-ui 的 SwitchRoot，这里退回 checkbox 以便 setValue */
export const SwStub = defineComponent({
  name: 'Sw',
  inheritAttrs: false,
  props: {
    modelValue: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false }
  },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        type: 'checkbox',
        checked: props.modelValue,
        disabled: props.disabled,
        onChange: (event: Event) =>
          emit('update:modelValue', (event.target as HTMLInputElement).checked)
      })
  }
})

/** 按钮：变体只影响 class，测试不看；disabled 与真 Btn 一样走 attrs 透传 */
export const BtnStub = defineComponent({
  name: 'Btn',
  props: {
    variant: {
      type: String as PropType<'default' | 'primary' | 'danger' | 'ghost'>,
      default: 'default'
    },
    size: { type: String as PropType<'md' | 'sm'>, default: 'md' },
    iconOnly: { type: Boolean, default: false },
    active: { type: Boolean, default: false },
    type: { type: String as PropType<'button' | 'submit'>, default: 'button' }
  },
  setup(props, { slots }) {
    return () => h('button', { type: props.type }, slots.default?.())
  }
})

/**
 * 替身与真组件的 props 键集守卫。**替身按旧契约渲染而测试照样绿**，是这类测试最坏
 * 的失效方式：真组件删掉或改名一个 prop，父组件传的值从此掉进 attrs，替身却仍按
 * 自己那份声明工作——两边都不报错。有了这几行，改真组件时这里先红。
 *
 * 比的是键集而不是完整 props 类型：可选属性的增删不破坏结构子类型，双向 `extends`
 * 恰恰抓不到最常见的那种漂移。`*Modifiers` 是 `defineModel` 的编译产物、不是作者写
 * 的契约，故排除。`Sel` 是泛型组件（`generic="T"`），拿不到 `InstanceType`，它的
 * 契约只能靠使用处的类型检查兜——这也是它没列在下面的原因。
 */
type PropsOf<C> = C extends abstract new (...args: never[]) => infer I
  ? I extends { $props: infer P }
    ? P
    : never
  : never
type PropKeys<C> = Exclude<keyof PropsOf<C>, `${string}Modifiers`>
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

export type StubContracts = [
  Expect<Mutual<PropKeys<typeof Dlg>, PropKeys<typeof DlgStub>>>,
  Expect<Mutual<PropKeys<typeof Sw>, PropKeys<typeof SwStub>>>,
  Expect<Mutual<PropKeys<typeof Btn>, PropKeys<typeof BtnStub>>>
]
