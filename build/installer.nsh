; Tsubasa Terminal NSIS 自定义脚本（v0.12.0 CLI 通道）
;
; NSIS 在这里**只做卸载卫生**：删 shim 三件套、目录空则摘 PATH 条目。
; 安装与自愈一律由应用自己做（见 src/main/cli/install.ts）——社区常用的 EnvVarUpdate
; 在 PATH 超 1024 字符时会静默截断整条 PATH（现代开发机几乎必超），
; 且安装器写死的路径没人自愈。
;
; PATH 条目的摘除同样不走 NSIS 的 ReadRegStr（同一个 1024 字符陷阱），
; 而是调 PowerShell 直接操作注册表键：DoNotExpandEnvironmentNames 保住 %VAR% 原样，
; GetValueKind 保住 REG_EXPAND_SZ 类型，改完广播 WM_SETTINGCHANGE。

!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$LOCALAPPDATA\tsubasa\bin\tsubasa-ssh.cmd"
    Delete "$LOCALAPPDATA\tsubasa\bin\tsubasa-ssh.ps1"
    Delete "$LOCALAPPDATA\tsubasa\bin\tsubasa-ssh"
    ; RMDir 只在目录为空时成功——家族里还有 tsubasa-mysql / tsubasa-redis 时不动
    RMDir "$LOCALAPPDATA\tsubasa\bin"
    IfFileExists "$LOCALAPPDATA\tsubasa\bin\*.*" skipPathCleanup 0
      nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = Join-Path $$env:LOCALAPPDATA (Join-Path ''tsubasa'' ''bin''); $$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(''Environment'', $$true); if ($$k) { $$v = [string]$$k.GetValue(''Path'', '''', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); try { $$kind = $$k.GetValueKind(''Path'') } catch { $$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString }; $$p = @($$v -split '';'' | Where-Object { $$_ -ne '''' -and $$_.TrimEnd([char]92) -ine $$d.TrimEnd([char]92) }); $$k.SetValue(''Path'', ($$p -join '';''), $$kind); $$k.Close() }"'
      Pop $0
    skipPathCleanup:
    ; skill 与 CLI 的握手 token 属用户数据，与 audit.jsonl / hosts.json 同待遇：不删
  ${endIf}
!macroend
