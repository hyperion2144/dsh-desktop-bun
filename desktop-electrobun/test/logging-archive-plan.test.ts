// 归档命名 / 保留计划 / 导出选份的纯逻辑测试（缝 ②，零 IO）。
import { describe, expect, test } from 'bun:test'
import {
    ARCHIVE_DIR_NAME,
    archiveFileName,
    localDayKey,
    offsetDayKey,
    parseArchiveFileName,
    parseIsoLineDay,
    parseLineDay,
    pickArchivesForRange,
    retentionPlan,
} from '../src/shared/logging/archive-plan.ts'

const row = (name: string, day: string, seq: number, bytes: number) => ({ name, day, seq, bytes })

describe('归档命名（Decision 5：内容起始日 + 当日序号）', () => {
    test('拼装与解析互逆；非归档名解析为 null', () => {
        const name = archiveFileName('shell', '20261020', 1)
        expect(name).toBe('shell-20261020-01.log.gz')
        const parsed = parseArchiveFileName(name)
        expect(parsed).toEqual({ stem: 'shell', day: '20261020', seq: 1 })
        expect(parseArchiveFileName('shell.log')).toBeNull()
        expect(parseArchiveFileName('random.gz')).toBeNull()
        expect(parseArchiveFileName('dsh-plugin-20261020-01.log.gz')?.stem).toBe('dsh-plugin')
    })

    test('ARCHIVE_DIR_NAME 恒为 archive（非 per-profile，Decision 4）', () => {
        expect(ARCHIVE_DIR_NAME).toBe('archive')
    })
})

describe('日键工具（本地时区，「今天」＝本地零点）', () => {
        test('localDayKey 用本地年月日（本地构造的 Date 与日键一致，跨月/跨年都稳）', () => {
                expect(localDayKey(new Date(2026, 9, 20))).toBe('20261020')
                expect(localDayKey(new Date(2026, 0, 1))).toBe('20260101')
                expect(localDayKey(new Date(2026, 11, 31))).toBe('20261231')
        })

    test('offsetDayKey 跨月/跨年都要对', () => {
        expect(offsetDayKey('20261001', -1)).toBe('20260930')
        expect(offsetDayKey('20260101', -1)).toBe('20251231')
        expect(offsetDayKey('20261020', 0)).toBe('20261020')
    })

    test('parseLineDay 认壳行首本地戳；parseIsoLineDay 认 relay 的 ISO 戳', () => {
            expect(parseLineDay('2026-10-20 23:59:59.123 [shell] [info] hi')).toBe('20261020')
        expect(parseLineDay('没有戳的行')).toBeNull()
        expect(parseIsoLineDay('2026-10-20T12:34:56.789Z [relay] ok')).toBe('20261020')
        expect(parseIsoLineDay('no stamp')).toBeNull()
    })
})

describe('保留计划（Decision 11：天数只作用归档，总量含活跃，先删最旧）', () => {
    const now = new Date(2026, 9, 20, 12, 0, 0) // 本地 2026-10-20

    test('过期的归档进 delete，活跃字节只参与总量', () => {
        const plan = retentionPlan({
            archives: [row('a-20261001-01.log.gz', '20261001', 1, 100), row('a-20261020-01.log.gz', '20261020', 1, 100)],
            activeBytes: 50,
            maxDays: 14,
            maxTotalBytes: 1000,
            now,
        })
        // 10-01 距今 19 天 > 14 天保留期；10-20 在期内
        expect(plan.delete).toEqual(['a-20261001-01.log.gz'])
        expect(plan.keep).toEqual(['a-20261020-01.log.gz'])
    })

    test('总量超限从最旧（day、seq 升序）删起，直到归档+活跃 ≤ 上限', () => {
        const plan = retentionPlan({
            archives: [
                row('a-20261018-01.log.gz', '20261018', 1, 300),
                row('a-20261019-01.log.gz', '20261019', 1, 300),
                row('a-20261019-02.log.gz', '20261019', 2, 300),
            ],
            activeBytes: 100,
            maxDays: 14,
            maxTotalBytes: 700,
            now,
        })
        // 总量 1000 > 700：先删 10-18-01（600），仍 700 > 700？不，600+100=700 ≤ 700 停
        expect(plan.delete).toEqual(['a-20261018-01.log.gz'])
        expect(plan.keep).toEqual(['a-20261019-01.log.gz', 'a-20261019-02.log.gz'])
    })

    test('同日内按 seq 先删 01 再删 02', () => {
        const plan = retentionPlan({
            archives: [row('a-20261019-01.log.gz', '20261019', 1, 300), row('a-20261019-02.log.gz', '20261019', 2, 300)],
            activeBytes: 0,
            maxDays: 14,
            maxTotalBytes: 400,
            now,
        })
        expect(plan.delete).toEqual(['a-20261019-01.log.gz'])
    })
})

describe('导出选份（Decision 3：按内容日整体进出，from 向前多捞 1 天）', () => {
    const archives = [
        row('s-20261017-01.log.gz', '20261017', 1, 10),
        row('s-20261018-01.log.gz', '20261018', 1, 10),
        row('s-20261019-01.log.gz', '20261019', 1, 10),
    ]

    test('无界 = 全部（「全部」预设）', () => {
        expect(pickArchivesForRange(archives, {})).toHaveLength(3)
    })

    test('from=20261018 会带上 10-17（多捞一天兜跨天轮转的边界）', () => {
        const picked = pickArchivesForRange(archives, { from: '20261018' })
        expect(picked.map((entry) => entry.day)).toEqual(['20261017', '20261018', '20261019'])
    })

    test('to 端不含多捞，双端都设时是闭区间+from 前一天', () => {
        const picked = pickArchivesForRange(archives, { from: '20261018', to: '20261019' })
        expect(picked.map((entry) => entry.day)).toEqual(['20261017', '20261018', '20261019'])
        const narrower = pickArchivesForRange(archives, { from: '20261019', to: '20261019' })
        expect(narrower.map((entry) => entry.day)).toEqual(['20261018', '20261019'])
    })
})
