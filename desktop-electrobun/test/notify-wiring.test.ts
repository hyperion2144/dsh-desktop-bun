// 通知接线门禁（#115 收全通知面）：15 个场景里曾有 5 个「面板有开关、生产零调用点」的死配置
// （runtime.download / runtime.switch / profile.op / profile.error / config.info）。
// 单测测不到「事件没接上」（#115 聚焦记账就漏过一版而全绿），这里把每个死配置的接线点
// 钉在源码上：改 service.ts / index.ts 时漏接就变红。
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

/** 先剥掉注释再断言：防「调用删了、注释里还留着同名串」式的假门禁。 */
const codeOf = (file: string): string =>
  readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('通知接线门禁：死配置都接上了真事件（#115）', () => {
  const serviceSource = codeOf('../src/bun/host/service.ts')
    const indexSource = codeOf('../src/bun/desktop-shell.ts')
    const installerSource = codeOf('../src/bun/runtime/runtime-install.ts')
  const settingsSource = codeOf('../src/shared/settings/settings.ts')

  test('运行时下载：托盘与面板两条路都汇到带通知的包装，托盘不再用 STARTUP_ERROR 重复报', () => {
    expect(serviceSource).toContain('download: downloadRuntimeNotified,')
    expect(serviceSource).toContain('downloadRuntime: downloadRuntimeNotified,')
    expect(installerSource).toContain('SCENARIO.RUNTIME_DOWNLOAD')
    // #117 后 index.ts 有两处合法 STARTUP_ERROR（桌面壳 / dsh 启动失败）；门禁钉的是当初的
    // 具体回归：托盘下载失败不得再报 STARTUP_ERROR（现在统一由服务层发 RUNTIME_DOWNLOAD）。
    expect(indexSource).not.toContain('SCENARIO.STARTUP_ERROR, `下载运行时')
  })

  test('运行时切换：托盘切换的成功与失败都发 RUNTIME_SWITCH', () => {
    const switches = indexSource.match(/SCENARIO\.RUNTIME_SWITCH/g) ?? []
    expect(switches.length).toBe(2)
  })

  test('profile.op / profile.error：新建与迁移成功、迁移失败各归各位', () => {
    const profileOps = serviceSource.match(/SCENARIO\.PROFILE_OP/g) ?? []
    expect(profileOps.length).toBe(2)
    expect(serviceSource).toContain('SCENARIO.PROFILE_ERROR')
  })

  test('config.info：保存真动了端口键才提示（changedPortKeys 接进 saveSettings）', () => {
    expect(serviceSource).toContain('const changedPorts = changedPortKeys(before, liveSettings)')
    expect(serviceSource).toContain('SCENARIO.CONFIG_INFO')
    expect(settingsSource).toContain('export function changedPortKeys')
  })

  test('场景表描述与行为一致（下载是「完成 / 失败」，不再写「开始」）', () => {
    expect(settingsSource).toContain('运行时下载完成 / 失败')
  })
})
