// Windows 气泡通知（#62）：脚本构造 + fire-and-forget 投递，全部注入不 spawn 真进程。
import { describe, expect, test } from 'bun:test'
import { showWindowsBalloon, windowsBalloonCommand, windowsBalloonScript } from '../src/bun/notify/notify-win.ts'

describe('windows 气泡通知', () => {
  test('脚本含标题/正文，单引号翻倍转义', () => {
    const script = windowsBalloonScript('dsh 注册成功', "it's ok")
    expect(script).toContain("BalloonTipTitle = 'dsh 注册成功'")
    expect(script).toContain("BalloonTipText = 'it''s ok'")
    expect(script).toContain('ShowBalloonTip(6000)')
    expect(script).toContain('Dispose()')
  })

  test('命令行：powershell -EncodedCommand（utf16le base64），解码后回到脚本', () => {
    const argv = windowsBalloonCommand('标题', '内容')
    expect(argv[0]).toBe('powershell')
    expect(argv).toContain('-EncodedCommand')
    const encoded = argv[argv.indexOf('-EncodedCommand') + 1] ?? ''
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(windowsBalloonScript('标题', '内容'))
  })

  test('fire-and-forget：spawn 抛错被吞掉，不炸主流程', () => {
    expect(() => showWindowsBalloon({ title: 't', body: 'b' }, () => { throw new Error('boom') })).not.toThrow()
    let received: string[] | null = null
    showWindowsBalloon({ title: 't', body: 'b' }, (argv) => {
      received = argv
    })
    expect((received as string[] | null)?.[0]).toBe('powershell')
  })
})
