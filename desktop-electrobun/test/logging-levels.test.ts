// 共享日志纯逻辑的分级词表测试（缝 ②：不碰磁盘，直接断言函数）。
import { describe, expect, test } from 'bun:test'
import {
        DEFAULT_LOG_LEVEL,
        LEVEL_TAGS,
        LOG_LEVEL_RANK,
        formatMessage,
        hostStreamLogLevel,
        normalizeLogLevel,
        pageLevelToLogLevel,
        serializeLogValue,
        shouldLog,
} from '../src/shared/logging/levels.ts'

describe('日志级别词表', () => {
    test('normalizeLogLevel：白名单四档，其余回默认 info', () => {
        expect(normalizeLogLevel('debug')).toBe('debug')
        expect(normalizeLogLevel('INFO')).toBe('info')
        expect(normalizeLogLevel('warn')).toBe('warn')
        expect(normalizeLogLevel('error')).toBe('error')
        expect(normalizeLogLevel('verbose')).toBeUndefined()
        expect(normalizeLogLevel(42)).toBeUndefined()
        expect(normalizeLogLevel(undefined)).toBeUndefined()
        expect(DEFAULT_LOG_LEVEL).toBe('info')
    })

    test('shouldLog：严格语义，级别抬高后低级别行退出落盘', () => {
        expect(shouldLog('debug', 'info')).toBe(false)
        expect(shouldLog('info', 'info')).toBe(true)
        expect(shouldLog('warn', 'info')).toBe(true)
        expect(shouldLog('error', 'info')).toBe(true)
        expect(shouldLog('info', 'debug')).toBe(true)
    })

    test('LOG_LEVEL_RANK：debug < info < warn < error', () => {
        expect(LOG_LEVEL_RANK.debug).toBeLessThan(LOG_LEVEL_RANK.info)
        expect(LOG_LEVEL_RANK.info).toBeLessThan(LOG_LEVEL_RANK.warn)
        expect(LOG_LEVEL_RANK.warn).toBeLessThan(LOG_LEVEL_RANK.error)
    })

    test('页面五档映射：log→info，其余同名（#224 Decision 2）', () => {
        expect(pageLevelToLogLevel('log')).toBe('info')
        expect(pageLevelToLogLevel('debug')).toBe('debug')
        expect(pageLevelToLogLevel('info')).toBe('info')
        expect(pageLevelToLogLevel('warn')).toBe('warn')
        expect(pageLevelToLogLevel('error')).toBe('error')
    })

    test('宿主按流二分：stderr⇒error、stdout⇒info（Decision 2，不做关键字启发式）', () => {
        expect(hostStreamLogLevel('stderr')).toBe('error')
        expect(hostStreamLogLevel('stdout')).toBe('info')
    })

        describe('formatMessage（结构化参数，调用时格式化）', () => {
                test('无参数原样返回；占位符 %s/%d/%i/%f/%o', () => {
                        expect(formatMessage('普通消息', [])).toBe('普通消息')
                        expect(formatMessage('端口 %d 探测失败', [8080])).toBe('端口 8080 探测失败')
                        expect(formatMessage('%s = %i', ['x', 7])).toBe('x = 7')
                        expect(formatMessage('占比 %f%%', [0.25])).toBe('占比 0.25%')
                        expect(formatMessage('负载 %o', [{ a: 1 }])).toBe('负载 { a: 1 }')
                })

                test('%% 字面量；占位符耗尽后多余参数空格追加', () => {
                        expect(formatMessage('100%% %s', ['ok'])).toBe('100% ok')
                        expect(formatMessage('消息', ['额外', 42])).toBe('消息 额外 42')
                })
        })

        describe('serializeLogValue（Error/对象/防环）', () => {
                test('标量原样、Error→Name: message、数组/对象单行展开', () => {
                        expect(serializeLogValue('文本')).toBe('文本')
                        expect(serializeLogValue(42)).toBe('42')
                        expect(serializeLogValue(null)).toBe('null')
                        expect(serializeLogValue(undefined)).toBe('undefined')
                        expect(serializeLogValue(new TypeError('坏了'))).toBe('TypeError: 坏了')
                        expect(serializeLogValue([1, 'a'])).toBe('[1, a]')
                        expect(serializeLogValue({ a: 1, b: 'x' })).toBe('{ a: 1, b: x }')
                        expect(serializeLogValue(new Map([['k', 1]]))).toBe('{ k: 1 }')
                        expect(serializeLogValue(new Date(0))).toBe('1970-01-01T00:00:00.000Z')
                })

                test('循环引用不炸', () => {
                        const cyclic: Record<string, unknown> = {}
                        cyclic.self = cyclic
                        expect(formatMessage('%o', [cyclic])).toBe('{ self: [Circular] }')
                })
        })

        describe('LEVEL_TAGS（四档字面量标签）', () => {
                test('debug/info/warn/error', () => {
                        expect(LEVEL_TAGS.debug).toBe('[debug]')
                        expect(LEVEL_TAGS.info).toBe('[info]')
                        expect(LEVEL_TAGS.warn).toBe('[warn]')
                        expect(LEVEL_TAGS.error).toBe('[error]')
                })
        })
})
