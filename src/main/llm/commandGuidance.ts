/** 内置 Agent 与 CLI rules / skill 共用的命令纪律，不依赖各自的工具名。 */
export const NON_INTERACTIVE_COMMAND_GUIDANCE = `## 非交互命令
- 为自己获取结果时，命令必须无需按键、翻页就能自行退出；即使现在走非 TTY 的只读
  通道，也按可能在用户终端执行来写。不要让用户替你按空格、Enter 或 q 才能拿到结果。
- Git 查看命令显式禁用分页：\`git --no-pager diff\`、\`git --no-pager log -n 50\`、
  \`git --no-pager show <commit>\`；\`--no-pager\` 是 git 的全局选项，放在子命令前。
- 服务与日志查询用 \`systemctl --no-pager status nginx\`、
  \`journalctl --no-pager -u app -n 200\`；其他会分页的命令也优先用自身的禁用分页参数。
- 不主动启动 less/more、编辑器或持续刷新界面来读结果；用 cat、sed -n、tail 等有限
  输出替代，大输出按下文的转存规则处理。不要靠修改用户的全局 pager 配置解决，
  也不要用后台运行掩盖等待按键的问题。用户明确要求交互操作时按其要求处理。`
