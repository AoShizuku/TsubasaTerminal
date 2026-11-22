<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { AlertTriangle, Info } from 'lucide-vue-next'
import Btn from '@/components/ui/Btn.vue'
import Dlg from '@/components/ui/Dlg.vue'
import Sel from '@/components/ui/Sel.vue'
import Sw from '@/components/ui/Sw.vue'
import {
  KNOWLEDGE_LIMIT,
  type HostConfig,
  type HostInput,
  type TerminalInputMode
} from '@shared/types'

const props = defineProps<{
  /** 传入表示编辑模式，否则为新建 */
  host?: HostConfig | null
}>()

const open = defineModel<boolean>('open', { required: true })

const emit = defineEmits<{
  save: [input: HostInput]
}>()

const isEdit = computed(() => !!props.host)

type TabKey = 'general' | 'session' | 'knowledge'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'general', label: '常规' },
  { key: 'session', label: '会话' },
  { key: 'knowledge', label: '知识' }
]

const tab = ref<TabKey>('general')

const emptyForm = {
  name: '',
  host: '',
  port: '22',
  username: '',
  authType: 'password' as HostConfig['authType'],
  password: '',
  privateKeyPath: '',
  passphrase: '',
  shellIntegration: true,
  envLevel: 'none' as NonNullable<HostConfig['envLevel']>,
  tmuxKeepalive: false,
  /** 'global' = 跟随设置里的默认输入方式（不落盘） */
  inputMode: 'global' as 'global' | TerminalInputMode,
  elevate: false,
  sudoPassword: '',
  sftpServerPath: '',
  knowledge: ''
}

const form = reactive({ ...emptyForm })

watch(open, (value) => {
  if (!value) return
  tab.value = 'general'
  if (props.host) {
    Object.assign(form, {
      name: props.host.name,
      host: props.host.host,
      port: String(props.host.port),
      username: props.host.username,
      authType: props.host.authType,
      password: '',
      privateKeyPath: props.host.privateKeyPath ?? '',
      passphrase: '',
      shellIntegration: props.host.shellIntegration !== false,
      envLevel: props.host.envLevel ?? 'none',
      tmuxKeepalive: props.host.tmuxKeepalive === true,
      inputMode: props.host.inputMode ?? 'global',
      elevate: props.host.elevate === 'sudo',
      sudoPassword: '',
      sftpServerPath: props.host.sftpServerPath ?? '',
      knowledge: props.host.knowledge ?? ''
    })
  } else {
    Object.assign(form, emptyForm)
  }
})

/**
 * 生产机短别名边界（agent-design 主机等级矩阵 2026-07 修订）：高危确认词打的是
 * 显示别名，所以别名必须是人叫得出口的名字——空/照抄地址/形如 IP/过长都打回。
 * 表单侧堵住，审批侧不做兜底降级。
 */
const aliasProblem = computed<string | null>(() => {
  if (form.envLevel !== 'production') return null
  const name = form.name.trim()
  if (!name) return '生产机必须有一个短别名（高危确认词会用它，不能是空）'
  if (name === form.host.trim()) return '别名不能照抄主机地址——高危确认时抄地址不经过大脑'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) {
    return '别名不能是 IP 地址——请起一个人类叫得出口的名字'
  }
  if (name.length > 32) return '别名过长（>32 字符）——高危确认要手输它，请再短一点'
  return null
})

/**
 * 页脚常驻的第一条问题。此前这条只在别名那个字段下面以红字出现，
 * 而"必填项没填"根本没有提示、按钮只是静静地不响应。三页分完之后更需要一个
 * 固定落点：出问题的字段可能在你当前没看的那一页。
 *
 * testid 跟着问题的**种类**走：别名那条沿用 form-alias-problem（e2e 按它断言
 * 生产机别名边界），其余走 form-problem。
 */
const problem = computed<string | null>(() => {
  if (!form.host.trim()) return '主机地址必填'
  if (!form.username.trim()) return '用户名必填'
  return aliasProblem.value
})

function submit(): void {
  if (problem.value) return
  emit('save', {
    id: props.host?.id,
    name: form.name.trim() || `${form.username}@${form.host}`,
    host: form.host.trim(),
    port: Number(form.port) || 22,
    username: form.username.trim(),
    authType: form.authType,
    privateKeyPath: form.privateKeyPath.trim() || undefined,
    shellIntegration: form.shellIntegration,
    envLevel: form.envLevel === 'none' ? undefined : form.envLevel,
    tmuxKeepalive: form.tmuxKeepalive || undefined,
    inputMode: form.inputMode === 'global' ? undefined : form.inputMode,
    elevate: form.elevate ? 'sudo' : undefined,
    sftpServerPath: form.sftpServerPath.trim() || undefined,
    knowledge: form.knowledge.trim() || undefined,
    password: form.password || undefined,
    passphrase: form.passphrase || undefined,
    sudoPassword: form.sudoPassword || undefined
  })
  open.value = false
}
</script>

<template>
  <Dlg
    v-model:open="open"
    :title="isEdit ? '编辑主机' : '新建主机'"
    :description="isEdit ? `${form.username}@${form.host}:${form.port}` : '凭据加密存在本机，永不跨 IPC'"
    :width="620"
  >
    <template #tabs>
      <div class="dlg-tabs">
        <button
          v-for="item in TABS"
          :key="item.key"
          class="dlg-tab"
          :class="{ 'is-active': tab === item.key }"
          :data-testid="`form-tab-${item.key}`"
          @click="tab = item.key"
        >
          {{ item.label }}
          <span v-if="item.key === 'general' && problem" class="tag tag-danger">!</span>
          <span v-else-if="item.key === 'session' && form.elevate" class="tag tag-ok">root</span>
          <span v-else-if="item.key === 'knowledge' && form.knowledge" class="tag tag-accent">
            已写
          </span>
        </button>
      </div>
    </template>

    <!-- ── 常规 ── -->
    <div v-if="tab === 'general'" class="form form-steady">
      <div class="field">
        <label>名称</label>
        <div class="field-ctl">
          <input
            v-model="form.name"
            class="input"
            :placeholder="form.envLevel === 'production' ? '生产机必填短别名' : '留空则用 用户@地址'"
            data-testid="form-name"
          />
        </div>
      </div>
      <div class="field">
        <label>主机地址</label>
        <div class="field-ctl">
          <input
            v-model="form.host"
            class="input mono"
            placeholder="192.168.1.100"
            data-testid="form-host"
          />
          <input v-model="form.port" class="input mono wf-88 num" data-testid="form-port" />
        </div>
      </div>
      <div class="field">
        <label>用户名</label>
        <div class="field-ctl">
          <input v-model="form.username" class="input" placeholder="root" data-testid="form-username" />
        </div>
      </div>
      <div class="field">
        <label>环境等级</label>
        <div class="field-ctl">
          <Sel v-model="form.envLevel" class="wf-160" data-testid="form-env-level">
            <option value="none">无（默认）</option>
            <option value="production">生产</option>
            <option value="experiment">实验</option>
          </Sel>
          <span class="quiet-txt" style="font-size: var(--fs-11)">
            {{
              form.envLevel === 'production'
                ? '标识常驻，中风险以上走高危确认'
                : form.envLevel === 'experiment'
                  ? '仅标识，审批不变'
                  : ''
            }}
          </span>
        </div>
      </div>

      <div class="field">
        <label>认证方式</label>
        <div class="field-ctl">
          <Sel v-model="form.authType" class="wf-160" data-testid="form-auth-type">
            <option value="password">密码</option>
            <option value="privateKey">私钥文件</option>
          </Sel>
        </div>
      </div>

      <div v-if="form.authType === 'password'" class="field">
        <label>密码</label>
        <div class="field-ctl">
          <input
            v-model="form.password"
            type="password"
            class="input"
            :placeholder="isEdit ? '留空保持不变' : ''"
            data-testid="form-password"
          />
        </div>
      </div>

      <template v-else>
        <div class="field">
          <label>私钥路径</label>
          <div class="field-ctl">
            <input
              v-model="form.privateKeyPath"
              class="input mono"
              placeholder="留空则自动找 ~/.ssh 下的默认密钥"
            />
          </div>
        </div>
        <div class="field">
          <label>私钥口令</label>
          <div class="field-ctl">
            <input
              v-model="form.passphrase"
              type="password"
              class="input"
              :placeholder="isEdit ? '留空保持不变' : '可选'"
            />
          </div>
        </div>
      </template>

      <div v-if="form.envLevel === 'production'" class="banner banner-warn" style="margin-top: 10px">
        <AlertTriangle class="i-16" />
        <span>
          生产机的中风险以上提案要手输<b>上面这个别名</b>才放行。
          所以它必须是人叫得出口的短名字，不能是空、不能照抄地址、不能是 IP。
        </span>
      </div>
    </div>

    <!-- ── 会话 ── -->
    <div v-else-if="tab === 'session'" class="form form-steady">
      <div class="field">
        <label>Shell 集成</label>
        <div class="field-ctl">
          <Sw v-model="form.shellIntegration" data-testid="form-shell-integration" />
          <span class="quiet-txt" style="font-size: var(--fs-11)">目录跟随 / 命令边界</span>
        </div>
        <p class="field-hint">连接后装载一行 source，仅 bash / zsh。关掉则文件栏不跟随、转录无结构。</p>
      </div>

      <div class="field">
        <label>断线保活</label>
        <div class="field-ctl">
          <Sw v-model="form.tmuxKeepalive" data-testid="form-tmux-keepalive" />
          <span class="quiet-txt" style="font-size: var(--fs-11)">tmux</span>
        </div>
        <p class="field-hint">连接后自动 attach 服务端 tmux 会话池，断线重连回到原现场。</p>
      </div>

      <div class="field">
        <label>输入方式</label>
        <div class="field-ctl">
          <Sel v-model="form.inputMode" class="wf-160" data-testid="form-input-mode">
            <option value="global">跟随全局（默认）</option>
            <option value="composer">固定输入栏</option>
            <option value="native">原生终端直通</option>
          </Sel>
        </div>
        <p class="field-hint">
          这台机器用哪种输入方式，覆盖设置里的默认值；保存后已开的标签立即切换。
          未检测到 Shell 集成时始终直通。
        </p>
      </div>

      <div class="field">
        <label>以 root 运行</label>
        <div class="field-ctl">
          <Sw v-model="form.elevate" data-testid="form-elevate" />
          <span class="quiet-txt" style="font-size: var(--fs-11)">sudo -i</span>
        </div>
        <p class="field-hint">终端与 AI 命令通道同为 root。</p>
      </div>

      <template v-if="form.elevate">
        <div class="field">
          <label>sudo 密码</label>
          <div class="field-ctl">
            <input
              v-model="form.sudoPassword"
              type="password"
              class="input"
              :placeholder="isEdit && host?.hasSudoPassword ? '已配置，留空保持不变' : 'NOPASSWD 主机可留空'"
              data-testid="form-sudo-password"
            />
          </div>
        </div>
        <div class="field">
          <label>sftp-server</label>
          <div class="field-ctl">
            <input
              v-model="form.sftpServerPath"
              class="input mono"
              placeholder="留空自动探测，如 /usr/lib/openssh/sftp-server"
              data-testid="form-sftp-server-path"
            />
          </div>
          <p class="field-hint">文件栏与 rz / sz 切 root 靠在 exec channel 上跑它。</p>
        </div>
        <div class="banner banner-warn" style="margin-top: 10px">
          <AlertTriangle class="i-16" />
          <span>
            切换失败时<b>整个会话退回登录用户</b>并在标签页标明原因——
            不做部分提权，身份分裂比连不上更危险。
          </span>
        </div>
      </template>
    </div>

    <!-- ── 知识 ── -->
    <div v-else class="form form-steady">
      <div class="cap">
        <span>本机知识（给 AI 看的环境说明）</span>
        <span class="ml-auto num quiet-txt" data-testid="form-knowledge-count">
          {{ form.knowledge.length }}/{{ KNOWLEDGE_LIMIT }}
        </span>
      </div>
      <textarea
        v-model="form.knowledge"
        rows="9"
        :maxlength="KNOWLEDGE_LIMIT"
        data-testid="form-knowledge"
        placeholder="这台机器上有测试环境的 ACK，三个测试命名空间是 …&#10;日志在 /data/logs，不在 /var/log&#10;iptables 由 ansible 管，别手改"
        class="input mono mt-1.5"
      />
      <div class="banner banner-info" style="margin-top: 10px">
        <Info class="i-16" />
        <span>
          写拓扑、约定、禁忌、词汇表——尤其是<b>机器上查不到</b>的那些（组织约定）。
          Agent 每轮都能看到，但改不了它。保存后<b>下一个对话才生效</b>
          （它在缓存最前缀，中途换等于后续每轮重算）；重连主机或切换模型即开启新对话。
        </span>
      </div>
    </div>

    <template #footer>
      <span
        v-if="problem"
        class="min-w-0 flex-1 truncate"
        style="font-size: var(--fs-11); color: var(--danger-fg)"
        :data-testid="aliasProblem ? 'form-alias-problem' : 'form-problem'"
        :title="problem"
      >
        {{ problem }}
      </span>
      <span v-else class="flex-1" />
      <Btn @click="open = false">取消</Btn>
      <Btn variant="primary" data-testid="form-save" :disabled="!!problem" @click="submit">
        保存
      </Btn>
    </template>
  </Dlg>
</template>
