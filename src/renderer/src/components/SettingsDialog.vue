<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  AlertTriangle,
  Bot,
  BookText,
  Info,
  Palette,
  Pencil,
  Plus,
  Shield,
  TerminalSquare,
  Trash2
} from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import Dlg from '@/components/ui/Dlg.vue'
import Sel from '@/components/ui/Sel.vue'
import Sw from '@/components/ui/Sw.vue'
import { loadLlmProfiles } from '@/composables/useAgentStore'
import { loadSettings, updateSettings, useSettingsStore } from '@/composables/useSettingsStore'
import { useUiStore, type SettingsSection } from '@/composables/useUiStore'
import { detectMonospaceFonts } from '@/lib/localFonts'
import { TERMINAL_THEMES } from '@shared/terminalThemes'
import {
  KNOWLEDGE_LIMIT,
  type CliInstallStatus,
  type CliSkillStatus,
  type CliSkillTarget,
  type LlmProfile,
  type LlmProfileInput,
  type ThinkingLevel,
  type UiDensity,
  type UiFontSize
} from '@shared/types'

const open = defineModel<boolean>('open', { required: true })

// 设置走共享 store：这里改，TerminalView watch 即时应用外观
const { settings } = useSettingsStore()
const profiles = ref<LlmProfile[]>([])

/** 本机已安装的等宽字体；null = 还在探测 */
const availableFonts = ref<string[] | null>(null)

/**
 * 字体下拉选项。已保存的字体探测不到时仍列出（下拉框不能拿着无对应选项的值），
 * 但标明未安装——xterm 此时实际用的是回退栈，不能让设置页看起来像已生效。
 */
const fontOptions = computed(() => {
  const detected = availableFonts.value ?? []
  const current = settings.value?.terminalFontFamily ?? ''
  const options = detected.map((f) => ({ value: f, label: f }))
  if (current && !detected.includes(current)) {
    const label = availableFonts.value === null ? current : `${current}（未安装）`
    options.unshift({ value: current, label })
  }
  return options
})

/** 内联 profile 表单：false=收起，form.id 为空=新建 */
const editing = ref<boolean>(false)
const form = reactive<LlmProfileInput>({ name: '', provider: 'anthropic', model: '' })

/** CLI 通道安装态（每次打开弹窗现探：shim / PATH / skill 都可能被外部改过） */
const cli = ref<CliInstallStatus | null>(null)
const cliBusy = ref(false)

/** 全局知识草稿（失焦/关窗落盘） */
const globalKnowledge = ref('')
const globalKnowledgeEl = ref<HTMLTextAreaElement | null>(null)

/**
 * 分节：状态住在 useUiStore，因为外部入口（右栏"去写全局知识"）
 * 要在打开之前就把落点定好。
 */
const { settingsSection, settingsFocus } = useUiStore()

const SECTIONS: { key: SettingsSection; label: string; icon: unknown }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'knowledge', label: '知识', icon: BookText },
  { key: 'models', label: '模型服务', icon: Bot },
  { key: 'security', label: '安全与审计', icon: Shield },
  { key: 'cli', label: '命令行工具', icon: TerminalSquare },
  { key: 'about', label: '关于', icon: Info }
]

const version = __APP_VERSION__

/**
 * 「关于」里的主要第三方组件。许可标识**照抄各自 manifest 里声明的**，
 * 别凭印象写——lucide 与 withfig 语料是 ISC 不是 MIT，openai 是 Apache-2.0。
 * 这只是"用户想知道的那几个"；完整清单与许可证全文由 scripts/gen-notices.mjs
 * 生成，随安装包落在 resources/。
 */
const CREDITS = [
  { name: 'Vue', license: 'MIT' },
  { name: 'Electron', license: 'MIT' },
  { name: 'xterm.js', license: 'MIT' },
  { name: 'ssh2', license: 'MIT' },
  { name: 'reka-ui', license: 'MIT' },
  { name: 'Lucide', license: 'ISC' },
  { name: 'trzsz', license: 'MIT' },
  { name: 'openai', license: 'Apache-2.0' },
  { name: '@withfig/autocomplete 语料', license: 'ISC' }
]

watch(open, async (value) => {
  if (!value) {
    // 点遮罩 / ESC / × 都会走到这里；textarea 未必拿得到 blur，补一次落盘
    await saveGlobalKnowledge()
    settingsFocus.value = null
    return
  }
  // 每次打开现探，装完字体不用重启应用
  const fonts = detectMonospaceFonts().catch(() => [])
  const loaded = await loadSettings()
  globalKnowledge.value = loaded.globalKnowledge ?? ''
  profiles.value = await window.api.llm.profiles()
  editing.value = false
  availableFonts.value = await fonts
  cli.value = await window.api.cli.status()
  if (settingsFocus.value === 'global-knowledge') {
    await nextTick()
    globalKnowledgeEl.value?.focus()
  }
})

/** 变更即保存，即时生效（脱敏闸门在主进程按单元查询开关） */
async function toggleRedaction(): Promise<void> {
  if (!settings.value) return
  await updateSettings({ redactionEnabled: !settings.value.redactionEnabled })
}

async function toggleCompletionLlm(): Promise<void> {
  if (!settings.value) return
  await updateSettings({ completionLlmEnabled: !settings.value.completionLlmEnabled })
}

async function setTheme(value: string | undefined): Promise<void> {
  await updateSettings({ terminalTheme: value ?? '' })
}

/** 密度三档，文案同姊妹项目 */
const DENSITY_OPTIONS: ReadonlyArray<{ value: UiDensity; label: string }> = [
  { value: 'compact', label: '紧凑' },
  { value: 'standard', label: '标准' },
  { value: 'cozy', label: '宽松' }
]

async function setDensity(value: UiDensity): Promise<void> {
  await updateSettings({ uiDensity: value })
}

/** 界面字号三档：整张字号表平移 0 / 1 / 2px */
const UI_FONT_SIZE_OPTIONS: ReadonlyArray<{ value: UiFontSize; label: string }> = [
  { value: 'standard', label: '标准' },
  { value: 'large', label: '大' },
  { value: 'larger', label: '特大' }
]

async function setUiFontSize(value: UiFontSize): Promise<void> {
  await updateSettings({ uiFontSize: value })
}

async function setFont(value: string | undefined): Promise<void> {
  await updateSettings({ terminalFontFamily: value ?? '' })
}

async function setFontSize(ev: Event): Promise<void> {
  const size = Number((ev.target as HTMLInputElement).value)
  if (Number.isFinite(size)) await updateSettings({ terminalFontSize: size })
}

async function toggleCopyOnSelect(): Promise<void> {
  if (!settings.value) return
  await updateSettings({ terminalCopyOnSelect: !settings.value.terminalCopyOnSelect })
}

async function toggleConfirmMultilinePaste(): Promise<void> {
  if (!settings.value) return
  await updateSettings({
    terminalConfirmMultilinePaste: !settings.value.terminalConfirmMultilinePaste
  })
}

async function toggleConfirmCloseBusy(): Promise<void> {
  if (!settings.value) return
  await updateSettings({ terminalConfirmCloseBusy: !settings.value.terminalConfirmCloseBusy })
}

/** 输入方式：全局偏好即时下发；正在编辑的现场由 composer store 按
 *  pending 规则安全切换（草稿非空/终端行非空时等待，不静默丢字） */
async function setInputMode(value: string | undefined): Promise<void> {
  if (value !== 'composer' && value !== 'native') return
  await updateSettings({ terminalInputMode: value })
}

/**
 * 全局知识：本地草稿 + 失焦/关窗即存。逐字保存会把每次击键都写一次盘，
 * 而这块内容"下一个对话才生效"，本来就不需要实时。
 */
async function saveGlobalKnowledge(): Promise<void> {
  if (!settings.value || settings.value.globalKnowledge === globalKnowledge.value) return
  await updateSettings({ globalKnowledge: globalKnowledge.value })
}

function revealAudit(): void {
  window.api.audit.reveal()
}

/**
 * CLI 通道三个开关。总开关连带起停命名管道、写/删 shim 三件套、
 * 注册/摘除 HKCU PATH，全部在主进程做——都可能慢（PowerShell 起一次约一秒），
 * 期间禁用交互并回填主进程返回的真实状态，不做乐观更新。
 */
async function toggleCliBridge(): Promise<void> {
  if (!cli.value || cliBusy.value) return
  cliBusy.value = true
  try {
    cli.value = await window.api.cli.setBridge(!cli.value.enabled)
  } finally {
    cliBusy.value = false
  }
}

async function toggleCliSkill(target: CliSkillTarget): Promise<void> {
  if (!settings.value || cliBusy.value) return
  const on = target === 'claude' ? settings.value.cliSkillClaude : settings.value.cliSkillCodex
  cliBusy.value = true
  try {
    cli.value = await window.api.cli.setSkill(target, !on)
    // skill 开关也落在 settings.json 里，勾选态的事实源仍是它
    await loadSettings()
  } finally {
    cliBusy.value = false
  }
}

function skillLabel(target: CliSkillTarget): string {
  return target === 'claude' ? 'Claude Code skill' : 'Codex skill'
}

function skillOn(target: CliSkillTarget): boolean {
  return target === 'claude'
    ? settings.value?.cliSkillClaude === true
    : settings.value?.cliSkillCodex === true
}

/** 状态文案：装没装、版本、以及"被手工改过"这一档必须说出来 */
function skillHint(s: CliSkillStatus): string {
  if (s.state === 'modified') return '已被手工修改 · 不覆盖'
  if (s.state === 'installed') return `已安装 v${s.installedVersion}`
  if (s.state === 'outdated') return `v${s.installedVersion} · 下次启动更新`
  return s.hostPresent
    ? `检测到 ${s.target === 'claude' ? '~/.claude' : '~/.codex'}，未安装`
    : `未检测到 ${s.target === 'claude' ? '~/.claude' : '~/.codex'}`
}

/** CLI 总开关右侧那枚状态徽标：未启用/异常/就绪三档，颜色跟着分 */
const cliState = computed<{ text: string; cls: string }>(() => {
  if (!settings.value?.cliBridgeEnabled) return { text: '未启用', cls: 'tag' }
  const c = cli.value
  if (c && !c.listening) return { text: '管道未监听 · 可能已有另一实例', cls: 'tag tag-danger' }
  if (c && !c.cliScriptExists) return { text: '缺 CLI 产物 · 先跑 build:cli', cls: 'tag tag-danger' }
  if (c && c.pathManaged && !c.onPath) return { text: '已安装 · PATH 未生效', cls: 'tag tag-warn' }
  return { text: '已安装 · 重开终端后可用', cls: 'tag tag-ok' }
})

function startCreate(): void {
  Object.assign(form, {
    id: undefined,
    name: '',
    provider: 'anthropic',
    wireFormat: undefined,
    baseURL: '',
    model: '',
    thinking: 'inherit',
    contextWindow: undefined,
    apiKey: ''
  })
  editing.value = true
}

function startEdit(p: LlmProfile): void {
  Object.assign(form, {
    id: p.id,
    name: p.name,
    provider: p.provider,
    wireFormat: p.wireFormat,
    baseURL: p.baseURL ?? '',
    model: p.model,
    thinking: p.thinking ?? 'inherit',
    contextWindow: p.contextWindow,
    apiKey: ''
  })
  editing.value = true
}

async function saveProfile(): Promise<void> {
  if (!form.name.trim() || !form.model.trim()) return
  // 响应式对象跨 IPC 先转纯对象
  profiles.value = await window.api.llm.saveProfile(JSON.parse(JSON.stringify(form)))
  editing.value = false
  // 首个 profile 自动设为活动
  if (settings.value && !settings.value.activeLlmProfileId && profiles.value.length > 0) {
    await updateSettings({ activeLlmProfileId: profiles.value[0].id })
  }
  // 同步 Agent 面板的下拉列表
  await loadLlmProfiles()
}

async function deleteProfile(id: string): Promise<void> {
  profiles.value = await window.api.llm.deleteProfile(id)
  if (settings.value?.activeLlmProfileId === id) {
    await updateSettings({ activeLlmProfileId: profiles.value[0]?.id ?? null })
  }
  await loadLlmProfiles()
}

/**
 * 思考档位：两边上游都已从数字预算转为档位，故这里也是档位下拉。
 * xhigh/max 并非所有模型都支持（Anthropic 4.6 系无 xhigh，OpenAI 按模型给子集），
 * 选错由上游 400 兜底——BYOK 下 model 是自填字符串，本地无从查表校验。
 */
const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'inherit', label: '跟随模型默认' },
  { value: 'none', label: '关闭' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' }
]
</script>

<template>
  <Dlg v-model:open="open" title="设置" :width="840" close-testid="settings-close">
    <div v-if="settings" class="dlg-split set-split">
      <nav class="set-nav">
        <button
          v-for="item in SECTIONS"
          :key="item.key"
          class="set-nav-item"
          :class="{ 'is-active': settingsSection === item.key }"
          :data-testid="`settings-nav-${item.key}`"
          @click="settingsSection = item.key"
        >
          <component :is="item.icon" class="i-16" />
          {{ item.label }}
        </button>
      </nav>

      <div class="set-body">
        <!-- ── 外观 ── -->
        <template v-if="settingsSection === 'appearance'">
          <h3>外观</h3>
          <p class="lead">终端网格与界面外壳共用一套配色。</p>

          <div class="set-group">
            <div class="cap">界面</div>
            <div class="srow">
              <div class="srow-txt">
                <b>行高密度</b>
                <p>影响主机列表、文件列表的行高与控件高度，不改字号。</p>
              </div>
              <div class="srow-ctl">
                <div class="seg" role="radiogroup" aria-label="行高密度" data-testid="settings-density">
                  <button
                    v-for="d in DENSITY_OPTIONS"
                    :key="d.value"
                    type="button"
                    role="radio"
                    :aria-checked="settings.uiDensity === d.value"
                    :class="{ 'is-active': settings.uiDensity === d.value }"
                    :data-testid="`settings-density-${d.value}`"
                    @click="setDensity(d.value)"
                  >
                    {{ d.label }}
                  </button>
                </div>
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt">
                <b>界面字号</b>
                <p>左右栏、标签页与弹窗的文字整体放大；终端字号在下方单独设置。</p>
              </div>
              <div class="srow-ctl">
                <div class="seg" role="radiogroup" aria-label="界面字号" data-testid="settings-ui-font-size">
                  <button
                    v-for="f in UI_FONT_SIZE_OPTIONS"
                    :key="f.value"
                    type="button"
                    role="radio"
                    :aria-checked="settings.uiFontSize === f.value"
                    :class="{ 'is-active': settings.uiFontSize === f.value }"
                    :data-testid="`settings-ui-font-size-${f.value}`"
                    @click="setUiFontSize(f.value)"
                  >
                    {{ f.label }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="set-group">
            <div class="cap">终端</div>
            <div class="srow">
              <div class="srow-txt">
                <b>配色方案</b>
                <p>整个界面的底色、线条与文字都从它派生；选浅色方案即为亮色界面。</p>
              </div>
              <div class="srow-ctl">
                <Sel
                  :model-value="settings.terminalTheme"
                  data-testid="settings-theme"
                  class="wf-160"
                  @update:model-value="setTheme"
                >
                  <option v-for="t in TERMINAL_THEMES" :key="t.id" :value="t.id">
                    {{ t.name }}
                  </option>
                </Sel>
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt"><b>字号</b></div>
              <div class="srow-ctl">
                <input
                  type="number"
                  min="8"
                  max="32"
                  :value="settings.terminalFontSize"
                  data-testid="settings-font-size"
                  class="input wf-88 num"
                  @change="setFontSize"
                />
                <span class="quiet-txt" style="font-size: var(--fs-11)">px</span>
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt">
                <b>字体</b>
                <p>只列出本机已安装的等宽字体。</p>
              </div>
              <div class="srow-ctl">
                <Sel
                  :model-value="settings.terminalFontFamily"
                  data-testid="settings-font"
                  class="wf-160"
                  @update:model-value="setFont"
                >
                  <option value="">默认（含 CJK 回退）</option>
                  <option v-for="f in fontOptions" :key="f.value" :value="f.value">
                    {{ f.label }}
                  </option>
                </Sel>
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt">
                <b>输入方式</b>
                <p>
                  固定输入栏：本地组稿零延迟、中文输入法稳、带补全与 ghost 建议，Enter 才发送。
                  原生终端：按键直达远端 shell，命令行编辑、历史（↑/Ctrl+R）、Tab
                  补全全部用你远端自己的配置（readline/zle/fish）。审批台两种方式下都在。
                  这里是默认值，单台主机可在「编辑主机 → 会话」里另行指定。
                </p>
              </div>
              <div class="srow-ctl">
                <Sel
                  :model-value="settings.terminalInputMode"
                  data-testid="settings-input-mode"
                  class="wf-160"
                  @update:model-value="setInputMode"
                >
                  <option value="composer">固定输入栏（默认）</option>
                  <option value="native">原生终端直通</option>
                </Sel>
              </div>
            </div>
            <div class="banner banner-info" style="margin-top: 10px">
              <Info class="i-16" />
              <span>
                Nerd Font（如 CaskaydiaCove NF）能显示 powerline 与图标字形；
                中文对齐推荐 Sarasa Mono SC（汉字严格 2:1）。默认回退栈已内置 CJK 等宽兜底。
              </span>
            </div>
          </div>

          <div class="set-group">
            <div class="cap">复制与粘贴</div>
            <div class="srow">
              <div class="srow-txt">
                <b>终端选中即复制</b>
                <p>
                  鼠标选完立即进系统剪贴板（PuTTY 传统）——终端里的 Ctrl+C
                  是中断信号，本就不该兼任复制。关掉后用 Ctrl+Shift+C。
                </p>
              </div>
              <div class="srow-ctl">
                <Sw
                  :model-value="settings.terminalCopyOnSelect"
                  data-testid="settings-copy-on-select"
                  @update:model-value="toggleCopyOnSelect"
                />
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt">
                <b>多行粘贴前确认</b>
                <p>
                  直接粘进终端的多行内容先问一次。远端已开启 bracketed paste
                  （bash 5.1+、zsh 默认）时整块进输入行、回车才执行，不会弹；
                  关掉后老 shell、网络设备上每个换行都会立即执行。
                </p>
              </div>
              <div class="srow-ctl">
                <Sw
                  :model-value="settings.terminalConfirmMultilinePaste"
                  data-testid="settings-confirm-multiline-paste"
                  @update:model-value="toggleConfirmMultilinePaste"
                />
              </div>
            </div>
            <div class="banner banner-warn" style="margin-top: 10px">
              <AlertTriangle class="i-16" />
              <span>
                <b>终端屏幕从不脱敏。</b>开着「选中即复制」时，划过一段带明文凭据的输出
                就等于把它送进了系统剪贴板。
              </span>
            </div>
          </div>

          <div class="set-group">
            <div class="cap">会话</div>
            <div class="srow">
              <div class="srow-txt">
                <b>关闭忙碌会话前确认</b>
                <p>
                  命令运行中或全屏应用（vim、htop 等）中点关闭先问一次——关闭会断开 SSH，
                  远端前台进程通常随之终止。未启用 shell integration 的会话判断不了忙闲，不会弹。
                </p>
              </div>
              <div class="srow-ctl">
                <Sw
                  :model-value="settings.terminalConfirmCloseBusy"
                  data-testid="settings-confirm-close-busy"
                  @update:model-value="toggleConfirmCloseBusy"
                />
              </div>
            </div>
          </div>
        </template>

        <!-- ── 知识 ── -->
        <template v-else-if="settingsSection === 'knowledge'">
          <h3>全局知识</h3>
          <p class="lead">所有主机通用的人写事实，直插 Agent 的 system prompt 最前。</p>

          <div class="set-group">
            <div class="cap">
              <span>内容</span>
              <span class="ml-auto num quiet-txt" data-testid="settings-knowledge-count">
                {{ globalKnowledge.length }}/{{ KNOWLEDGE_LIMIT }}
              </span>
            </div>
            <textarea
              ref="globalKnowledgeEl"
              v-model="globalKnowledge"
              rows="12"
              :maxlength="KNOWLEDGE_LIMIT"
              data-testid="settings-global-knowledge"
              placeholder="我们公司的日志都在 /data/logs&#10;“支付网关” 指的是 pay-gw 服务"
              class="input mt-1.5"
              style="font-size: var(--fs-12)"
              @blur="saveGlobalKnowledge"
            />
            <div class="banner banner-info" style="margin-top: 10px">
              <Info class="i-16" />
              <span>
                Agent 每轮可见但改不了它——写进知识层的注入是永久后门，这条通道只对人开放。
                单机专属的内容写在主机的「本机知识」里。保存后<b>下一个对话才生效</b>。
              </span>
            </div>
          </div>
        </template>

        <!-- ── 模型服务 ── -->
        <template v-else-if="settingsSection === 'models'">
          <h3>模型服务</h3>
          <p class="lead">BYOK。API key 加密存在本机，渲染进程只见「是否已配」。</p>

          <div class="set-group">
            <div class="cap">
              <span>已配置（{{ profiles.length }}）</span>
              <Btn
                v-if="!editing"
                variant="ghost"
                size="sm"
                icon-only
                class="ml-auto"
                title="添加 profile"
                data-testid="llm-add-profile"
                @click="startCreate"
              >
                <Plus class="i-12" />
              </Btn>
            </div>

            <p
              v-if="profiles.length === 0 && !editing"
              class="quiet-txt mt-2"
              style="font-size: var(--fs-11)"
            >
              尚未配置。添加 Anthropic 或 OpenAI 兼容端点的 API key 后，Agent 页即可使用。
            </p>

            <template v-if="!editing">
              <div v-for="p in profiles" :key="p.id" class="srow" data-testid="llm-profile-item">
                <div class="srow-txt">
                  <b>{{ p.name }}</b>
                  <p>
                    {{ p.provider === 'anthropic' ? 'Anthropic' : `OpenAI 兼容 · ${p.wireFormat ?? 'chat.completions'}` }}
                    · <code>{{ p.model }}</code>
                  </p>
                </div>
                <div class="srow-ctl">
                  <span v-if="!p.hasKey" class="tag tag-warn">缺少 key</span>
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon-only
                    title="编辑"
                    data-testid="llm-edit-profile"
                    @click="startEdit(p)"
                  >
                    <Pencil class="i-12" />
                  </Btn>
                  <Btn
                    variant="ghost"
                    size="sm"
                    icon-only
                    title="删除"
                    data-testid="llm-delete-profile"
                    @click="deleteProfile(p.id)"
                  >
                    <Trash2 class="i-12" />
                  </Btn>
                </div>
              </div>
            </template>

            <div
              v-else
              class="mt-2 rounded-md border p-3"
              style="border-color: var(--bd); background: var(--bg-subtle)"
              data-testid="llm-profile-form"
            >
              <div class="field">
                <label>名称</label>
                <div class="field-ctl">
                  <input
                    v-model="form.name"
                    class="input"
                    placeholder="如 Claude 官方"
                    data-testid="llm-form-name"
                  />
                </div>
              </div>
              <div class="field">
                <label>类型</label>
                <div class="field-ctl">
                  <Sel v-model="form.provider" class="wf-160" data-testid="llm-form-provider">
                    <option value="anthropic">Anthropic</option>
                    <option value="openai-compatible">OpenAI 兼容</option>
                  </Sel>
                </div>
              </div>
              <div v-if="form.provider === 'openai-compatible'" class="field">
                <label>Wire format</label>
                <div class="field-ctl">
                  <Sel v-model="form.wireFormat" data-testid="llm-form-wire">
                    <option :value="undefined">chat.completions（默认，中转/私有模型通用）</option>
                    <option value="responses">responses（OpenAI 官方推理模型无损）</option>
                  </Sel>
                </div>
              </div>
              <div class="field">
                <label>Base URL</label>
                <div class="field-ctl">
                  <input
                    v-model="form.baseURL"
                    class="input mono"
                    placeholder="留空 = 官方端点"
                    data-testid="llm-form-baseurl"
                  />
                </div>
              </div>
              <div class="field">
                <label>模型</label>
                <div class="field-ctl">
                  <input
                    v-model="form.model"
                    class="input mono"
                    placeholder="claude-opus-4-8"
                    data-testid="llm-form-model"
                  />
                </div>
              </div>
              <div class="field">
                <label>API key</label>
                <div class="field-ctl">
                  <input
                    v-model="form.apiKey"
                    type="password"
                    class="input"
                    :placeholder="form.id ? '留空保持原值' : ''"
                    data-testid="llm-form-key"
                  />
                </div>
              </div>
              <div class="field">
                <label>上下文窗口</label>
                <div class="field-ctl">
                  <input
                    v-model.number="form.contextWindow"
                    type="number"
                    class="input wf-120 num"
                    placeholder="200000"
                    data-testid="llm-form-window"
                  />
                  <span class="quiet-txt" style="font-size: var(--fs-11)">
                    tokens · Agent 栏 token 圆环的分母
                  </span>
                </div>
              </div>
              <div class="field">
                <label>思考档位</label>
                <div class="field-ctl">
                  <Sel v-model="form.thinking" class="wf-160" data-testid="llm-form-thinking">
                    <option v-for="o in THINKING_OPTIONS" :key="o.value" :value="o.value">
                      {{ o.label }}
                    </option>
                  </Sel>
                </div>
              </div>
              <div class="mt-2 flex justify-end gap-2">
                <Btn size="sm" @click="editing = false">取消</Btn>
                <Btn
                  variant="primary"
                  size="sm"
                  data-testid="llm-form-save"
                  :disabled="!form.name.trim() || !form.model.trim()"
                  @click="saveProfile"
                >
                  保存
                </Btn>
              </div>
            </div>
          </div>

          <div class="set-group">
            <div class="cap">额外的 LLM 用量</div>
            <div class="srow">
              <div class="srow-txt">
                <b>L3 智能补全</b>
                <p>
                  命令结束时预测下一条、非零退出码给修复建议（灰字 ghost，→ 接受）。
                  每条命令一次 LLM 调用，走活动模型服务的额度。
                </p>
              </div>
              <div class="srow-ctl">
                <Sw
                  :model-value="settings.completionLlmEnabled"
                  data-testid="settings-suggest-toggle"
                  @update:model-value="toggleCompletionLlm"
                />
              </div>
            </div>
          </div>
        </template>

        <!-- ── 安全与审计 ── -->
        <template v-else-if="settingsSection === 'security'">
          <h3>安全与审计</h3>
          <p class="lead">出口脱敏与操作留痕。</p>

          <div class="set-group">
            <div class="srow">
              <div class="srow-txt">
                <b>凭据脱敏</b>
                <p>检测转录出口里的密钥与密码，替换成指纹占位符再交给 AI 或落盘。</p>
              </div>
              <div class="srow-ctl">
                <Sw
                  :model-value="settings.redactionEnabled"
                  data-testid="settings-redaction-toggle"
                  @update:model-value="toggleRedaction"
                />
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt">
                <b>审计日志</b>
                <p>自动执行、每条提案与决策、批准命令的结果，脱敏后追加到 audit.jsonl。</p>
              </div>
              <div class="srow-ctl">
                <Btn size="sm" data-testid="settings-audit-reveal" @click="revealAudit">
                  打开位置
                </Btn>
              </div>
            </div>
          </div>

          <div class="banner banner-warn" style="margin-top: 12px">
            <AlertTriangle class="i-16" />
            <span>
              关掉脱敏后，转录与命令历史保留原文——发给 AI 或落盘的内容包含真实凭据。
              另：Agent 对话记录会落盘，其中命令输出已脱敏，但<b>你在对话框里亲手打的字
              任何时候都原样保存</b>——别把密码打进对话框。
            </span>
          </div>
        </template>

        <!-- ── 命令行工具 ── -->
        <template v-else-if="settingsSection === 'cli'">
          <h3>命令行工具</h3>
          <p class="lead">把执行平面开放给 Claude Code / Codex 这类外部 agent。</p>

          <div class="set-group" data-testid="settings-cli-section">
            <div class="srow">
              <div class="srow-txt">
                <b>安装 tsubasa-ssh（加入 PATH）</b>
                <p>
                  外部 agent 经 <code>tsubasa-ssh</code> 复用你已连接的会话、共享闸门与审计，
                  命令仍落在你看得见的终端里。
                </p>
              </div>
              <div class="srow-ctl">
                <span :class="cliState.cls" data-testid="settings-cli-state">
                  {{ cliState.text }}
                </span>
                <Sw
                  :model-value="settings.cliBridgeEnabled"
                  :disabled="cliBusy"
                  data-testid="settings-cli-bridge"
                  @update:model-value="toggleCliBridge"
                />
              </div>
            </div>

            <div v-for="s in cli?.skills ?? []" :key="s.target" class="srow is-child">
              <div class="srow-txt">
                <b>{{ skillLabel(s.target) }}</b>
                <p>
                  往 <code>{{ s.dir }}</code> 写一份用法与闸门规则，随版本自动更新；
                  你手工改过的不会被覆盖。
                </p>
                <p
                  v-if="s.legacyDir"
                  class="is-warn"
                  :data-testid="`settings-cli-skill-legacy-${s.target}`"
                >
                  旧位置 <code>{{ s.legacyDir }}</code>
                  仍有手工改过或非本程序写入的文件，已原样保留；确认不再需要后请手动删除，以免重复加载。
                </p>
              </div>
              <div class="srow-ctl">
                <span
                  :class="s.state === 'modified' ? 'tag tag-warn' : 'tag'"
                  :data-testid="`settings-cli-skill-state-${s.target}`"
                >
                  {{ skillHint(s) }}
                </span>
                <Sw
                  :model-value="skillOn(s.target)"
                  :disabled="cliBusy || s.state === 'modified'"
                  :data-testid="`settings-cli-skill-${s.target}`"
                  @update:model-value="toggleCliSkill(s.target)"
                />
              </div>
            </div>
          </div>

          <div class="banner banner-danger" style="margin-top: 12px">
            <AlertTriangle class="i-16" />
            <span>
              <b>这是这条通道唯一的新增攻击面。</b>管道
              <code>{{ cli?.pipeName || '(未就绪)' }}</code>
              同用户即同权：任何本地进程连上它都能操纵你所有已连会话（凭据仍不出主进程）。
              不用时请关掉。
            </span>
          </div>
          <div class="banner banner-info" style="margin-top: 8px">
            <Info class="i-16" />
            <span>
              首次调用时对方会撞到权限提示，把 <code>tsubasa-ssh</code> 整条放行即可——
              审批权唯一归属 Tsubasa Terminal。改 PATH 对<b>已开着的终端不生效</b>，开完请重开终端。
            </span>
          </div>
        </template>

        <!-- ── 关于 ── -->
        <template v-else>
          <h3>关于</h3>
          <p class="lead">Tsubasa Terminal · v{{ version }}</p>

          <div class="set-group">
            <div class="cap">许可</div>
            <div class="srow">
              <div class="srow-txt">
                <b>MIT License</b>
                <p>本程序按「原样」提供，不附带任何担保。</p>
              </div>
            </div>
            <div class="srow">
              <div class="srow-txt">
                <b>主要第三方组件</b>
                <p>
                  完整清单与许可证全文见安装目录 <code>resources</code> 下的
                  <code>THIRD_PARTY_NOTICES.md</code> 与 <code>THIRD_PARTY_LICENSES.txt</code>；
                  Electron 与 Chromium 的许可随程序位于安装目录根。
                </p>
                <dl class="credits">
                  <template v-for="item in CREDITS" :key="item.name">
                    <dt>{{ item.name }}</dt>
                    <dd>{{ item.license }}</dd>
                  </template>
                </dl>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </Dlg>
</template>
