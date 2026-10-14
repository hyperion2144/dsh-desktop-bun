// Windows 通知兜底通道：PowerShell NotifyIcon 气泡（Win10+ 会被行动中心渲染成 toast）。
// 通知主路径是 UN 桥（darwin）→ Electrobun 的 Utils.showNotification（Windows 上上版实测可用）；
// 只有连原生通道都没有的环境才落到这里。气泡需要临时托盘图标，显示完就 Dispose；整段异步发起。

export interface WindowsBalloonOptions {
  title: string
  body: string
}

/** PowerShell 单引号字面量：内部单引号翻倍。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 气泡脚本（宿主以 -EncodedCommand 执行，内容经 base64 不怕引号/中文）。 */
export function windowsBalloonScript(title: string, body: string): string {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$icon = New-Object System.Windows.Forms.NotifyIcon',
    '$icon.Icon = [System.Drawing.SystemIcons]::Information',
    '$icon.Visible = $true',
    `$icon.BalloonTipTitle = ${psQuote(title)}`,
    `$icon.BalloonTipText = ${psQuote(body)}`,
    '$icon.ShowBalloonTip(6000)',
    'Start-Sleep -Seconds 7',
    '$icon.Visible = $false',
    '$icon.Dispose()',
  ].join('; ')
}

export function windowsBalloonCommand(title: string, body: string): string[] {
  return [
    'powershell',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(windowsBalloonScript(title, body), 'utf16le').toString('base64'),
  ]
}

/** 发起气泡通知（fire-and-forget：失败只影响这一次提醒，不值得打断主流程）。 */
export function showWindowsBalloon(
  options: WindowsBalloonOptions,
  spawn: (argv: string[]) => unknown = (argv) => Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }),
): void {
  try {
    spawn(windowsBalloonCommand(options.title, options.body))
  } catch {
    // 静默：通知是锦上添花，主流程（注册/重启等）不受它影响
  }
}
