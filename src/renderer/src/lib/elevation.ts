import type { ElevationFailReason } from '@shared/types'

/**
 * 身份切换降级原因的人话文案（identity-design UI 节）：
 * 徽章存在的理由就是降级——降级只有一种形态（整会话退回登录用户），
 * 徽章带原因，消灭"用户以为自己是 root"的猜谜。
 */
export function elevationReasonText(reason: ElevationFailReason | undefined): string {
  switch (reason) {
    case 'no-password':
      return 'sudo 需要密码，但主机配置未填 sudo 密码'
    case 'password':
      return 'sudo 密码被拒，请检查主机配置里的 sudo 密码'
    case 'not-root':
      return 'sudo 切换未生效（可能不在 sudoers 名单）'
    case 'no-exec-auth':
      return 'exec 通道 sudo 不可用（requiretty 等策略限制）'
    case 'no-sftp-server':
      return '找不到 sftp-server 程序（可能用的是 internal-sftp），可在主机配置里手填路径'
    case 'sftp-init':
      return 'root 版 SFTP 未能启动（文件栏与 rz/sz 会停在登录用户）'
    case 'timeout':
      return 'sudo 握手超时（密码提示无法识别或远端无响应）'
    default:
      return '握手异常'
  }
}
