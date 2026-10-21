// 统一日志内核的行为测试（#226 主缝的磁盘侧一半：只断言文件系统的最终状态，
// 不碰内部计数器；时间相关行为注入 now，不 sleep）。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLoggingKernel, resetLoggingKernelForTests } from '../src/bun/logging/kernel.ts'
import { exportLogRange, resolveRangePreset } from '../src/bun/logging/exporter.ts'
import { parseArchiveFileName } from '../src/shared/logging/archive-plan.ts'

let home = ''
const identityGzip = (data: Uint8Array): Uint8Array => data

beforeEach(() => {
    home = join(import.meta.dir, '.tmp-logging-kernel', String(Math.random()).slice(2))
    mkdirSync(home, { recursive: true })
    resetLoggingKernelForTests()
})

afterEach(() => {
    resetLoggingKernelForTests()
    rmSync(join(import.meta.dir, '.tmp-logging-kernel'), { recursive: true, force: true })
})

const fixedNow = () => new Date(2026, 9, 20, 12, 0, 0)

describe('级别过滤（Decision 2：严格语义、只控写盘）', () => {
    test('默认 info：debug 行不落盘，info/warn/error 落盘', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
            const sink = kernel.shellSink({})
            sink.line('常规行')
            sink.line('警告行', 'warn')
            sink.line('错误行', 'error')
            sink.line('调试行', 'debug')
        const content = readFileSync(kernel.files().shell, 'utf8')
            expect(content).toContain('[shell] [info] 常规行')
            expect(content).toContain('[shell] [warn] 警告行')
            expect(content).toContain('[shell] [error] 错误行')
            expect(content).not.toContain('[shell] [debug] 调试行')
    })

    test('热切换到 debug 后，低级别行立刻回到盘上（US13）', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        kernel.applySettings({ logLevel: 'debug' })
        const sink = kernel.shellSink({})
            sink.line('调试行', 'debug')
            expect(readFileSync(kernel.files().shell, 'utf8')).toContain('[shell] [debug] 调试行')
    })

        test('行首带本地时区时间戳（契约红线 A5/A6：沿用 grep 习惯）', () => {
                const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
                kernel.shellSink({}).line('hi')
                expect(readFileSync(kernel.files().shell, 'utf8')).toMatch(/^2026-10-20 12:00:00\.000 \[shell\] \[info\] hi\n$/)
        })


    test('页面行按四档过滤；log 映射为 info（Decision 2）', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
            kernel.writeWebviewLines(['[log] 控制台行'], 'info')
            // 页面行按消息的批级别过滤（service 一次 console 消息一批，同批同级别）
            kernel.writeWebviewLines(['[debug] 页面调试'], 'debug')
        const content = readFileSync(kernel.files().webview, 'utf8')
        expect(content).toContain('[log] 控制台行')
        expect(content).not.toContain('[debug] 页面调试')
    })
})

describe('轮转与归档（Decision 5：跨天 + 大小双触发；内容日命名）', () => {
    test('超 10MB 触发大小轮转：活跃文件截空、归档进 logs/archive/、名字带内容日', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        const sink = kernel.shellSink({})
        sink.write(`${'x'.repeat(11 * 1024 * 1024)}\n`)
            sink.line('触发轮转的一行')
        expect(readFileSync(kernel.files().shell, 'utf8')).not.toContain('x')
        expect(readFileSync(kernel.files().shell, 'utf8')).toContain('触发轮转的一行')
        const names = readdirSync(kernel.archiveDir)
        expect(names).toHaveLength(1)
        expect(parseArchiveFileName(names[0] ?? '')).toMatchObject({ stem: 'shell', day: '20261020', seq: 1 })
    })

    test('跨天首写轮转：归档名是**内容起始日**（前一日），不是轮转时刻（B2）', () => {
        let day = 19
        const kernel = createLoggingKernel({
            home,
            gzip: identityGzip,
            migrate: false,
            now: () => new Date(2026, 9, day, 8, 0, 0),
        })
        const sink = kernel.shellSink({})
            sink.line('10-19 的行')
        day = 20
            sink.line('10-20 的行')
        const names = readdirSync(kernel.archiveDir)
        expect(names).toEqual(['shell-20261019-01.log.gz'])
        // 内容日口径：这份归档解出来应该只有 10-19 的行
        const archived = readFileSync(join(kernel.archiveDir, names[0] ?? ''), 'utf8')
        expect(archived).toContain('10-19 的行')
        expect(archived).not.toContain('10-20 的行')
    })

    test('同一天第二次轮转，序号递增', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        const sink = kernel.shellSink({})
        sink.write(`${'a'.repeat(11 * 1024 * 1024)}\n`)
            sink.write(`${'b'.repeat(11 * 1024 * 1024)}\n`)
            sink.write(`${'c'.repeat(11 * 1024 * 1024)}\n`) // 第三次写入触发第二次轮转（轮转发生在写之前）
            const names = readdirSync(kernel.archiveDir).sort()
            expect(names).toEqual(['shell-20261020-01.log.gz', 'shell-20261020-02.log.gz'])
    })
})

describe('保留清理（Decision 11：只扫归档目录，天数只作用归档）', () => {
    test('applySettings 落地新阈值时立刻清一次，回执带份数与字节', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        // 手工造两份「过期」归档（命名即可，清理按名字解析内容日）
        mkdirSync(kernel.archiveDir, { recursive: true })
        writeFileSync(join(kernel.archiveDir, 'shell-20261001-01.log.gz'), 'old-1')
        writeFileSync(join(kernel.archiveDir, 'shell-20261019-01.log.gz'), 'new-1')
        const receipt = kernel.applySettings({ logRetentionDays: 3, logMaxTotalMb: 200 })
        expect(receipt).toEqual({ removedFiles: 1, bytesFreed: 5 })
        expect(existsSync(join(kernel.archiveDir, 'shell-20261001-01.log.gz'))).toBe(false)
        expect(existsSync(join(kernel.archiveDir, 'shell-20261019-01.log.gz'))).toBe(true)
    })

    test('阈值没变时 applySettings 不触发清理（回执 null）', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        kernel.applySettings({ logLevel: 'debug' })
        expect(kernel.applySettings({ logLevel: 'debug', logRetentionDays: 14, logMaxTotalMb: 200 })).toBeNull()
    })

    test('clear_logs：清空归档 + 截断三个活跃文件，回执计份数与字节（Decision 7）', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        mkdirSync(kernel.archiveDir, { recursive: true })
        writeFileSync(join(kernel.archiveDir, 'shell-20261019-01.log.gz'), '12345')
            kernel.shellSink({}).line('活跃内容')
        kernel.writeWebviewLines(['[log] 页面内容'], 'info')
        const receipt = kernel.clearLogs()
        expect(receipt.removedFiles).toBe(1)
            expect(receipt.bytesFreed).toBeGreaterThan(5) // 归档 5B + 活跃截断字节
        expect(readdirSync(kernel.archiveDir)).toHaveLength(0)
        expect(readFileSync(kernel.files().shell, 'utf8')).toBe('')
        expect(readFileSync(kernel.files().webview, 'utf8')).toBe('')
        // 截断后还能继续写（路径与句柄都不动）
            kernel.shellSink({}).line('清理后的一行')
        expect(readFileSync(kernel.files().shell, 'utf8')).toContain('清理后的一行')
    })
})

describe('IO 失败可感知（Decision 9：不再静默）', () => {
    test('写失败计入 health；shell 源自身的告警降级 stderr 不递归', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        // 把 shell 文件变成目录，制造 append 失败
        rmSync(kernel.files().shell, { force: true })
        mkdirSync(kernel.files().shell)
            kernel.shellSink({}).line('这一行会失败')
        expect(kernel.health().ioErrorCount).toBeGreaterThan(0)
        expect(kernel.health().lastIoError).not.toBeNull()
    })
})

describe('升级迁移（Decision 5：遗留 .log.N 一次性压进归档）', () => {
    test('shell.log.1 迁进归档目录并改名为归档命名', () => {
        writeFileSync(join(home, 'shell.log.1'), 'legacy content\n')
        writeFileSync(join(home, 'shell.log.2'), 'legacy two\n')
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip })
        const names = readdirSync(kernel.archiveDir).sort()
        expect(names).toHaveLength(2)
        expect(names[0]).toMatch(/^shell-\d{8}-0[12]\.log\.gz$/)
        expect(existsSync(join(home, 'shell.log.1'))).toBe(false)
    })
})

describe('导出（Decision 3：tar.gz 单包、归档按内容日、活跃文件分级处理）', () => {
    test('归档选份按内容日（from 多捞一天）+ shell 活跃按行首戳逐行 + webview 整文件近似', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        mkdirSync(kernel.archiveDir, { recursive: true })
        writeFileSync(join(kernel.archiveDir, 'shell-20261017-01.log.gz'), 'old-day')
        writeFileSync(join(kernel.archiveDir, 'shell-20261020-01.log.gz'), 'today')
            kernel.shellSink({}).line('今天的一行')
            kernel.writeWebviewLines(['[log] webview 近似行'], 'info')
            appendFileSync(kernel.files().relay, '2026-10-20T12:00:00.000 [relay] relay 行\n')
        // 上一行的戳是注入 now 的 2026-10-20；再造一行昨天内容的行——用自定义 now 写不进同一 sink，改从文件补
        const result = exportLogRange({
            kernel,
            destDir: join(home, 'export'),
            range: { from: '20261020', to: '20261020' },
            now: fixedNow(),
            gzip: identityGzip,
        })
        expect(result.approximations).toHaveLength(1)
        expect(result.approximations[0]).toContain('整文件近似')
        expect(result.archivesIncluded).toBe(1)
        expect(existsSync(result.path)).toBe(true)
        const tarball = readFileSync(result.path, 'utf8')
        expect(tarball).toContain('archive/shell-20261020-01.log.gz')
        expect(tarball).toContain('active/shell.log')
        expect(tarball).toContain('active/dsh-desktop-webview.log')
        expect(tarball).toContain('active/shell-relay.log')
        expect(tarball).toContain('manifest.json')
        // 10-17 的归档不该进包（from 前一天是 10-19，10-17 在界外）
        expect(tarball).not.toContain('shell-20261017-01.log.gz')
        // shell 活跃文件里只有今天的行（全部行都是今天写的）
        expect(tarball).toContain('今天的一行')
    })

    test('resolveRangePreset：today/7d/30d/all/custom（「今天」＝本地零点）', () => {
        const now = new Date(2026, 9, 20, 15, 0, 0)
        expect(resolveRangePreset('today', undefined, undefined, now)).toEqual({ from: '20261020', to: '20261020' })
        expect(resolveRangePreset('7d', undefined, undefined, now)).toEqual({ from: '20261014', to: '20261020' })
            expect(resolveRangePreset('30d', undefined, undefined, now)).toEqual({ from: '20260921', to: '20261020' })
        expect(resolveRangePreset('all', undefined, undefined, now)).toEqual({})
        expect(resolveRangePreset('custom', '2026-10-01', '2026-10-05', now)).toEqual({ from: '20261001', to: '20261005' })
        expect(() => resolveRangePreset('custom', undefined, undefined, now)).toThrow()
    })
})

describe('诊断快照字段（Decision 8）', () => {
    test('fileStat.rotated = 归档目录中该源的份数；archiveRows 带来源', () => {
        const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
        mkdirSync(kernel.archiveDir, { recursive: true })
        writeFileSync(join(kernel.archiveDir, 'shell-20261019-01.log.gz'), 'x')
            writeFileSync(join(kernel.archiveDir, 'dsh-desktop-webview-20261019-01.log.gz'), 'x')
        writeFileSync(join(kernel.archiveDir, 'shell-20261020-01.log.gz'), 'x')
        expect(kernel.fileStat('shell').rotated).toBe(2)
        expect(kernel.fileStat('webview').rotated).toBe(1)
        expect(kernel.fileStat('relay').rotated).toBe(0)
            expect(kernel.archiveRows().map((row) => row.source).sort()).toEqual(['shell', 'shell', 'webview'])
    })

        test('relay 壳侧写入（writeRelayLine）：级别过滤不作用 + 超限就地归档（Decision 10/11）', () => {
                const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
                kernel.applySettings({ logLevel: 'error' }) // 级别抬高也管不到 relay
                kernel.writeRelayLine(`${'r'.repeat(11 * 1024 * 1024)}\n`)
                kernel.writeRelayLine('2026-10-20T12:00:01.000 [relay] [info] 触发巡检的一行\n')
                expect(readdirSync(kernel.archiveDir)).toEqual(['shell-relay-20261020-01.log.gz'])
                expect(readFileSync(kernel.files().relay, 'utf8')).toContain('[relay] [info] 触发巡检的一行')
                expect(kernel.fileStat('relay').rotated).toBe(1)
        })
})

describe('模块 Logger（分级方法 + 结构化参数，调用时格式化）', () => {
        test('logger(source) 按级别方法写盘：[来源] [级别] 前缀 + %d/%o 结构化参数', () => {
                const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
                kernel.logger('proxy').warn('端口 %d 探测失败：%o', 8080, new Error('boom'))
                kernel.logger('shell').info('普通 %s', '文本')
                const content = readFileSync(kernel.files().shell, 'utf8')
                expect(content).toContain('[proxy] [warn] 端口 8080 探测失败：Error: boom')
                expect(content).toContain('[shell] [info] 普通 文本')
        })

        test('logger 受全局级别过滤与热切换作用（US13）', () => {
                const kernel = createLoggingKernel({ home, now: fixedNow, gzip: identityGzip, migrate: false })
                kernel.logger('x').debug('看不见')
                expect(existsSync(kernel.files().shell)).toBe(false)
                kernel.applySettings({ logLevel: 'debug' })
                kernel.logger('x').debug('看得见')
                expect(readFileSync(kernel.files().shell, 'utf8')).toContain('[x] [debug] 看得见')
        })
})
