// shell_update_status 合成逻辑的测试（#235）：两个状态源的优先级与字段翻译。

import { describe, expect, test } from 'bun:test'
import { shellUpdateStatusOf } from '../src/bun/platform/shell-update-status.ts'
import type { InstallerDownloadStatus } from '../src/bun/platform/installer-download.ts'
import type { UpdateView } from '../src/shared/runtime/update.ts'

function installerStatus(overrides: Partial<InstallerDownloadStatus> = {}): InstallerDownloadStatus {
    return {
        active: false,
        version: '',
        phase: 'idle',
        percent: null,
        bytesDownloaded: 0,
        totalBytes: null,
        filePath: '',
        error: '',
        cancelled: false,
        ...overrides,
    }
}

function view(overrides: Partial<UpdateView> = {}): UpdateView {
    return {
        available: true,
        reason: '',
        phase: 'available',
        label: '有新版本',
        status: '',
        message: '',
        current: '0.1.0',
        latest: '0.2.0',
        channel: 'stable',
        baseUrl: 'https://example.com',
        feedUrl: 'https://example.com/stable-win-x64-update.json',
        updateAvailable: true,
        updateReady: false,
        progress: null,
        bytesDownloaded: null,
        totalBytes: null,
        error: '',
        at: 0,
        ...overrides,
    }
}

describe('shellUpdateStatusOf', () => {
    test('下载器在跑：进度优先，框架视图不掺和', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({ active: true, version: '0.2.0', phase: 'downloading', percent: 42 }),
            view: view({ error: '框架的旧错误不该漏出来' }),
        })
        expect(status).toEqual({
            active: true,
            version: '0.2.0',
            percent: 42,
            error: '',
            updateReady: false,
            // 没传 targetPath（组装处没算落点）时保持空串；落点展示见下一个用例。
            installerPath: '',
        })
    })

    test('下载中带 targetPath：落点直接可见（不等就绪）', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({ active: true, version: '0.2.0', phase: 'downloading', percent: null }),
            view: view(),
            targetPath: 'C:\\u\\updates\\0.2.0\\x-setup.exe',
        })
        expect(status.active).toBe(true)
        expect(status.installerPath).toContain('0.2.0')
    })

    test('就绪但版本过时（新版本已发布）：不呈安装态，回落框架/磁盘探测', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({ version: '0.1.9', phase: 'ready', filePath: 'C:\\old\\x.exe' }),
            view: view({ latest: '0.2.0' }),
        })
        expect(status.updateReady).toBe(false)
    })

    test('下载器就绪：updateReady + 安装包路径（窗上展示下载位置）', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({ version: '0.2.0', phase: 'ready', filePath: 'C:\\u\\updates\\0.2.0\\x-setup.exe', percent: 100 }),
                view: view(),
                exists: () => true, // 假路径不存在，显式声明文件在（存在性回落见「被删」用例）
        })
        expect(status.active).toBe(false)
        expect(status.updateReady).toBe(true)
        expect(status.installerPath).toBe('C:\\u\\updates\\0.2.0\\x-setup.exe')
        expect(status.error).toBe('')
    })

    test('下载器失败：红字透传（弹窗不关了，失败必须可见）', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({ version: '0.2.0', phase: 'error', error: '发布资产里没有 Windows 安装包（HTTP 404）' }),
            view: view(),
        })
        expect(status.active).toBe(false)
        expect(status.error).toContain('404')
        expect(status.updateReady).toBe(false)
    })

    test('下载器空闲 + 磁盘有就绪安装包：呈安装态（进程重启后的再开窗场景）', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({}),
            view: view(),
            readyPath: 'C:\\u\\updates\\0.2.0\\x-setup.exe',
        })
        expect(status.updateReady).toBe(true)
        expect(status.installerPath).toBe('C:\\u\\updates\\0.2.0\\x-setup.exe')
        expect(status.version).toBe('0.2.0')
    })

    test('下载器空闲且无安装包：回落框架视图（mac/Linux 唯一链路）', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({}),
            view: view({ phase: 'downloading', progress: 77, updateReady: false }),
        })
        expect(status.active).toBe(true)
        expect(status.percent).toBe(77)
        expect(status.updateReady).toBe(false)
        expect(status.installerPath).toBe('')
    })

    test('框架视图的 updateReady 透传（mac 下载完可直接安装）', () => {
        const status = shellUpdateStatusOf({
            installer: installerStatus({}),
            view: view({ phase: 'ready', updateReady: true }),
        })
        expect(status.updateReady).toBe(true)
            expect(status.installerPath).toBe('')
    })

        test('内存就绪但安装包被删（exists=false）：不呈安装态，回落磁盘/框架（磁盘实际为准）', () => {
                const status = shellUpdateStatusOf({
                        installer: installerStatus({ version: '0.2.0', phase: 'ready', filePath: '/deleted/x-setup.exe' }),
                        view: view({ latest: '0.2.0' }),
                        exists: () => false,
                })
                expect(status.updateReady).toBe(false)
                expect(status.installerPath).toBe('')
        })
})
