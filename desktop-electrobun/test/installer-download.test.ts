// 安装包下载器（#235）的纯逻辑测试：假 fetch + 真临时目录，全链路跑通
// 「下载 → .part → 转正 → findReady」，以及单飞/取消/404/截断四条失败路。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
        INSTALLER_DIR_ENV,
        INSTALLER_ASSETS,
        createInstallerDownloader,
        installerFilePath,
        installerRootDir,
        installerUrl,
} from '../src/bun/platform/installer-download.ts'
import { collectingLogger, silentLogger } from './helpers/test-logger.ts'

function tempRoot(): string {
        return mkdtempSync(join(tmpdir(), 'installer-download-test-'))
}

function envWith(root: string): Record<string, string | undefined> {
        return { [INSTALLER_DIR_ENV]: root }
}

/** 把一段文本变成带 content-length 的流式 Response。 */
function streamResponse(chunks: string[], total?: number): Response {
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
                start(controller) {
                        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
                        controller.close()
                },
        })
        return new Response(body, {
                status: 200,
                headers: { 'content-length': String(total ?? chunks.join('').length) },
        })
}

describe('安装包资产名与 URL', () => {
        test('资产名：三平台齐全，win 名与产物历史名一致', () => {
                expect(INSTALLER_ASSETS.win32?.startsWith('windows-x64-')).toBe(true)
                expect(INSTALLER_ASSETS.win32?.endsWith('-setup.exe')).toBe(true)
                expect(INSTALLER_ASSETS.darwin).toBe('macos-arm64-DeepSeekHarnessDesktopBUN.dmg')
                expect(INSTALLER_ASSETS.linux).toBe('linux-x64-DeepSeekHarnessDesktopBUN-Setup.tar.gz')
        })

        test('URL 拼接：尾斜杠可有可无，空 baseUrl 给空串', () => {
                expect(installerUrl('https://example.com/rel', 'win32')).toBe(
                        `https://example.com/rel/${INSTALLER_ASSETS.win32}`,
                )
                expect(installerUrl('https://example.com/rel/', 'darwin')).toBe(
                        `https://example.com/rel/${INSTALLER_ASSETS.darwin}`,
                )
                expect(installerUrl('')).toBe('')
        })

        test('目录：显式覆盖优先；win=LOCALAPPDATA、mac=~/Library/Caches、linux=XDG_CACHE_HOME', () => {
                expect(installerRootDir({ [INSTALLER_DIR_ENV]: '/tmp/x' }, 'win32')).toBe('/tmp/x')
                expect(installerRootDir({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32')).toBe(
                        join('C:\\Users\\u\\AppData\\Local', 'DSHDesktopBun', 'updates'),
                )
                expect(installerRootDir({ HOME: '/Users/u' }, 'darwin')).toBe(
                        join('/Users/u', 'Library', 'Caches', 'DSHDesktopBun', 'updates'),
                )
                expect(installerRootDir({ XDG_CACHE_HOME: '/xdg' }, 'linux')).toBe(
                        join('/xdg', 'DSHDesktopBun', 'updates'),
                )
                expect(installerRootDir({ HOME: '/home/u' }, 'linux')).toBe(
                        join('/home/u', '.cache', 'DSHDesktopBun', 'updates'),
                )
                expect(installerRootDir({}, 'win32')).toBe('')
        })

        test('落点：<root>/<version>/<asset>；空 version 给空串', () => {
                expect(installerFilePath('/r', '0.2.0', 'win32')).toBe(join('/r', '0.2.0', INSTALLER_ASSETS.win32 ?? ''))
                expect(installerFilePath('/r', '0.2.0', 'darwin')).toBe(join('/r', '0.2.0', INSTALLER_ASSETS.darwin ?? ''))
                expect(installerFilePath('/r', '')).toBe('')
        })
})

describe('createInstallerDownloader（win32）', () => {
        test('下载成功：.part 转正、status ready、findReady 命中、进度 100', async () => {
                const root = tempRoot()
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async () => streamResponse(['hello ', 'installer']),
                })
                await downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })
                const file = installerFilePath(root, '0.2.0', 'win32')
                expect(existsSync(file)).toBe(true)
                expect(existsSync(`${file}.part`)).toBe(false)
                const status = downloader.status()
                expect(status.phase).toBe('ready')
                expect(status.active).toBe(false)
                expect(status.filePath).toBe(file)
                expect(status.percent).toBe(100)
                expect(status.bytesDownloaded).toBe('hello installer'.length)
                expect(downloader.findReady('0.2.0')).toBe(file)
                expect(downloader.findReady('0.1.0')).toBe('')
        })

        test('已就绪再 start：幂等返回，不发网络请求', async () => {
                const root = tempRoot()
                let calls = 0
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async () => {
                                calls += 1
                                return streamResponse(['data'])
                        },
                })
                await downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })
                await downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })
                expect(calls).toBe(1)
                expect(downloader.status().phase).toBe('ready')
        })

        test('单飞：任务进行中再 start 抛「已有任务」', async () => {
                const root = tempRoot()
                let release!: () => void
                const gate = new Promise<void>((resolve) => {
                        release = resolve
                })
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async () => {
                                await gate
                                return streamResponse(['late'])
                        },
                })
                const running = downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })
                await Promise.resolve()
                expect(downloader.status().active).toBe(true)
                await expect(downloader.start({ baseUrl: 'https://example.com/rel', version: '0.3.0' })).rejects.toThrow(
                        '已有安装包下载任务在进行中',
                )
                release()
                await running
                expect(downloader.status().phase).toBe('ready')
        })

        test('404：报「发布资产里没有安装包」，status error', async () => {
                const root = tempRoot()
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async () => new Response('not found', { status: 404 }),
                })
                await expect(downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })).rejects.toThrow(
                        '发布资产里没有安装包',
                )
                expect(downloader.status().phase).toBe('error')
                expect(downloader.status().error).toContain('404')
        })

        test('截断：content-length 对不上不许转正', async () => {
                const root = tempRoot()
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async () => streamResponse(['short'], 9999),
                })
                await expect(downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })).rejects.toThrow(
                        '安装包下载不完整',
                )
                const file = installerFilePath(root, '0.2.0', 'win32')
                expect(existsSync(file)).toBe(false)
                expect(existsSync(`${file}.part`)).toBe(false)
                expect(downloader.status().phase).toBe('error')
        })

        test('取消：独立终态 cancelled，不是失败', async () => {
                const root = tempRoot()
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async (_url, init) => {
                                // abort 必须真的打断等待：reject 让实现落 cancelled 终态（真 fetch 的行为）
                                await new Promise<void>((resolve, reject) => {
                                        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')))
                                        setTimeout(resolve, 50)
                                })
                                return streamResponse(['never'])
                        },
                })
                const running = downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })
                await Promise.resolve()
                const cancelled = await downloader.cancel()
                expect(cancelled.cancelled).toBe(true)
                await running
                const status = downloader.status()
                expect(status.phase).toBe('cancelled')
                expect(status.cancelled).toBe(true)
                expect(status.active).toBe(false)
        })

        test('launch：detached 起就绪的安装包；没就绪抛错', async () => {
                const root = tempRoot()
                const spawned: Array<{ file: string; opts: unknown }> = []
                const downloader = createInstallerDownloader({
                        log: collectingLogger([]),
                        env: envWith(root),
                        os: 'win32',
                        fetchFn: async () => streamResponse(['data']),
                        spawnFn: ((file: string, args: readonly string[], opts: unknown) => {
                                spawned.push({ file, opts })
                                return { unref() { } } as never
                        }) as never,
                })
                expect(downloader.launch()).rejects.toThrow('安装包还没下载完成')
                await downloader.start({ baseUrl: 'https://example.com/rel', version: '0.2.0' })
                await downloader.launch()
                expect(spawned).toHaveLength(1)
                expect(spawned[0]?.file).toBe(installerFilePath(root, '0.2.0', 'win32'))

                // #235 对抗式补丁：壳重启后内存态已丢，applyShell 从磁盘 findReady 拿路径传进来也要能启动。
                const restartedPath = installerFilePath(root, '0.9.9', 'win32')
                mkdirSync(join(restartedPath, '..'), { recursive: true })
                writeFileSync(restartedPath, 'installer')
                spawned.length = 0
                await downloader.launch(restartedPath)
                expect(spawned[0]?.file).toBe(restartedPath)
        })
})

describe('launch 平台分叉（三平台都有实质行为）', () => {
        test('mac：open 挂载 DMG', async () => {
                const root = tempRoot()
                const spawned: Array<{ file: string; args: readonly string[] }> = []
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'darwin',
                        spawnFn: ((file: string, args: readonly string[], _opts: unknown) => {
                                spawned.push({ file, args })
                                return { unref() { } } as never
                        }) as never,
                })
                const dmg = installerFilePath(root, '0.2.0', 'darwin')
                mkdirSync(join(dmg, '..'), { recursive: true })
                writeFileSync(dmg, 'dmg')
                await downloader.launch(dmg)
                expect(spawned).toEqual([{ file: 'open', args: [dmg] }])
        })

        test('linux：xdg-open 打开所在文件夹（tar.gz 没有安装器）', async () => {
                const root = tempRoot()
                const spawned: Array<{ file: string; args: readonly string[] }> = []
                const downloader = createInstallerDownloader({
                        log: silentLogger,
                        env: envWith(root),
                        os: 'linux',
                        spawnFn: ((file: string, args: readonly string[], _opts: unknown) => {
                                spawned.push({ file, args })
                                return { unref() { } } as never
                        }) as never,
                })
                const tgz = installerFilePath(root, '0.2.0', 'linux')
                mkdirSync(join(tgz, '..'), { recursive: true })
                writeFileSync(tgz, 'tgz')
                await downloader.launch(tgz)
                expect(spawned[0]?.file).toBe('xdg-open')
                expect(spawned[0]?.args[0]).toBe(join(tgz, '..'))
        })

        test('mac 上 findReady 照常工作（下载器行为与平台无关，只有 launch 分叉）', () => {
                const root = tempRoot()
                const downloader = createInstallerDownloader({ log: silentLogger, env: envWith(root), os: 'darwin' })
                expect(downloader.findReady('0.2.0')).toBe('')
        })
})

describe('残留 .part 清理', () => {
        test('上次中断留下的 .part 不影响 findReady（正式名才算就绪）', () => {
                const root = tempRoot()
                const file = installerFilePath(root, '0.2.0', 'win32')
                mkdirSync(join(file, '..'), { recursive: true })
                writeFileSync(`${file}.part`, 'half')
                const downloader = createInstallerDownloader({ log: silentLogger, env: envWith(root), os: 'win32' })
                expect(downloader.findReady('0.2.0')).toBe('')
                expect(existsSync(`${file}.part`)).toBe(true)
        })
})
