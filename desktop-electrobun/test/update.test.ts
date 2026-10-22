// 应用更新（#235：壳侧全自管——检查/下载/安装都不依赖 Electrobun 框架 Updater）。
//
// 守的是三件事：
//   1. **纯逻辑**：版本比较（含预发布段）、进度与字节数的翻译、按钮可点性——客户端完全照这个渲染；
//   2. **不静默降级**：404 二义性（发布过 vs 没发布过）、HTTP 500、网络中断、清单非法——
//      失败都要落进视图写清楚「为什么不可用」，不是笼统红字；
//   3. **IO 外壳**（createUpdater 的自管 check）：清单 URL 前缀固定 stable、env 覆盖源、
//      版本比较定可用性（不看 hash）——dev 实例也能检查到发布。
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_UPDATE_BASE_URL,
  UPDATE_BASE_URL_ENV,
  UPDATE_DISABLE_ENV,
    classifyUpdateFailure,
    compareVersions,
  feedFileName,
  feedUrl,
  formatBytes,
  isNewerVersion,
  phaseOfStatus,
  platformPrefixOf,
  progressOf,
  updateActions,
  updateView,
} from '../src/shared/runtime/update.ts'
import { silentLogger } from './helpers/test-logger.ts'
import { createUpdater, isFlagOn } from '../src/bun/platform/updater.ts'

describe('平台前缀与清单 URL', () => {
  test('前缀是 <buildEnvironment>-<os>-<arch>', () => {
    expect(platformPrefixOf({ buildEnv: 'stable', os: 'macos', arch: 'arm64' })).toBe(
      'stable-macos-arm64'
    )
    expect(platformPrefixOf({ buildEnv: 'dev', os: 'win', arch: 'x64' })).toBe('dev-win-x64')
  })

  test('清单名带前缀，baseUrl 尾斜杠可有可无', () => {
    expect(feedFileName('stable-macos-arm64')).toBe('stable-macos-arm64-update.json')
    expect(feedUrl('https://example.com/rel', 'stable-macos-arm64')).toBe(
      'https://example.com/rel/stable-macos-arm64-update.json'
    )
    expect(feedUrl('https://example.com/rel/', 'stable-macos-arm64')).toBe(
      'https://example.com/rel/stable-macos-arm64-update.json'
    )
    // 空 baseUrl 不拼出半截 URL（面板显示空串比显示 `/xxx-update.json` 诚实）
    expect(feedUrl('', 'stable-macos-arm64')).toBe('')
  })

  test('默认源是 GitHub Releases 的 latest/download 别名', () => {
    expect(DEFAULT_UPDATE_BASE_URL).toContain('github.com/hyperion2144/dsh-desktop-bun')
    expect(DEFAULT_UPDATE_BASE_URL.endsWith('/releases/latest/download')).toBe(true)
  })
})
describe('失败分类（classifyUpdateFailure）', () => {
    test('#235：受管目录校验错误给出可操作提示，不笼统红字', () => {
        const failure = classifyUpdateFailure('The running application is outside its managed update directory')
        expect(failure.kind).toBe('managed-dir')
        expect(failure.text).toContain('受管更新目录')
        expect(failure.text).toContain('安装包')
    })
})

describe('版本比较', () => {
  test('数字段按数值（不是字典序）', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
  })

  test('预发布段：数字按数值，预发布比正式版小', () => {
    expect(compareVersions('0.2.1-alpha.10', '0.2.1-alpha.2')).toBe(1)
    expect(compareVersions('0.2.1-alpha.2', '0.2.1')).toBe(-1)
    expect(compareVersions('0.2.1', '0.2.1-alpha.2')).toBe(1)
    expect(compareVersions('0.2.1-rc.1', '0.2.1-alpha.2')).toBe(1)
  })

  test('容忍 v 前缀与空白', () => {
    expect(compareVersions(' v0.2.0 ', '0.2.0')).toBe(0)
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '')).toBe(false)
  })
})

describe('状态 → 阶段', () => {
  test('Electrobun 的状态映射到 9 个阶段', () => {
    expect(phaseOfStatus('idle')).toBe('idle')
    expect(phaseOfStatus('')).toBe('idle')
    expect(phaseOfStatus('checking')).toBe('checking')
    expect(phaseOfStatus('check-complete')).toBe('checking')
    expect(phaseOfStatus('no-update')).toBe('up-to-date')
    expect(phaseOfStatus('update-available')).toBe('available')
    expect(phaseOfStatus('download-progress')).toBe('downloading')
    expect(phaseOfStatus('downloading-full-bundle')).toBe('downloading')
    // patch-failed 的语义是「补丁失败，会回落整包」⇒ 仍然算在下载里
    expect(phaseOfStatus('patch-failed')).toBe('downloading')
    expect(phaseOfStatus('replacing-app')).toBe('preparing')
    expect(phaseOfStatus('complete')).toBe('ready')
    expect(phaseOfStatus('launching-new-version')).toBe('ready')
    expect(phaseOfStatus('error')).toBe('error')
    expect(phaseOfStatus('something-new')).toBe('checking')
  })
})

describe('进度与字节数', () => {
  test('progress 是 0..1 的比例，越界被夹住', () => {
    expect(progressOf({ progress: 0.5 })).toBe(50)
    expect(progressOf({ progress: 0 })).toBe(0)
    expect(progressOf({ progress: 1 })).toBe(100)
    expect(progressOf({ progress: 1.5 })).toBe(100)
    expect(progressOf({ progress: -1 })).toBe(0)
    expect(progressOf(undefined)).toBe(null)
  })

  test('没有 progress 时用字节数兜底，两者都没有就 null', () => {
    expect(progressOf({ bytesDownloaded: 512, totalBytes: 1024 })).toBe(50)
    expect(progressOf({ bytesDownloaded: 512, totalBytes: 0 })).toBe(null)
    expect(progressOf({ bytesDownloaded: 512 })).toBe(null)
    expect(progressOf({})).toBe(null)
  })

  test('字节数格式化', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(12_582_912)).toBe('12.0 MB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
  })
})

describe('视图合成', () => {
  test('不可用时带上原因，阶段固定是 unavailable', () => {
    const view = updateView({
      available: false,
      reason: '当前构建没有更新源',
      prefix: 'dev-macos-arm64',
      local: { version: '0.1.0', channel: 'dev' },
    })
    expect(view.phase).toBe('unavailable')
    expect(view.label).toBe('不可用')
    expect(view.reason).toBe('当前构建没有更新源')
    expect(view.current).toBe('0.1.0')
  })

  test('远端版本更新时即使还没检查也标出「可更新」', () => {
    const view = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
      remote: { version: '0.2.0' },
    })
    expect(view.phase).toBe('idle')
    expect(view.updateAvailable).toBe(true)
    expect(view.feedUrl).toBe('https://example.com/r/stable-macos-arm64-update.json')
  })

  test('状态里的错误信息与进度都进视图', () => {
    const downloading = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
      remote: { version: '0.2.0', updateAvailable: true },
      status: {
        status: 'download-progress',
        message: '下载中',
        timestamp: 1234,
        details: { progress: 0.25, bytesDownloaded: 1024, totalBytes: 4096 },
      },
    })
    expect(downloading.phase).toBe('downloading')
    expect(downloading.progress).toBe(25)
    expect(downloading.at).toBe(1234)

    const failed = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0' },
      status: { status: 'error', details: { errorMessage: '磁盘满了' } },
    })
    expect(failed.phase).toBe('error')
    // 错误文本进视图（壳侧给它加一句中文前缀，原文仍保留）
    expect(failed.error).toContain('磁盘满了')
  })

  test('install 完成 ⇒ updateReady（按钮该变成「重启并安装」）', () => {
    const view = updateView({
      available: true,
      prefix: 'stable-macos-arm64',
      local: { version: '0.1.0' },
      status: { status: 'complete', message: '已替换' },
    })
    expect(view.phase).toBe('ready')
    expect(view.updateReady).toBe(true)
  })
})

describe('按钮可点性', () => {
  const base = {
    available: true,
    reason: '',
    prefix: 'stable-macos-arm64',
    local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
  }

  test('不可用 ⇒ 三个都点不了，hint 就是不可用原因', () => {
    const view = updateView({ ...base, available: false, reason: '没有更新源' })
    const actions = updateActions(view)
    expect(actions).toEqual({
      canCheck: false,
      canDownload: false,
      canApply: false,
      hint: '没有更新源',
    })
  })

  test('空闲 ⇒ 只能检查', () => {
    const actions = updateActions(updateView(base))
    expect(actions.canCheck).toBe(true)
    expect(actions.canDownload).toBe(false)
    expect(actions.canApply).toBe(false)
  })

  test('有新版本 ⇒ 能下载；安装完 ⇒ 能重启安装', () => {
    const available = updateActions(
      updateView({ ...base, remote: { version: '0.2.0' }, status: { status: 'update-available' } })
    )
    expect(available.canDownload).toBe(true)
    expect(available.hint).toContain('0.2.0')

    const ready = updateActions(updateView({ ...base, status: { status: 'complete' } }))
    expect(ready.canApply).toBe(true)
    expect(ready.hint).toContain('重启')
  })

  test('忙的时候三个都点不了，hint 是当前阶段', () => {
    const view = updateView({ ...base, status: { status: 'downloading-full-bundle' } })
    const actions = updateActions(view)
    expect(actions.canCheck).toBe(false)
    expect(actions.canDownload).toBe(false)
    expect(actions.canApply).toBe(false)
    expect(actions.hint).toBe('正在下载…')
  })

  test('已是最新 ⇒ 提示写当前版本', () => {
    const actions = updateActions(updateView({ ...base, status: { status: 'no-update' } }))
    expect(actions.hint).toContain('0.1.0')
    expect(actions.canDownload).toBe(false)
  })
})

describe('开关解析', () => {
  test('只有 1/true/yes/on 才算开', () => {
    expect(isFlagOn('1')).toBe(true)
    expect(isFlagOn('true')).toBe(true)
    expect(isFlagOn(' YES ')).toBe(true)
    expect(isFlagOn('on')).toBe(true)
    expect(isFlagOn('0')).toBe(false)
    expect(isFlagOn('false')).toBe(false)
    expect(isFlagOn('')).toBe(false)
    expect(isFlagOn(undefined)).toBe(false)
  })
})

/** 合法清单（发布链 release-publish.mjs 的结构子集）。 */
const OK_MANIFEST = {
    schemaVersion: 1,
    identifier: 'com.hyperion.dsh-desktop-bun',
    channel: 'stable',
    version: '0.2.0',
    hash: 'h2',
    platform: 'macos',
    arch: 'arm64',
}

/** 假 fetch：按脚本回清单/错误，记录请求 URL（自管 check 的测试缝）。 */
function fakeFetch(input: {
    manifest?: unknown
    status?: number
    fail?: Error
}): { fetchFn: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const fetchFn = (async (target: RequestInfo | URL) => {
        urls.push(String(target))
        if (input.fail !== undefined) throw input.fail
        if (input.status !== undefined && input.status !== 200) {
            return new Response('nope', { status: input.status })
        }
        return new Response(JSON.stringify(input.manifest ?? OK_MANIFEST), { status: 200 })
    }) as typeof fetch
    return { fetchFn, urls }
}

describe('createUpdater（自管 check）', () => {
    test('被开关关掉 ⇒ 不可用且写明是哪个环境变量（且不发请求）', async () => {
        const fake = fakeFetch({})
        const updater = createUpdater({
            log: silentLogger,
            env: { [UPDATE_DISABLE_ENV]: '1' },
            fetchFn: fake.fetchFn,
        })
        await updater.check()
        const snapshot = updater.snapshot()
        expect(snapshot.available).toBe(false)
        expect(snapshot.view.phase).toBe('unavailable')
        expect(snapshot.view.reason).toContain(UPDATE_DISABLE_ENV)
        expect(snapshot.actions.canCheck).toBe(false)
        expect(fake.urls).toEqual([])
    })

    test('检查成功：清单前缀固定 stable（dev 实例也查发布链同一份），新版本 ⇒ updateAvailable', async () => {
        const fake = fakeFetch({})
        const updater = createUpdater({
            log: silentLogger,
            env: {},
            currentVersion: '0.1.0',
            os: 'darwin',
            arch: 'arm64',
            fetchFn: fake.fetchFn,
        })
        const snapshot = await updater.check()
        expect(snapshot.available).toBe(true)
        expect(snapshot.view.updateAvailable).toBe(true)
        expect(snapshot.view.latest).toBe('0.2.0')
        expect(fake.urls).toEqual([`${DEFAULT_UPDATE_BASE_URL}/stable-macos-arm64-update.json`])
    })

    test('env 覆盖更新源：清单 URL 跟着覆盖走', async () => {
        const fake = fakeFetch({})
        const updater = createUpdater({
            log: silentLogger,
            env: { [UPDATE_BASE_URL_ENV]: 'http://127.0.0.1:8899/feed/' },
            currentVersion: '0.1.0',
            os: 'darwin',
            arch: 'arm64',
            fetchFn: fake.fetchFn,
        })
        const snapshot = await updater.check()
        expect(snapshot.available).toBe(true)
        expect(fake.urls).toEqual(['http://127.0.0.1:8899/feed/stable-macos-arm64-update.json'])
    })

    test('远端不比本地新 ⇒ updateAvailable=false（版本比较，不看 hash）', async () => {
        const fake = fakeFetch({ manifest: { ...OK_MANIFEST, version: '0.1.0' } })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.updateAvailable).toBe(false)
    })

    // PR #236 实测回归：自管 check 的终态不能写框架的 check-complete（那是「查完发现有更新」的中间态，
    // phase→checking）——面板每秒轮询会永远显示「正在检查…」。终态必须落 no-update / update-available。
    test('检查完成（无更新）⇒ phase=up-to-date，不再卡「正在检查…」', async () => {
        const fake = fakeFetch({ manifest: { ...OK_MANIFEST, version: '0.1.0' } })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.phase).toBe('up-to-date')
        expect(snapshot.view.label).toBe('已是最新')
    })

    test('检查完成（有更新）⇒ phase=available（不是 checking）', async () => {
        const fake = fakeFetch({ manifest: { ...OK_MANIFEST, version: '0.2.0' } })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.updateAvailable).toBe(true)
        expect(snapshot.view.phase).toBe('available')
    })

    test('本地版本未知（读不到 version.json）⇒ 检查照常、不误报可更新', async () => {
        const fake = fakeFetch({})
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: 'unknown', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.updateAvailable).toBe(false)
    })
})

describe('失败语义（#216 的 404 二义性 + 常见网络错）', () => {
    test('404 且这个通道没发过版 ⇒ 「暂未发布」（不是失败、也不是「已是最新」）', async () => {
        const fake = fakeFetch({ status: 404 })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn, probeRelease: async () => 'absent' })
        const snapshot = await updater.check()
        expect(snapshot.view.phase).toBe('no-release')
        expect(snapshot.view.label).toBe('暂未发布')
        expect(snapshot.view.error).toBe('')
        expect(snapshot.view.message).toContain('还没有发布过版本')
        expect(snapshot.actions.hint).toContain('还没有发布过版本')
        expect(snapshot.actions.canCheck).toBe(true)
        expect(snapshot.actions.canDownload).toBe(false)
    })

    test('404 但确实有发布 ⇒ 报错（发布链路故障不能静默成「无更新」）', async () => {
        const fake = fakeFetch({ status: 404 })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn, probeRelease: async () => 'present' })
        const snapshot = await updater.check()
        expect(snapshot.view.phase).toBe('error')
        expect(snapshot.view.label).toBe('更新失败')
        expect(snapshot.view.error).toContain('没有本平台的更新资产')
    })

    test('探不到（unknown）⇒ 仍按「暂未发布」处理', async () => {
        const fake = fakeFetch({ status: 404 })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn, probeRelease: async () => 'unknown' })
        expect((await updater.check()).view.phase).toBe('no-release')
    })

    test('HTTP 500 ⇒ 失败态，中文原因可见（不直出英文原文）', async () => {
        const fake = fakeFetch({ status: 500 })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.phase).toBe('error')
        expect(snapshot.view.error).toBe('更新源返回 HTTP 500')
        expect(snapshot.view.message).not.toContain('Failed to check for updates')
    })

    test('网络中断 ⇒ 失败态，中文原因', async () => {
        const fake = fakeFetch({ fail: new Error('The network connection was lost.') })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.phase).toBe('error')
        expect(snapshot.view.error).toContain('网络')
        expect(snapshot.view.error).not.toContain('network connection was lost')
    })

    test('清单非法 ⇒ 失败态（version 缺失与 404 不同因）', async () => {
        const fake = fakeFetch({ manifest: { channel: 'stable' } })
        const updater = createUpdater({ log: silentLogger, env: {}, currentVersion: '0.1.0', os: 'darwin', arch: 'arm64', fetchFn: fake.fetchFn })
        const snapshot = await updater.check()
        expect(snapshot.view.phase).toBe('error')
        expect(snapshot.view.error).toContain('清单')
    })

    test('纯逻辑层：error 传空串也不能短路掉状态里的错误文本', () => {
        const view = updateView({
            available: true,
            reason: '',
            prefix: 'stable-macos-arm64',
            local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
            error: '',
            status: { status: 'error', details: { errorMessage: 'HTTP 500' } },
        })
        expect(view.phase).toBe('error')
        expect(view.error).toBe('更新源返回 HTTP 500')
    })

    test('纯逻辑层：状态是历史遗留的 error 但没有错误文本 ⇒ 仍是「未检查」', () => {
        const view = updateView({
            available: true,
            reason: '',
            prefix: 'stable-macos-arm64',
            local: { version: '0.1.0', channel: 'stable', baseUrl: 'https://example.com/r' },
            status: { status: 'error' },
        })
        expect(view.phase).toBe('idle')
        expect(view.error).toBe('')
    })
})
